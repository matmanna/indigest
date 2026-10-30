import type { DB } from "../db";
import * as q from "../db/queries";

// Deleted messages keep their content in the database but are hidden from
// every read (see notDeleted in src/db/queries.ts). Slack tells us about a
// deletion in two ways: a message_deleted event, and by no longer returning
// the message from conversations.replies. Events can be missed, so both paths
// feed the same markMessageDeleted.

/** The part of a Slack `message` event with subtype message_deleted we use. */
export interface MessageDeletedEvent {
  channel?: string;
  deleted_ts?: string;
}

/** Tombstones the message a message_deleted event names. */
export async function handleMessageDeleted(
  db: DB,
  ev: MessageDeletedEvent,
): Promise<boolean> {
  if (!ev.channel || !ev.deleted_ts) return false;
  return q.markMessageDeleted(db, ev.channel, ev.deleted_ts);
}

interface SlackReply {
  ts?: string;
  subtype?: string;
  text?: string;
  edited?: { ts?: string };
}

/** Turns a Slack reply into the text and mrkdwn indigest stores for it. */
export type RenderReply = (message: SlackReply) => {
  text: string;
  formattedText: string | null;
};

/** The slice of @slack/web-api's WebClient that reconcile needs. */
export interface RepliesClient {
  conversations: {
    replies(args: {
      channel: string;
      ts: string;
      cursor?: string;
      limit?: number;
    }): Promise<{
      messages?: SlackReply[];
      response_metadata?: { next_cursor?: string };
    }>;
  };
}

const MAX_PAGES = 50;

export interface ReconcileResult {
  /** Timestamps newly marked deleted. */
  deleted: string[];
  /** Timestamps of replies whose edited text was brought up to date. */
  edited: string[];
  /** False when Slack's answer was not trustworthy, so nothing was marked. */
  complete: boolean;
}

/**
 * Marks stored messages in a thread deleted when Slack no longer returns them.
 * Only acts on a complete, successful fetch: an API error, an exhausted page
 * budget or an empty answer marks nothing, because wrongly hiding a live
 * comment is worse than showing a deleted one for a while longer.
 */
export async function reconcileThreadDeletions(
  db: DB,
  slack: RepliesClient,
  channelId: string,
  threadTs: string,
  render?: RenderReply,
): Promise<ReconcileResult> {
  const stored = await q.getLiveThreadTimestamps(db, channelId, threadTs);
  if (stored.length === 0) return { deleted: [], edited: [], complete: true };

  const present = new Set<string>();
  const seen = new Map<string, SlackReply>();
  let cursor: string | undefined;
  let pages = 0;
  try {
    do {
      if (++pages > MAX_PAGES) return { deleted: [], edited: [], complete: false };
      const page = await slack.conversations.replies({
        channel: channelId,
        ts: threadTs,
        cursor,
        limit: 200,
      });
      for (const message of page.messages ?? []) {
        // Slack leaves a placeholder for a deleted root that still has replies.
        if (message.ts && message.subtype !== "tombstone") {
          present.add(message.ts);
          seen.set(message.ts, message);
        }
      }
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
  } catch (error) {
    // The root is gone. Replies it had are left to their own events, since we
    // cannot tell here whether Slack still keeps them.
    if ((error as { data?: { error?: string } })?.data?.error === "thread_not_found") {
      const marked = await q.markMessageDeleted(db, channelId, threadTs);
      return { deleted: marked ? [threadTs] : [], edited: [], complete: true };
    }
    return { deleted: [], edited: [], complete: false };
  }

  // A thread always contains at least its root.
  if (present.size === 0) return { deleted: [], edited: [], complete: false };

  const deleted: string[] = [];
  for (const ts of stored) {
    if (present.has(ts)) continue;
    if (await q.markMessageDeleted(db, channelId, ts)) deleted.push(ts);
  }

  // Edits whose events were missed.
  const edited: string[] = [];
  if (render) {
    const storedText = new Map(
      (await q.getLiveReplyText(db, channelId, threadTs)).map((r) => [r.slackTs, r.text]),
    );
    for (const [ts, message] of seen) {
      if (ts === threadTs || !message.edited) continue;
      const current = storedText.get(ts);
      if (current === undefined) continue;
      const next = render(message);
      if (next.text === current) continue;
      const updated = await q.updateReplyContent(db, channelId, ts, {
        ...next,
        editedAt: new Date(Number(message.edited.ts ?? Date.now() / 1000) * 1000),
      });
      if (updated) edited.push(ts);
    }
  }
  return { deleted, edited, complete: true };
}
