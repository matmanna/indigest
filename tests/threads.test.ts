import { afterAll, beforeAll, describe, expect, test } from "vitest";
import postgres from "postgres";
import { getDb } from "../src/db";
import * as q from "../src/db/queries";
import * as schema from "../src/db/schema";
import { generateApiKey } from "../src/lib/api-keys";
import {
  articleKeyFromCardText,
  commentUsage,
  normalizeArticleKey,
  validCommentTimestamps,
} from "../src/lib/threads";
import app from "../src/app";

describe("article keys", () => {
  test("only the path counts", () => {
    for (const value of [
      "https://news.hackclub.com/news/some-slug/",
      "https://news.hackclub.com/news/some-slug",
      "https://news.hackclub.com/news/some-slug/?ref=slack-bot",
      "https://preview-abc.hackclub.dev/news/some-slug/#top",
      "/news/some-slug",
      "/NEWS/Some-Slug/",
    ]) {
      expect(normalizeArticleKey(value), value).toBe("/news/some-slug/");
    }
  });

  test("things that are not an article are rejected", () => {
    for (const value of ["", "https://hackclub.com/", "/news/", "/a/b/c/", "not a url"]) {
      expect(normalizeArticleKey(value), value).toBeUndefined();
    }
  });

  test("a card's article is the first article-shaped link in its text", () => {
    expect(
      articleKeyFromCardText(
        "Title\n> blurb with https://hackclub.com/ in it\nhttps://news.hackclub.com/opinion/on-slop/?ref=slack-bot",
      ),
    ).toBe("/opinion/on-slop/");
    expect(articleKeyFromCardText(null, "<https://x.dev/news/a/|Title>")).toBe("/news/a/");
    expect(articleKeyFromCardText("no links here")).toBeUndefined();
  });
});

describe("comment limits", () => {
  const limits = { perDay: 2, total: 3, timeZone: "America/New_York" };
  // Slack timestamps. 2026-03-10 15:00 UTC is 11:00 in New York (EDT).
  const day = (iso: string, n = 0) => `${Math.floor(Date.parse(iso) / 1000) + n}.000${n}`;
  const reply = (userId: string, slackTs: string) => ({ userId, slackTs });

  test("two a day, three ever, oldest first", () => {
    const records = [
      reply("U1", day("2026-03-10T15:00:00Z", 0)),
      reply("U1", day("2026-03-10T15:00:00Z", 1)),
      reply("U1", day("2026-03-10T15:00:00Z", 2)), // third today
      reply("U1", day("2026-03-11T15:00:00Z", 0)), // third ever
      reply("U1", day("2026-03-12T15:00:00Z", 0)), // over the total
    ];
    const valid = validCommentTimestamps(records, limits);
    expect(records.map((r) => valid.has(r.slackTs))).toEqual([true, true, false, true, false]);
  });

  test("a reply over a limit does not use up allowance", () => {
    const records = [
      reply("U1", day("2026-03-10T15:00:00Z", 0)),
      reply("U1", day("2026-03-10T15:00:00Z", 1)),
      reply("U1", day("2026-03-10T15:00:00Z", 2)), // rejected
      reply("U1", day("2026-03-11T15:00:00Z", 0)), // still has the third
    ];
    expect(validCommentTimestamps(records, limits).size).toBe(3);
  });

  test("users are counted separately", () => {
    const records = [
      reply("U1", day("2026-03-10T15:00:00Z", 0)),
      reply("U1", day("2026-03-10T15:00:00Z", 1)),
      reply("U2", day("2026-03-10T15:00:00Z", 2)),
      reply("U2", day("2026-03-10T15:00:00Z", 3)),
    ];
    expect(validCommentTimestamps(records, limits).size).toBe(4);
  });

  test("a day ends at midnight in the zone, not in UTC", () => {
    // 03:30 UTC on the 11th is 23:30 on the 10th in New York; 05:00 UTC is
    // 01:00 on the 11th.
    const records = [
      reply("U1", day("2026-03-11T03:00:00Z", 0)),
      reply("U1", day("2026-03-11T03:30:00Z", 0)),
      reply("U1", day("2026-03-11T05:00:00Z", 0)),
    ];
    // The first two share a New York day; the third is a new one.
    expect(validCommentTimestamps(records, limits).size).toBe(3);
    expect(
      validCommentTimestamps(records, { ...limits, total: 10, timeZone: "UTC" }).size,
    ).toBe(2);
  });

  test("daylight saving does not shift the boundary by an hour", () => {
    // New York springs forward on 2026-03-08, so midnight on the 9th is 04:00
    // UTC (EDT, UTC-4). A fixed UTC-5 would put 04:01 UTC still on the 8th.
    const records = [
      reply("U1", day("2026-03-09T03:59:00Z", 0)), // 23:59 on the 8th
      reply("U1", day("2026-03-09T04:01:00Z", 0)), // 00:01 on the 9th
    ];
    expect(validCommentTimestamps(records, { ...limits, total: 10, perDay: 1 }).size).toBe(2);
  });

  test("a deleted reply still counts: records do not say whether one was deleted", () => {
    // listReplyRecords returns deleted and live replies alike, so a deleted
    // one is in the records and uses allowance like any other.
    const records = [
      reply("U1", day("2026-03-10T15:00:00Z", 0)),
      reply("U1", day("2026-03-10T15:00:00Z", 1)), // deleted, but present
    ];
    const valid = validCommentTimestamps(records, limits);
    expect(valid.size).toBe(2);
    const third = [...records, reply("U1", day("2026-03-10T15:00:00Z", 2))];
    expect(validCommentTimestamps(third, limits).has(third[2]!.slackTs)).toBe(false);
  });

  test("usage reports what a user has used today and in total", () => {
    const now = new Date("2026-03-11T15:00:00Z");
    const records = [
      reply("U1", day("2026-03-10T15:00:00Z", 0)),
      reply("U1", day("2026-03-11T14:00:00Z", 0)),
      reply("U2", day("2026-03-11T14:00:00Z", 1)),
    ];
    expect(commentUsage(records, "U1", limits, now)).toEqual({
      used: 2,
      total: 3,
      usedToday: 1,
      perDay: 2,
    });
    expect(commentUsage(records, "U9", limits, now).used).toBe(0);
  });
});

