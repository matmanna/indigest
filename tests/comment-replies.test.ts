import { afterAll, beforeAll, describe, expect, test } from "vitest";
import postgres from "postgres";
import { getDb } from "../src/db";
import * as q from "../src/db/queries";
import {
  cardText,
  editedAtFromMetadata,
  isCardAuthor,
  parseCommentConfig,
} from "../src/lib/threads";
import { handleReplyEdited, isReplyEdit } from "../src/lib/edits";
import { reconcileThreadDeletions, type RepliesClient } from "../src/lib/deletions";
import app from "../src/app";

describe("comment channel config", () => {
  test("channels and card authors are comma lists, and cards default to indigest's own", () => {
    expect(parseCommentConfig({})).toEqual({ channels: new Set(), cardBots: ["self"] });
    const config = parseCommentConfig({ COMMENT_CHANNELS: "C1, C2", COMMENT_CARD_BOTS: "self, UBOT" });
    expect([...config.channels]).toEqual(["C1", "C2"]);
    expect(config.cardBots).toEqual(["self", "UBOT"]);
  });

  test("a card author is a listed user or bot, or indigest itself when self is listed", () => {
    const self = { userId: "USELF", botId: "BSELF" };
    expect(isCardAuthor({ user: "USELF" }, ["self"], self)).toBe(true);
    expect(isCardAuthor({ bot_id: "BSELF" }, ["self"], self)).toBe(true);
    expect(isCardAuthor({ user: "USELF" }, ["UBOT"], self)).toBe(false);
    expect(isCardAuthor({ user: "UBOT" }, ["self", "UBOT"], self)).toBe(true);
    expect(isCardAuthor({ bot_id: "BOTHER" }, ["self", "UBOT"], self)).toBe(false);
    expect(isCardAuthor({ user: "UHUMAN" }, ["self", "UBOT"], self)).toBe(false);
    expect(isCardAuthor({}, ["self"], self)).toBe(false);
  });

  test("a card's links come from its blocks as well as its text", () => {
    const blocks = [
      { type: "card", title: { type: "mrkdwn", text: "<https://x.dev/news/a/?ref=slack-bot|Title>" } },
    ];
    expect(cardText({ text: "Title\n> blurb", blocks })).toContain("https://x.dev/news/a/?ref=slack-bot");
    // Not repeated when the text has it already.
    expect(cardText({ text: "https://x.dev/news/a/?ref=slack-bot", blocks })).toBe(
      "https://x.dev/news/a/?ref=slack-bot",
    );
    expect(cardText({ text: "plain" })).toBe("plain");
  });
});

describe("which message_changed events are reply edits", () => {
  test("only an edited reply counts", () => {
    expect(isReplyEdit({ ts: "2.1", thread_ts: "1.1", edited: { ts: "3.1" } })).toBe(true);
    // No `edited`: a link unfurl or similar.
    expect(isReplyEdit({ ts: "2.1", thread_ts: "1.1" })).toBe(false);
    // The root of a thread is not a comment.
    expect(isReplyEdit({ ts: "1.1", thread_ts: "1.1", edited: { ts: "3.1" } })).toBe(false);
    // Not in a thread.
    expect(isReplyEdit({ ts: "2.1", edited: { ts: "3.1" } })).toBe(false);
    // A broadcast, a tombstone, and so on.
    expect(isReplyEdit({ ts: "2.1", thread_ts: "1.1", subtype: "thread_broadcast", edited: { ts: "3.1" } })).toBe(false);
    expect(isReplyEdit(undefined)).toBe(false);
  });

  test("the edit time is read back from metadata", () => {
    expect(editedAtFromMetadata('{"editedAt":"2026-01-01T00:00:00.000Z"}')).toBe("2026-01-01T00:00:00.000Z");
    expect(editedAtFromMetadata("{}")).toBeUndefined();
    expect(editedAtFromMetadata("not json")).toBeUndefined();
    expect(editedAtFromMetadata(undefined)).toBeUndefined();
  });
});

const url =
  process.env.TEST_DATABASE_URL ||
  "postgres://indigest:indigest@localhost:5433/indigest_test";
const suffix = `cmt-${Date.now()}`;
const channelId = `C-${suffix}`;
const otherChannelId = `C-other-${suffix}`;

