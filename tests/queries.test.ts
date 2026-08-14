import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { getDb } from "../src/db";
import * as q from "../src/db/queries";

const url = process.env.TEST_DATABASE_URL || "postgres://indigest:indigest@localhost:5433/indigest_test";
const raw = postgres(url, { max: 1 });
const db = getDb(url);
const suffix = `test-${Date.now()}`;
const sourceId = `C-${suffix}`;
const subscriberId = `C-sub-${suffix}`;

const channel = (id: string, enabled = true): q.Channel => ({ id, name: id, teamId: "T1", enabled, linkMode: false, webhookUrl: "", autoApproveUsers: ["a", "b"], approvedPosters: [], accessPermUsers: ["*"], trackReplies: false, metadataSchema: "", metadataRequired: false, createdAt: "" });
const message = (slackTs: string, text: string, extra: Partial<q.Message> = {}): q.Message => ({ slackTs, channelId: sourceId, userId: "U1", userName: "Ada", text, timestamp: `2026-01-01T00:00:${slackTs.split(".")[1] || "00"}.000Z`, metadata: { ok: true }, ...extra });

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  await raw`select 1`;
});
afterAll(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  await raw`delete from bot_actions where source_channel_id = ${sourceId}`;
  await raw`delete from messages where channel_id = ${sourceId}`;
  await raw`delete from subscriptions where subscriber_channel_id = ${subscriberId} or source_channel_id = ${sourceId}`;
  await raw`delete from channels where id = ${sourceId}`;
  await raw`delete from channels where id = ${subscriberId}`;
  await raw.end();
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("database queries", () => {
  test("channel CRUD and idempotent upsert", async () => {
    await q.upsertChannel(db, channel(sourceId));
    await q.upsertChannel(db, { ...channel(sourceId), name: "updated", enabled: false });
    expect((await q.getChannel(db, sourceId))?.name).toBe("updated");
    expect((await q.listChannels(db)).some((c) => c.id === sourceId)).toBe(true);
    expect((await q.listEnabledChannels(db)).some((c) => c.id === sourceId)).toBe(false);
  });

  test("message upsert, CRUD, filters, and count", async () => {
    await q.upsertChannel(db, channel(sourceId));
    await q.upsertMessage(db, message("1.01", "first"));
    await q.upsertMessage(db, message("2.02", "second", { userId: "U2", threadTs: "1.01", timestamp: "2026-01-02T00:00:00.000Z" }));
    await q.upsertMessage(db, message("1.01", "updated"));
    expect((await q.getMessageBySlackTs(db, sourceId, "1.01"))?.text).toBe("updated");
    expect((await q.getMessages(db, sourceId, { userId: "U2" })).length).toBe(1);
    expect((await q.getMessages(db, sourceId, { threadTs: "1.01" })).length).toBe(1);
    expect((await q.getMessages(db, sourceId, { after: "2026-01-02" })).length).toBe(1);
    expect((await q.getMessages(db, sourceId, { before: "2026-01-01" })).length).toBe(1);
    expect(await q.getMessageCount(db, sourceId, { userId: "U2" })).toBe((await q.getMessages(db, sourceId, { userId: "U2" })).length);
    await q.deleteMessage(db, sourceId, "1.01");
    expect(await q.getMessageBySlackTs(db, sourceId, "1.01")).toBeNull();
  });

  test("subscriptions, bot actions, and graph data", async () => {
    await q.upsertChannel(db, channel(sourceId, true));
    await q.upsertChannel(db, channel(subscriberId, false));
    await q.addSubscription(db, subscriberId, sourceId);
    await q.addSubscription(db, subscriberId, sourceId);
    expect((await q.getSubscribersBySource(db, sourceId)).length).toBe(1);
    expect((await q.getSubscriptionsBySubscriber(db, subscriberId)).length).toBe(1);
    await q.addBotAction(db, { type: "approve", sourceChannelId: sourceId, sourceMessageTs: "1.1", botChannelId: sourceId, botMessageTs: "2.2", userId: "U123", command: "indigest_yes", createdAt: "" });
    const actions = await q.getBotActionsBySource(db, sourceId, "1.1");
    expect(actions[0]?.type).toBe("approve");
    expect(actions[0]?.userId).toBe("U123");
    expect(actions[0]?.command).toBe("indigest_yes");
    await q.addBotAction(db, { type: "pub", sourceChannelId: sourceId, sourceMessageTs: "1.1", botChannelId: subscriberId, botMessageTs: "3.3", createdAt: "" });
    const forwards = (await q.getBotActionsBySource(db, sourceId, "1.1"))
      .filter((action) => action.type === "pub" && action.botChannelId === subscriberId);
    expect(forwards).toHaveLength(1);
    expect(forwards[0]?.botMessageTs).toBe("3.3");
    const graph = await q.getGraphData(db);
    expect(graph.channels.some((c) => c.id === sourceId)).toBe(true);
    expect(graph.subscriberChannels.some((c) => c.id === subscriberId)).toBe(true);
    expect(graph.subscriptions.some((s) => s.sourceChannelId === sourceId)).toBe(true);
    await q.removeSubscription(db, subscriberId, sourceId);
  });

  test("boolean and comma-separated values round-trip consistently", async () => {
    await q.upsertChannel(db, { ...channel(sourceId), enabled: true, metadataRequired: true, autoApproveUsers: ["a", "b"], accessPermUsers: ["*"] });
    const got = await q.getChannel(db, sourceId);
    expect(got?.enabled).toBe(true);
    expect(got?.metadataRequired).toBe(true);
    expect(got?.autoApproveUsers).toEqual(["a", "b"]);
    expect(got?.accessPermUsers).toEqual(["*"]);
  });
});
