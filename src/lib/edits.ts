import type { DB } from "../db";
import * as q from "../db/queries";

/** The part of a Slack `message_changed` event's message we use. */
export interface EditedMessage {
  ts?: string;
  thread_ts?: string;
  subtype?: string;
  edited?: { ts?: string };
}

/**
 * Whether a message_changed event is a user edit of a thread reply. Slack
 * sends the same event for link unfurls and similar, which carry no `edited`;
 * and for the root of a thread, which is not a comment.
 */
export function isReplyEdit(message: EditedMessage | undefined): boolean {
  return (
    !!message?.ts &&
    !!message.thread_ts &&
    message.ts !== message.thread_ts &&
    !message.subtype &&
    !!message.edited
  );
}

/**
 * Applies an edit to the stored reply, and notes when. A reply that was
 * deleted, or never stored, is left alone.
 */
export async function handleReplyEdited(
  db: DB,
  edit: {
    channel: string;
    ts: string;
    text: string;
    formattedText: string | null;
    editedTs?: string;
  },
): Promise<boolean> {
  const editedAt = edit.editedTs
    ? new Date(Number(edit.editedTs) * 1000)
    : new Date();
  return q.updateReplyContent(db, edit.channel, edit.ts, {
    text: edit.text,
    formattedText: edit.formattedText,
    editedAt,
  });
}