describe.skipIf(!process.env.TEST_DATABASE_URL)("comment replies", () => {
  const raw = postgres(url, { max: 1 });
  const db = getDb(url);
  const env = {
    DATABASE_URL: url,
    SLACK_SIGNING_SECRET: "test-signing-secret",
    // Never reached: every case below is decided without calling Slack.
    SLACK_BOT_TOKEN: "xoxb-test",
    BETTER_AUTH_SECRET: "test-better-auth-secret-0123456789abcdef",
    BETTER_AUTH_URL: "http://localhost:8080",
    COMMENT_CHANNELS: channelId,
    COMMENT_CARD_BOTS: "UCARDBOT",
  } as any;

  const channel = (id: string): q.Channel => ({
    id,
    name: id,
    teamId: "T1",
    enabled: true,
    linkMode: false,
    webhookUrl: "",
    autoApproveUsers: [],
    manualUsers: [],
    triggerMode: "shortcut",
    approvedPosters: [],
    accessPermUsers: ["*"],
    trackReplies: true,
    metadataSchema: "",
    metadataRequired: false,
    properties: "",
    createdAt: "",
  });

  const seed = (id: string, slackTs: string, extra: Partial<q.Message> = {}) =>
    q.upsertMessage(db, {
      slackTs,
      channelId: id,
      userId: "U1",
      userName: "ada",
      text: `text ${slackTs}`,
      formattedText: null,
      timestamp: new Date(Number(slackTs.split(".")[0]) * 1000).toISOString(),
      metadata: {},
      ...extra,
    });

  const rows = (id: string) =>
    raw`select slack_ts, text, metadata from messages where channel_id = ${id} order by slack_ts`;
  const reset = () => raw`delete from messages where channel_id in (${channelId}, ${otherChannelId})`;

  async function signedEvent(event: unknown) {
    const body = JSON.stringify({ type: "event_callback", event });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.SLACK_SIGNING_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`));
    const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
    const pending: Promise<unknown>[] = [];
    const res = await app.request(
      "/events",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": `v0=${hex}`,
        },
        body,
      },
      env,
      { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as any,
    );
    await Promise.all(pending);
    return res;
  }

  const reply = (channel: string, ts: string, extra: Record<string, unknown> = {}) =>
    signedEvent({
      type: "message",
      channel,
      user: "UCOMMENTER",
      text: `comment ${ts}`,
      ts,
      thread_ts: "100.000001",
      parent_user_id: "UCARDBOT",
      ...extra,
    });

  beforeAll(async () => {
    await q.upsertChannel(db, channel(channelId));
    await q.upsertChannel(db, channel(otherChannelId));
  });

  afterAll(async () => {
    await reset();
    await raw`delete from channels where id in (${channelId}, ${otherChannelId})`;
    await raw.end();
  });

  const card = () =>
    seed(channelId, "100.000001", { userId: "UCARDBOT", text: "Title https://x.dev/news/a/" });

  describe("replies under cards", () => {
    test("a reply under a card by an allowed bot is stored", async () => {
      await reset();
      await card();
      expect((await reply(channelId, "101.000001")).status).toBe(200);
      const stored = await q.getMessageBySlackTs(db, channelId, "101.000001");
      expect(stored).toMatchObject({ threadTs: "100.000001", userId: "UCOMMENTER", text: "comment 101.000001" });
    });

    test("a reply under anything else is not tracked, and does not store its thread", async () => {
      await reset();
      // A human's top-level message with a reply.
      await seed(channelId, "100.000001", { userId: "UHUMAN", text: "just chatting" });
      await reply(channelId, "101.000001", { parent_user_id: "UHUMAN" });
      expect(await q.getMessageBySlackTs(db, channelId, "101.000001")).toBeNull();
      expect(await rows(channelId)).toHaveLength(1);
    });

    test("a reply by a bot is not a comment", async () => {
      await reset();
      await card();
      await reply(channelId, "101.000001", { bot_id: "BNOTICE" });
      expect(await q.getMessageBySlackTs(db, channelId, "101.000001")).toBeNull();
    });

    test("channels not listed keep tracking every reply, as before", async () => {
      await reset();
      // No card, no allowed parent: still stored (the parent lookup fails
      // quietly, as it did before).
      await reply(otherChannelId, "101.000001", { parent_user_id: "UHUMAN" });
      expect((await q.getMessageBySlackTs(db, otherChannelId, "101.000001"))?.text).toBe("comment 101.000001");
    });
  });

  describe("edits", () => {
    test("an edit updates the stored reply and notes when", async () => {
      await reset();
      await card();
      await reply(channelId, "101.000001");
      const res = await signedEvent({
        type: "message",
        subtype: "message_changed",
        channel: channelId,
        message: {
          type: "message",
          user: "UCOMMENTER",
          text: "comment, but *fixed*",
          ts: "101.000001",
          thread_ts: "100.000001",
          edited: { user: "UCOMMENTER", ts: "1790000000.000000" },
        },
      });
      expect(res.status).toBe(200);
      const [row] = await rows(channelId).then((r) => r.filter((x) => x.slack_ts === "101.000001"));
      expect(row!.text).toBe("comment, but *fixed*");
      expect(JSON.parse(row!.metadata).editedAt).toBe(new Date(1790000000 * 1000).toISOString());
    });

    test("an edit never touches a deleted reply, the card, or a reply that was never stored", async () => {
      await reset();
      await card();
      await seed(channelId, "101.000001", { threadTs: "100.000001", text: "SECRET-original" });
      await q.markMessageDeleted(db, channelId, "101.000001");

      const edit = (ts: string, threadTs?: string) =>
        signedEvent({
          type: "message",
          subtype: "message_changed",
          channel: channelId,
          message: { ts, thread_ts: threadTs, text: "rewritten", edited: { ts: "1790000000.0" } },
        });
      await edit("101.000001", "100.000001"); // deleted
      await edit("100.000001", "100.000001"); // the card
      await edit("999.000001", "100.000001"); // unknown

      const stored = await rows(channelId);
      expect(stored.find((r) => r.slack_ts === "101.000001")!.text).toBe("SECRET-original");
      expect(stored.find((r) => r.slack_ts === "100.000001")!.text).toBe("Title https://x.dev/news/a/");
      expect(stored.find((r) => r.slack_ts === "999.000001")).toBeUndefined();
    });

    test("an event without edited, such as a link unfurl, changes nothing", async () => {
      await reset();
      await card();
      await reply(channelId, "101.000001");
      await signedEvent({
        type: "message",
        subtype: "message_changed",
        channel: channelId,
        message: { ts: "101.000001", thread_ts: "100.000001", text: "comment with unfurl" },
      });
      expect((await q.getMessageBySlackTs(db, channelId, "101.000001"))?.text).toBe("comment 101.000001");
    });

    test("the edited text and time come back from the API", async () => {
      await reset();
      await card();
      await seed(channelId, "101.000001", { threadTs: "100.000001", text: "before" });
      await handleReplyEdited(db, {
        channel: channelId,
        ts: "101.000001",
        text: "after",
        formattedText: null,
        editedTs: "1790000000.0",
      });
      const [row] = await rows(channelId).then((r) => r.filter((x) => x.slack_ts === "101.000001"));
      expect(row!.text).toBe("after");
      expect(editedAtFromMetadata(row!.metadata)).toBe(new Date(1790000000 * 1000).toISOString());
    });

    test("reconcile brings edits up to date when their events were missed", async () => {
      await reset();
      await card();
      await seed(channelId, "101.000001", { threadTs: "100.000001", text: "old text" });
      await seed(channelId, "102.000001", { threadTs: "100.000001", text: "unchanged" });
      const slack: RepliesClient = {
        conversations: {
          async replies() {
            return {
              messages: [
                { ts: "100.000001" },
                { ts: "101.000001", text: "new text", edited: { ts: "1790000000.0" } },
                { ts: "102.000001", text: "unchanged", edited: { ts: "1790000001.0" } },
              ],
            };
          },
        },
      };
      const render = (m: { text?: string }) => ({ text: m.text ?? "", formattedText: null });
      const result = await reconcileThreadDeletions(db, slack, channelId, "100.000001", render);
      expect(result).toEqual({ deleted: [], edited: ["101.000001"], complete: true });
      expect((await q.getMessageBySlackTs(db, channelId, "101.000001"))?.text).toBe("new text");
      // Without a renderer it only looks for deletions.
      expect((await reconcileThreadDeletions(db, slack, channelId, "100.000001")).edited).toEqual([]);
    });
  });
});
