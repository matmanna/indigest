/**
 * Rebuild a subscriber forward from the stored full text.
 *
 * Finds the pub bot action for (subscriberChannel, botMessageTs), loads the
 * source message from the DB, and re-runs the production forward path
 * (forwardToSubscribers), which chat.updates the existing forward in place
 * with the stored text instead of whatever the source currently says in
 * Slack. Used to repair forwards that were built from a post-edit shrunk
 * source (e.g. the Sticky announcement forward in #news).
 *
 * Usage:
 *   DATABASE_URL=... SLACK_BOT_TOKEN=... bun run src/cli/refix-forward.ts \
 *     '#news' '1790096870.681569' [--from-live]
 *
 * `--from-live` re-fetches the source from Slack, re-extracts its text (e.g.
 * after a fix to rich_text extraction) and overwrites the stored text, so the
 * rebuild isn't defeated by a corrupted-but-longer stored copy.
 *
 * In-place — does not delete or re-post anything except updating the exact
 * forward message(s) for that source in every subscriber channel.
 */
import { WebClient } from "@slack/web-api";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db";
import * as q from "../db/queries";
import * as schema from "../db/schema";
import {
  forwardToSubscribers,
  extractMessageText,
  resolveSlackMrkdwn,
  resolveMessageTimestamp,
  resolveStoredAuthors,
} from "../app";

function usageAndExit(msg: string): never {
  console.error(msg);
  console.error(
    "Usage: bun run src/cli/refix-forward.ts  <subscriber #channel>  <botMessageTs>",
  );
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveChannel(
  slack: WebClient,
  db: Awaited<ReturnType<typeof getDb>>,
  token: string,
): Promise<{ id: string; name: string }> {
  const raw = token.replace(/^#/, "").trim();

  if (/^[CGD][A-Z0-9]{7,}$/.test(raw)) {
    try {
      const info = await slack.conversations.info({ channel: raw });
      return { id: raw, name: (info.channel as any)?.name || raw };
    } catch {
      return { id: raw, name: raw };
    }
  }

  const known = await q.listChannels(db);
  const dbMatch = known.find((c) => c.name.toLowerCase() === raw.toLowerCase());
  if (dbMatch) return { id: dbMatch.id, name: dbMatch.name };

  let cursor: string | undefined;
  do {
    const resp = await slack.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: false,
      limit: 200,
      cursor,
    });
    const found = (resp.channels as any[] | undefined)?.find(
      (c) => c?.name?.toLowerCase() === raw.toLowerCase(),
    );
    if (found) return { id: found.id, name: found.name };
    cursor = resp.response_metadata?.next_cursor || undefined;
  } while (cursor);

  usageAndExit(`channel not found: #${raw}`);
}

async function main(): Promise<void> {
  const subscriberToken = process.argv[2];
  const botMessageTs = process.argv[3];
  const fromLive = process.argv[4] === "--from-live";
  if (!subscriberToken || !botMessageTs) {
    usageAndExit("subscriber channel and botMessageTs are required");
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) usageAndExit("DATABASE_URL is required");
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) usageAndExit("SLACK_BOT_TOKEN is required");

  const slack = new WebClient(botToken);
  const db = getDb(databaseUrl);

  const sub = await resolveChannel(slack, db, subscriberToken);

  const matches = await db
    .select()
    .from(schema.botActions)
    .where(
      and(
        eq(schema.botActions.botChannelId, sub.id),
        eq(schema.botActions.botMessageTs, botMessageTs),
      ),
    )
    .limit(10);
  const pub = matches.find((a) => a.type === "pub");
  if (!pub) {
    console.error(
      `no pub action found for #${sub.name} (${sub.id}) with botMessageTs=${botMessageTs}`,
    );
    process.exit(1);
  }

  console.log("source channel:", pub.sourceChannelId);
  console.log("subscriber:", `#${sub.name}`, sub.id);
  console.log("forward botMessageTs:", pub.botMessageTs);

  let msg = await q.getMessageBySlackTs(db, pub.sourceChannelId, pub.sourceMessageTs);

  if (fromLive) {
    if (!msg) {
      console.error(
        `--from-live needs a stored message for source ${pub.sourceChannelId}/${pub.sourceMessageTs}`,
      );
      process.exit(1);
    }
    const live = await slack.conversations.history({
      channel: pub.sourceChannelId,
      latest: pub.sourceMessageTs,
      limit: 1,
      inclusive: true,
    });
    const liveMsg = live.messages?.[0] as any;
    if (!liveMsg) {
      console.error(`could not re-fetch source ${pub.sourceMessageTs}`);
      process.exit(1);
    }
    const rawText = extractMessageText(liveMsg);
    const text = resolveSlackMrkdwn(rawText);
    const timestamp = resolveMessageTimestamp(
      liveMsg,
      pub.sourceMessageTs,
      msg.timestamp,
    );
    const authors = resolveStoredAuthors(
      liveMsg,
      liveMsg.user || "",
      msg.userName,
    );
    await q.upsertMessage(db, {
      slackTs: pub.sourceMessageTs,
      channelId: pub.sourceChannelId,
      userId: authors.userId,
      userName: authors.userName,
      text,
      timestamp,
      metadata: msg.metadata ?? {},
    });
    msg = {
      ...msg,
      userId: authors.userId,
      userName: authors.userName,
      text,
      rawText,
      timestamp,
    };
    console.log(`re-extracted from Slack: ${text.length} chars`);
  } else if (!msg) {
    console.error(
      `no stored message for source ${pub.sourceChannelId}/${pub.sourceMessageTs}`,
    );
    process.exit(1);
  }

  const ch = await q.getChannel(db, pub.sourceChannelId);
  if (!ch) {
    console.error(`no channel config for ${pub.sourceChannelId}`);
    process.exit(1);
  }

  console.log(
    `forwarding text: ${msg.text.length} chars (slackTs=${msg.slackTs})`,
  );

  await forwardToSubscribers(msg, ch, db, slack);

  const verify = await slack.conversations.history({
    channel: sub.id,
    latest: botMessageTs,
    limit: 1,
    inclusive: true,
  });
  const final = verify.messages?.[0] as any;
  const blockText = final?.blocks?.[0]?.text?.text || final?.text || "";
  console.log(
    `forward now: ${blockText.length} chars` +
      (final?.text ? ` (text field: ${final.text.length} chars)` : ""),
  );

  await sleep(500);
  process.exit(0);
}

main().catch((err: any) => {
  console.error("refix-forward failed:", err?.data || err?.message || err);
  process.exit(1);
});