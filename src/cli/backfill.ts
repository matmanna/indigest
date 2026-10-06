/**
 * Backfill a channel's message history into the `messages` table.
 *
 * Usage:
 *   bun run backfill '#channel' ['@user'] ['YYYY-MM-DD'] ['YYYY-MM-DD']
 *
 * Args (all positional, all but the channel optional):
 *   channel     '#name' or a raw channel ID (e.g. C0123ABCXYZ)
 *   user        '@name' or a raw user/bot ID - only messages from this
 *               author are stored (matched against both the message's user
 *               and bot_id, so a bot's own ID works too)
 *   start date  the floor: don't fetch anything older than this day. If
 *               only one date is given, it's always this one - "give me
 *               everything from this day forward" is the useful default for
 *               a lone date.
 *   end date    if given, fetch starts from the end of this day instead of
 *               resuming from the oldest message already stored for the
 *               channel. Without it, backfilling resumes wherever the last
 *               run (or live ingestion) left off, and walks backward to the
 *               start date, or the true beginning of the channel if no
 *               start date is given either.
 *
 * Paginates conversations.history oldest-first (paging backward from the
 * resume point), storing each page before moving on, so it's safe to
 * interrupt and re-run. Respects @slack/web-api's built-in rate-limit
 * backoff (it pauses and retries on 429 using Slack's Retry-After header)
 * plus a small courtesy delay between pages - see BACKFILL_DELAY_MS below.
 * This can take a very long time for a large channel/date range; that's
 * expected, just let it run.
 */
import { WebClient } from "@slack/web-api";
import { getDb } from "../db";
import * as q from "../db/queries";
import {
  resolveSlackMrkdwn,
  extractMessageText,
  resolveMessageTimestamp,
  resolveStoredAuthors,
} from "../app";

const PAGE_SIZE = 200;
const DELAY_MS = Number(process.env.BACKFILL_DELAY_MS) || 1000;

// Administrative/system subtypes with no real conversational content - skip these.
const EXCLUDED_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "channel_convert_to_private",
  "channel_convert_to_public",
  "group_join",
  "group_leave",
  "group_topic",
  "group_purpose",
  "group_archive",
  "group_unarchive",
  "bot_add",
  "bot_remove",
  "bot_enable",
  "bot_disable",
  "pinned_item",
  "unpinned_item",
  "message_changed",
  "message_deleted",
  "message_replied",
  "reminder_add",
  "sh_room_created",
]);

function usageAndExit(message?: string): never {
  if (message) console.error(`error: ${message}\n`);
  console.error(
    "usage: bun run backfill '#channel' ['@user'] ['YYYY-MM-DD'] ['YYYY-MM-DD']",
  );
  process.exit(1);
}

function isDateToken(s: string | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function dayBoundToSlackTs(dateStr: string, endOfDay: boolean): string {
  const iso = `${dateStr}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`;
  const ms = new Date(iso).getTime();
  if (isNaN(ms)) usageAndExit(`invalid date: ${dateStr}`);
  return (ms / 1000).toFixed(6);
}

function fmtTs(ts: string): string {
  const ms = Number.parseFloat(ts) * 1000;
  return isNaN(ms) ? ts : new Date(ms).toISOString();
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
      (c) => c.name?.toLowerCase() === raw.toLowerCase(),
    );
    if (found) return { id: found.id, name: found.name };
    cursor = resp.response_metadata?.next_cursor || undefined;
  } while (cursor);

  usageAndExit(`channel not found: #${raw}`);
}

async function resolveUser(
  slack: WebClient,
  token: string,
): Promise<{ id: string; label: string }> {
  const raw = token.replace(/^@/, "").trim();

  if (/^[UWB][A-Z0-9]{6,}$/.test(raw)) return { id: raw, label: raw };

  let cursor: string | undefined;
  do {
    const resp = await slack.users.list({ limit: 200, cursor });
    const found = (resp.members as any[] | undefined)?.find((u) => {
      const candidates = [u.name, u.real_name, u.profile?.display_name]
        .filter(Boolean)
        .map((s: string) => s.toLowerCase());
      return candidates.includes(raw.toLowerCase());
    });
    if (found) return { id: found.id, label: found.name || found.id };
    cursor = resp.response_metadata?.next_cursor || undefined;
  } while (cursor);

  usageAndExit(`user not found: @${raw}`);
}

interface Ctx {
  slack: WebClient;
  db: Awaited<ReturnType<typeof getDb>>;
  channelId: string;
  userFilter?: string;
  userNameCache: Map<string, string>;
}

async function resolveUserName(ctx: Ctx, userId: string): Promise<string> {
  if (ctx.userNameCache.has(userId)) return ctx.userNameCache.get(userId)!;
  let name = userId;
  try {
    const info = await ctx.slack.users.info({ user: userId });
    name = (info.user as any)?.name || userId;
  } catch {
    // keep the raw ID as a fallback label
  }
  ctx.userNameCache.set(userId, name);
  return name;
}

type Outcome = "stored" | "skipped-subtype" | "skipped-user";