const url =
  process.env.TEST_DATABASE_URL ||
  "postgres://indigest:indigest@localhost:5433/indigest_test";
const suffix = `thr-${Date.now()}`;
const channelId = `C-${suffix}`;

describe.skipIf(!process.env.TEST_DATABASE_URL)("GET /api/threads", () => {
  const raw = postgres(url, { max: 1 });
  const db = getDb(url);
  const env = {
    DATABASE_URL: url,
    SLACK_SIGNING_SECRET: "test-signing-secret",
    SLACK_BOT_TOKEN: "xoxb-test",
    BETTER_AUTH_SECRET: "test-better-auth-secret-0123456789abcdef",
    BETTER_AUTH_URL: "http://localhost:8080",
  } as any;
  let bearer = "";
  let keyId = 0;

  const seed = (slackTs: string, extra: Partial<q.Message> = {}) =>
    q.upsertMessage(db, {
      slackTs,
      channelId,
      userId: "U1",
      userName: "ada",
      text: `text ${slackTs}`,
      formattedText: null,
      timestamp: new Date(Number(slackTs.split(".")[0]) * 1000).toISOString(),
      metadata: {},
      ...extra,
    });

  const get = async (query: string) => {
    const res = await app.request(
      `/api/threads?channel=${channelId}&${query}`,
      { headers: { Accept: "application/json", Authorization: `Bearer ${bearer}` } },
      env,
    );
    return { status: res.status, json: (await res.json()) as any };
  };

  const reset = () => raw`delete from messages where channel_id = ${channelId}`;

  beforeAll(async () => {
    await q.upsertChannel(db, {
      id: channelId,
      name: channelId,
      teamId: "T1",
      enabled: true,
      linkMode: false,
      webhookUrl: "",
      autoApproveUsers: [],
      manualUsers: [],
      triggerMode: "message",
      approvedPosters: [],
      accessPermUsers: ["*"],
      trackReplies: true,
      metadataSchema: "",
      metadataRequired: false,
      properties: "",
      createdAt: "",
    });
    const { fullKey, keyPrefix, secretHash } = generateApiKey();
    const [key] = await db
      .insert(schema.apiKeys)
      .values({ name: `threads-test-${suffix}`, keyPrefix, secretHash: await secretHash })
      .returning({ id: schema.apiKeys.id });
    keyId = key!.id;
    await db.insert(schema.apiKeyChannels).values({ keyId, channelId });
    bearer = fullKey;
  });

  afterAll(async () => {
    await raw`delete from messages where channel_id = ${channelId}`;
    await raw`delete from api_key_channels where key_id = ${keyId}`;
    await raw`delete from api_keys where id = ${keyId}`;
    await raw`delete from channels where id = ${channelId}`;
    await raw.end();
  });

  const CARD = "Welcome\n> blurb\nhttps://preview.example.dev/news/welcome/?ref=slack-bot";
  const DAY = 1_790_000_000; // a fixed instant

  test("finds a card by its article and returns its replies oldest first", async () => {
    await reset();
    await seed(`${DAY}.000100`, { text: CARD });
    await seed(`${DAY + 20}.000100`, { threadTs: `${DAY}.000100`, userId: "U2" });
    await seed(`${DAY + 10}.000100`, { threadTs: `${DAY}.000100`, userId: "U1" });
    // Another article's card and thread.
    await seed(`${DAY + 1}.000100`, { text: "Other https://x.dev/news/other/" });
    await seed(`${DAY + 30}.000100`, { threadTs: `${DAY + 1}.000100` });

    for (const key of ["/news/welcome/", "/news/welcome", "https://news.hackclub.com/news/welcome/?x=1"]) {
      const { status, json } = await get(`key=${encodeURIComponent(key)}`);
      expect(status, key).toBe(200);
      expect(json.data.card).toEqual({ slackTs: `${DAY}.000100`, channelId });
      expect(json.data.replies.map((r: any) => r.slackTs)).toEqual([
        `${DAY + 10}.000100`,
        `${DAY + 20}.000100`,
      ]);
    }
  });

  test("an article without a card has no thread, and a similar slug is not a match", async () => {
    await reset();
    await seed(`${DAY}.000100`, { text: "https://x.dev/news/welcome-back/" });
    await seed(`${DAY + 1}.000100`, { threadTs: `${DAY}.000100` });
    const { json } = await get("key=/news/welcome/");
    expect(json.data).toEqual({ card: null, replies: [] });
  });

  test("the card's text is not returned, only its reply", async () => {
    await reset();
    await seed(`${DAY}.000100`, { text: CARD });
    await seed(`${DAY + 1}.000100`, { threadTs: `${DAY}.000100`, text: "hello" });
    const { json } = await get("key=/news/welcome/");
    expect(JSON.stringify(json)).not.toContain("blurb");
    expect(json.data.replies[0]).toEqual({
      slackTs: `${DAY + 1}.000100`,
      userId: "U1",
      userName: "ada",
      text: "hello",
      formattedText: null,
      timestamp: expect.any(String),
    });
  });

  test("replies over the limits are held back, and the viewer's usage is reported", async () => {
    await reset();
    await seed(`${DAY}.000100`, { text: CARD });
    for (let i = 1; i <= 4; i++) {
      await seed(`${DAY + i}.000100`, { threadTs: `${DAY}.000100`, text: `reply ${i}` });
    }
    // No limits: everything.
    expect((await get("key=/news/welcome/")).json.data.replies).toHaveLength(4);
    // Two a day: the first two.
    const limited = await get("key=/news/welcome/&perDay=2&total=3&viewer=U1");
    expect(limited.json.data.replies.map((r: any) => r.text)).toEqual(["reply 1", "reply 2"]);
    expect(limited.json.data.viewer).toMatchObject({ used: 2, usedToday: expect.any(Number), total: 3, perDay: 2 });
  });

  test("a deleted comment uses up allowance but is never returned", async () => {
    await reset();
    await seed(`${DAY}.000100`, { text: CARD });
    await seed(`${DAY + 1}.000100`, { threadTs: `${DAY}.000100`, text: "SECRET-deleted" });
    await seed(`${DAY + 2}.000100`, { threadTs: `${DAY}.000100`, text: "second" });
    await seed(`${DAY + 3}.000100`, { threadTs: `${DAY}.000100`, text: "third" });
    await q.markMessageDeleted(db, channelId, `${DAY + 1}.000100`);

    const { json } = await get("key=/news/welcome/&perDay=2&total=3");
    expect(JSON.stringify(json)).not.toContain("SECRET-deleted");
    // The deleted comment was the first of two for the day, so "third" is over.
    expect(json.data.replies.map((r: any) => r.text)).toEqual(["second"]);
  });

  test("bad input and unknown channels are refused", async () => {
    expect((await get("key=/news/")).status).toBe(400);
    const res = await app.request(
      "/api/threads?channel=C-nope&key=/news/a/",
      { headers: { Authorization: `Bearer ${bearer}` } },
      env,
    );
    expect(res.status).toBe(404);
    const anonymous = await app.request(`/api/threads?channel=${channelId}&key=/news/a/`, {}, env);
    expect(anonymous.status).toBe(401);
  });
});