async function processMessage(ctx: Ctx, msg: any): Promise<Outcome> {
  if (EXCLUDED_SUBTYPES.has(msg.subtype)) return "skipped-subtype";

  const authorId = msg.user || msg.bot_id || "";
  if (ctx.userFilter && authorId !== ctx.userFilter) return "skipped-user";

  let authorName = authorId;
  if (msg.user) {
    authorName = await resolveUserName(ctx, msg.user);
  } else if (msg.bot_id) {
    authorName = msg.username || msg.bot_id;
  }

  const storedTimestamp = resolveMessageTimestamp(msg, msg.ts);
  const storedAuthors = resolveStoredAuthors(msg, authorId, authorName);

  await q.upsertMessage(ctx.db, {
    slackTs: msg.ts,
    channelId: ctx.channelId,
    threadTs:
      msg.thread_ts && msg.thread_ts !== msg.ts ? msg.thread_ts : undefined,
    userId: storedAuthors.userId,
    userName: storedAuthors.userName,
    text: resolveSlackMrkdwn(extractMessageText(msg)),
    timestamp: storedTimestamp,
    metadata: {},
  });
  return "stored";
}

async function backfillThreadReplies(
  ctx: Ctx,
  rootTs: string,
): Promise<number> {
  let stored = 0;
  let cursor: string | undefined;
  do {
    const resp = await ctx.slack.conversations.replies({
      channel: ctx.channelId,
      ts: rootTs,
      limit: PAGE_SIZE,
      cursor,
    });
    const replies = (resp.messages || []).filter((m: any) => m.ts !== rootTs);
    for (const reply of replies) {
      const outcome = await processMessage(ctx, reply);
      if (outcome === "stored") stored++;
    }
    cursor = resp.response_metadata?.next_cursor || undefined;
    if (cursor) await sleep(DELAY_MS);
  } while (cursor);
  return stored;
}

async function main() {
  const argv = process.argv.slice(2);
  let i = 0;

  const channelToken = argv[i++];
  if (!channelToken) usageAndExit("missing channel");

  let userToken: string | undefined;
  if (argv[i] && !isDateToken(argv[i])) userToken = argv[i++];

  let startDateArg: string | undefined;
  let endDateArg: string | undefined;
  if (isDateToken(argv[i])) startDateArg = argv[i++];
  if (isDateToken(argv[i])) endDateArg = argv[i++];

  if (argv[i]) usageAndExit(`unexpected argument: ${argv[i]}`);

  if (startDateArg && endDateArg && startDateArg > endDateArg) {
    usageAndExit(
      `start date ${startDateArg} is after end date ${endDateArg}`,
    );
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) usageAndExit("DATABASE_URL is required");
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) usageAndExit("SLACK_BOT_TOKEN is required");

  const slack = new WebClient(botToken);
  const db = getDb(databaseUrl!);

  const channel = await resolveChannel(slack, db, channelToken!);
  const user = userToken ? await resolveUser(slack, userToken) : undefined;

  const channelConfig = await q.getChannel(db, channel.id);
  const trackReplies = channelConfig?.trackReplies ?? false;

  const oldest = startDateArg ? dayBoundToSlackTs(startDateArg, false) : undefined;
  let latest: string | undefined;
  if (endDateArg) {
    latest = dayBoundToSlackTs(endDateArg, true);
  } else {
    const oldestStored = await q.getOldestMessage(db, channel.id);
    latest = oldestStored?.slackTs;
  }

  console.log(`backfilling #${channel.name} (${channel.id})`);
  if (user) console.log(`  author filter: ${user.label} (${user.id})`);
  console.log(
    `  range: ${latest ? fmtTs(latest) : "most recent message"} -> ${oldest ? fmtTs(oldest) : "channel beginning"}`,
  );
  console.log(`  thread replies: ${trackReplies ? "included" : "skipped (trackReplies off)"}`);
  console.log("");

  const ctx: Ctx = {
    slack,
    db,
    channelId: channel.id,
    userFilter: user?.id,
    userNameCache: new Map(),
  };

  let totalFetched = 0;
  let totalStored = 0;
  let totalThreadReplies = 0;
  let page = 0;
  let cursorLatest = latest;

  while (true) {
    const resp = await slack.conversations.history({
      channel: channel.id,
      limit: PAGE_SIZE,
      inclusive: false,
      ...(cursorLatest ? { latest: cursorLatest } : {}),
      ...(oldest ? { oldest } : {}),
    });
    const messages = (resp.messages as any[]) || [];
    if (messages.length === 0) break;

    for (const msg of messages) {
      totalFetched++;
      const outcome = await processMessage(ctx, msg);
      if (outcome === "stored") totalStored++;

      if (
        trackReplies &&
        msg.thread_ts === msg.ts &&
        (msg.reply_count || 0) > 0
      ) {
        totalThreadReplies += await backfillThreadReplies(ctx, msg.ts);
      }
    }

    page++;
    const oldestInPage = messages[messages.length - 1].ts;
    console.log(
      `page ${page}: +${messages.length} fetched (stored ${totalStored}, thread replies ${totalThreadReplies}) - down to ${fmtTs(oldestInPage)}`,
    );

    if (!resp.has_more) break;
    cursorLatest = oldestInPage;
    await sleep(DELAY_MS);
  }

  console.log("");
  console.log(
    `done. fetched ${totalFetched}, stored ${totalStored}, thread replies stored ${totalThreadReplies}.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
