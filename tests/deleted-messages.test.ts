import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { getDb } from "../src/db";
import * as q from "../src/db/queries";
import * as schema from "../src/db/schema";
import { generateApiKey } from "../src/lib/api-keys";
import app from "../src/app";
import {
  handleMessageDeleted,
  reconcileThreadDeletions,
  type RepliesClient,
} from "../src/lib/deletions";

// A message Slack reports deleted keeps its content in the database, hidden by
// a deleted_at column. These tests exist to make sure that content is never
// returned to anyone: not by a query, an API, a feed, nor an event replay.
// The static tests run everywhere. The rest need TEST_DATABASE_URL.

const SECRET = "DELETED-CONTENT-must-never-be-served";
const FORMATTED_SECRET = "*DELETED-FORMATTED-must-never-be-served*";
const METADATA_SECRET = "DELETED-METADATA-must-never-be-served";

// --- static guards (no database) ---

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

// Queries allowed to read deleted rows, because they return no content.
const CONTENT_FREE_QUERIES = ["listTombstones", "listReplyRecords"];

/** Splits queries.ts into its top-level functions, keyed by name. */
function queryFunctions(): Map<string, string> {
  const source = readFileSync("src/db/queries.ts", "utf8");
  const parts = source.split(/^(?=(?:export )?(?:async )?function )/m);
  const functions = new Map<string, string>();
  for (const part of parts) {
    const name = part.match(/^(?:export )?(?:async )?function (\w+)/)?.[1];
    if (name) functions.set(name, part);
  }
  return functions;
}

describe("deleted messages: static guards", () => {
  test("only the query layer touches the messages table", () => {
    const offenders = sourceFiles("src")
      .filter((file) => !["src/db/queries.ts", "src/db/schema.ts"].includes(file))
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return (
          /schema\.messages\b/.test(source) ||
          /sql`[^`]*\bfrom\s+"?messages\b/i.test(source)
        );
      });
    expect(offenders).toEqual([]);
  });

  test("every read of the messages table in the query layer filters deleted rows", () => {
    const unfiltered = [...queryFunctions()]
      .filter(([, body]) => body.includes(".from(schema.messages)"))
      // These read deleted rows on purpose, and are checked below.
      .filter(([name]) => !CONTENT_FREE_QUERIES.includes(name))
      .filter(([, body]) => !body.includes("notDeleted"))
      .map(([name]) => name);
    expect(unfiltered).toEqual([]);
  });

  test("queries that read deleted rows never select content", () => {
    for (const name of CONTENT_FREE_QUERIES) {
      const body = queryFunctions().get(name)!;
      expect(body, name).toBeDefined();
      for (const column of ["text", "formattedText", "metadata", "userName"]) {
        expect(body, `${name} selects ${column}`).not.toMatch(
          new RegExp(`schema\\.messages\\.${column}\\b`),
        );
      }
      // Selecting the whole table would pull the content in too.
      expect(body, name).not.toMatch(/\.select\(\s*\)/);
    }
  });

  test("the Tombstone type carries no content", () => {
    const source = readFileSync("src/db/queries.ts", "utf8");
    const type = source.match(/export interface Tombstone \{[^}]*\}/)?.[0] ?? "";
    expect(type).not.toBe("");
    for (const field of ["text", "formattedText", "metadata", "rawText"]) {
      expect(type).not.toMatch(new RegExp(`\\b${field}\\b`));
    }
  });

  test("upserts cannot revive or rewrite a deleted message", () => {
    expect(queryFunctions().get("upsertMessage")).toContain("setWhere: notDeleted");
  });

  test("mapping a deleted row to a message fails closed", () => {
    expect(queryFunctions().get("rowToMessage")).toContain("r.deletedAt");
  });
});

// --- reconcile (fake Slack, needs the database only to hold rows) ---

const url =
  process.env.TEST_DATABASE_URL ||
  "postgres://indigest:indigest@localhost:5433/indigest_test";
const suffix = `del-${Date.now()}`;
const channelId = `C-${suffix}`;
const otherChannelId = `C-other-${suffix}`;

const channel = (id: string): q.Channel => ({
  id,
  name: id,
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

const message = (
  slackTs: string,
  extra: Partial<q.Message> = {},
): q.Message => ({
  slackTs,
  channelId,
  userId: "U1",
  userName: "ada",
  text: `live ${slackTs}`,
  formattedText: `*live ${slackTs}*`,
  timestamp: `2026-01-01T00:00:${slackTs.split(".")[1]?.padStart(2, "0") ?? "00"}.000Z`,
  metadata: { title: `live ${slackTs}` },
  ...extra,
});

const secretMessage = (slackTs: string, extra: Partial<q.Message> = {}) =>
  message(slackTs, {
    text: SECRET,
    formattedText: FORMATTED_SECRET,
    metadata: { title: METADATA_SECRET },
    ...extra,
  });

describe.skipIf(!process.env.TEST_DATABASE_URL)("deleted messages: database", () => {
  const raw = postgres(url, { max: 1 });
  const db = getDb(url);

  async function reset() {
    await raw`delete from messages where channel_id in (${channelId}, ${otherChannelId})`;
  }

  beforeAll(async () => {
    await q.upsertChannel(db, channel(channelId));
    await q.upsertChannel(db, channel(otherChannelId));
  });

  afterAll(async () => {
    await raw`delete from messages where channel_id in (${channelId}, ${otherChannelId})`;
    await raw`delete from channels where id in (${channelId}, ${otherChannelId})`;
    await raw.end();
  });

  /** Everything a reader can get from the query layer, as one string. */
  async function everythingReadable(): Promise<string> {
    const results = await Promise.all([
      q.getMessages(db, channelId),
      q.getMessages(db, channelId, { userId: "U1" }),
      q.getMessages(db, channelId, { userId: "U2" }),
      q.getMessages(db, channelId, { threadTs: "1.01" }),
      q.getMessages(db, channelId, { after: "2025-01-01", before: "2027-01-01" }),
      q.getMessageBySlackTs(db, channelId, "1.01"),
      q.getMessageBySlackTs(db, channelId, "1.02"),
      q.getMessageBySlackTs(db, channelId, "1.03"),
      q.getOldestMessage(db, channelId),
      q.getRecentMessages(db, channelId, new Date("2025-01-01")),
    ]);
    return JSON.stringify(results);
  }

  test("deleting keeps the content in the row and sets deleted_at", async () => {
    await reset();
    await q.upsertMessage(db, secretMessage("1.01"));
    expect(await q.markMessageDeleted(db, channelId, "1.01")).toBe(true);

    const [row] = await raw`select text, formatted_text, metadata, deleted_at from messages where channel_id = ${channelId} and slack_ts = '1.01'`;
    expect(row!.text).toBe(SECRET);
    expect(row!.formatted_text).toBe(FORMATTED_SECRET);
    expect(row!.deleted_at).toBeInstanceOf(Date);
  });

  test("marking is idempotent and ignores unknown messages", async () => {
    await reset();
    await q.upsertMessage(db, secretMessage("1.01"));
    expect(await q.markMessageDeleted(db, channelId, "1.01")).toBe(true);
    expect(await q.markMessageDeleted(db, channelId, "1.01")).toBe(false);
    expect(await q.markMessageDeleted(db, channelId, "9.99")).toBe(false);
    // A message is only ever deleted in its own channel.
    await q.upsertMessage(db, { ...message("1.05"), channelId: otherChannelId });
    expect(await q.markMessageDeleted(db, channelId, "1.05")).toBe(false);
    expect(await q.getMessageBySlackTs(db, otherChannelId, "1.05")).not.toBeNull();
  });

  test("no query returns a deleted message's content or the message", async () => {
    await reset();
    await q.upsertMessage(db, message("1.01", { userId: "U2" })); // live root
    await q.upsertMessage(db, secretMessage("1.02", { threadTs: "1.01", userId: "U1" }));
    await q.upsertMessage(db, secretMessage("1.03", { threadTs: "1.01", userId: "U2" }));
    await q.upsertMessage(db, message("1.04", { threadTs: "1.01", userId: "U1" }));

    // Control: before deleting, the secret is readable, so the checks below
    // cannot pass just because the queries return nothing.
    expect(await everythingReadable()).toContain(SECRET);

    await q.markMessageDeleted(db, channelId, "1.02");
    await q.markMessageDeleted(db, channelId, "1.03");

    const readable = await everythingReadable();
    expect(readable).not.toContain(SECRET);
    expect(readable).not.toContain(FORMATTED_SECRET);
    expect(readable).not.toContain(METADATA_SECRET);

    expect(await q.getMessageBySlackTs(db, channelId, "1.02")).toBeNull();
    expect(await q.getMessageBySlackTs(db, channelId, "1.03")).toBeNull();
    // The live messages around them are untouched.
    expect((await q.getMessages(db, channelId)).map((m) => m.slackTs).sort()).toEqual(["1.01", "1.04"]);
    expect((await q.getMessages(db, channelId, { threadTs: "1.01" })).map((m) => m.slackTs)).toEqual(["1.04"]);
  });

  test("counts leave deleted messages out", async () => {
    await reset();
    await q.upsertMessage(db, message("1.01"));
    await q.upsertMessage(db, secretMessage("1.02", { threadTs: "1.01" }));
    await q.markMessageDeleted(db, channelId, "1.02");
    expect(await q.getMessageCount(db, channelId)).toBe(1);
    expect(await q.getMessageCount(db, channelId, { threadTs: "1.01" })).toBe(0);
    expect(await q.getMessageCount(db, channelId, { userId: "U1" })).toBe(1);
  });

  test("a deleted oldest message is not the backfill resume point", async () => {
    await reset();
    await q.upsertMessage(db, secretMessage("1.01"));
    await q.upsertMessage(db, message("1.02"));
    await q.markMessageDeleted(db, channelId, "1.01");
    expect((await q.getOldestMessage(db, channelId))?.slackTs).toBe("1.02");
  });

  test("a late upsert cannot revive or rewrite a deleted message", async () => {
    await reset();
    await q.upsertMessage(db, secretMessage("1.01"));
    await q.markMessageDeleted(db, channelId, "1.01");

    // The same message arriving again, edited, as a late event would.
    await q.upsertMessage(db, message("1.01", { text: "edited after delete" }));

    expect(await q.getMessageBySlackTs(db, channelId, "1.01")).toBeNull();
    expect(await q.getMessageCount(db, channelId)).toBe(0);
    const [row] = await raw`select text, deleted_at from messages where channel_id = ${channelId} and slack_ts = '1.01'`;
    expect(row!.deleted_at).not.toBeNull();
    expect(row!.text).toBe(SECRET);
  });

  test("tombstones expose that a message existed and nothing of what it said", async () => {
    await reset();
    await q.upsertMessage(db, secretMessage("1.02", { threadTs: "1.01", userId: "U1" }));
    await q.upsertMessage(db, message("1.03", { threadTs: "1.01", userId: "U1" }));
    await q.markMessageDeleted(db, channelId, "1.02");

    const tombstones = await q.listTombstones(db, channelId, { userId: "U1" });
    expect(tombstones.map((t) => t.slackTs)).toEqual(["1.02"]);
    expect(tombstones[0]!.deletedAt).toBeInstanceOf(Date);
    expect(Object.keys(tombstones[0]!).sort()).toEqual(
      ["channelId", "deletedAt", "slackTs", "threadTs", "timestamp", "userId"].sort(),
    );
    expect(JSON.stringify(tombstones)).not.toContain(SECRET);
    expect(JSON.stringify(tombstones)).not.toContain(METADATA_SECRET);
  });

  test("a message_deleted event tombstones the message it names", async () => {
    await reset();
    await q.upsertMessage(db, secretMessage("1.01"));
    expect(await handleMessageDeleted(db, { channel: channelId, deleted_ts: "1.01" })).toBe(true);
    expect(await q.getMessageBySlackTs(db, channelId, "1.01")).toBeNull();
    // Malformed events, or a repeat, do nothing.
    expect(await handleMessageDeleted(db, {})).toBe(false);
    expect(await handleMessageDeleted(db, { channel: channelId })).toBe(false);
    expect(await handleMessageDeleted(db, { channel: channelId, deleted_ts: "1.01" })).toBe(false);
  });

  describe("reconcile", () => {
    const slackReturning = (
      pages: Array<Array<{ ts: string; subtype?: string }>>,
    ): RepliesClient & { calls: number } => {
      const client = {
        calls: 0,
        conversations: {
          async replies() {
            const page = pages[client.calls++] ?? [];
            return {
              messages: page,
              response_metadata: {
                next_cursor: client.calls < pages.length ? `cursor-${client.calls}` : "",
              },
            };
          },
        },
      };
      return client;
    };

    async function seedThread() {
      await reset();
      await q.upsertMessage(db, message("1.01"));
      await q.upsertMessage(db, secretMessage("1.02", { threadTs: "1.01" }));
      await q.upsertMessage(db, message("1.03", { threadTs: "1.01" }));
    }

    test("marks stored replies Slack no longer returns, across pages", async () => {
      await seedThread();
      const slack = slackReturning([[{ ts: "1.01" }], [{ ts: "1.03" }]]);
      const result = await reconcileThreadDeletions(db, slack, channelId, "1.01");
      expect(result).toEqual({ deleted: ["1.02"], complete: true });
      expect(slack.calls).toBe(2);
      expect(await everythingReadable()).not.toContain(SECRET);
      expect((await q.getMessages(db, channelId)).map((m) => m.slackTs).sort()).toEqual(["1.01", "1.03"]);
    });

    test("is idempotent", async () => {
      await seedThread();
      const first = await reconcileThreadDeletions(db, slackReturning([[{ ts: "1.01" }, { ts: "1.03" }]]), channelId, "1.01");
      const second = await reconcileThreadDeletions(db, slackReturning([[{ ts: "1.01" }, { ts: "1.03" }]]), channelId, "1.01");
      expect(first.deleted).toEqual(["1.02"]);
      expect(second).toEqual({ deleted: [], complete: true });
    });

    test("marks nothing when Slack errors, so a live comment is never hidden by a failure", async () => {
      await seedThread();
      const failing: RepliesClient = {
        conversations: {
          async replies() {
            throw Object.assign(new Error("ratelimited"), { data: { error: "ratelimited" } });
          },
        },
      };
      expect(await reconcileThreadDeletions(db, failing, channelId, "1.01")).toEqual({ deleted: [], complete: false });
      expect(await q.getMessageCount(db, channelId)).toBe(3);
    });

    test("marks nothing on an empty answer or when pages never end", async () => {
      await seedThread();
      expect(await reconcileThreadDeletions(db, slackReturning([[]]), channelId, "1.01")).toEqual({ deleted: [], complete: false });
      const endless: RepliesClient = {
        conversations: {
          async replies() {
            return { messages: [{ ts: "1.01" }], response_metadata: { next_cursor: "more" } };
          },
        },
      };
      expect(await reconcileThreadDeletions(db, endless, channelId, "1.01")).toEqual({ deleted: [], complete: false });
      expect(await q.getMessageCount(db, channelId)).toBe(3);
    });

    test("treats Slack's tombstone placeholder for a deleted root as deleted", async () => {
      await seedThread();
      const slack = slackReturning([[{ ts: "1.01", subtype: "tombstone" }, { ts: "1.02" }, { ts: "1.03" }]]);
      const result = await reconcileThreadDeletions(db, slack, channelId, "1.01");
      expect(result.deleted).toEqual(["1.01"]);
      expect((await q.getMessages(db, channelId)).map((m) => m.slackTs).sort()).toEqual(["1.02", "1.03"]);
    });

    test("thread_not_found marks the root only", async () => {
      await seedThread();
      const gone: RepliesClient = {
        conversations: {
          async replies() {
            throw Object.assign(new Error("thread_not_found"), { data: { error: "thread_not_found" } });
          },
        },
      };
      expect(await reconcileThreadDeletions(db, gone, channelId, "1.01")).toEqual({ deleted: ["1.01"], complete: true });
      expect((await q.getMessages(db, channelId)).map((m) => m.slackTs).sort()).toEqual(["1.02", "1.03"]);
    });
  });

  // The API, feeds and the Slack events endpoint, end to end.
  describe("through the HTTP API", () => {
    const env = {
      DATABASE_URL: url,
      SLACK_SIGNING_SECRET: "test-signing-secret",
      SLACK_BOT_TOKEN: "xoxb-test",
      BETTER_AUTH_SECRET: "test-better-auth-secret-0123456789abcdef",
      BETTER_AUTH_URL: "http://localhost:8080",
    } as any;

    // The messages API needs a key. Like the Slack columns' keys, it is scoped
    // to the channel.
    let bearer = "";
    let keyId = 0;
    beforeAll(async () => {
      const { fullKey, keyPrefix, secretHash } = generateApiKey();
      const [key] = await db
        .insert(schema.apiKeys)
        .values({ name: `deleted-messages-test-${suffix}`, keyPrefix, secretHash: await secretHash })
        .returning({ id: schema.apiKeys.id });
      keyId = key!.id;
      await db.insert(schema.apiKeyChannels).values({ keyId, channelId });
      bearer = fullKey;
    });
    afterAll(async () => {
      await raw`delete from api_key_channels where key_id = ${keyId}`;
      await raw`delete from api_keys where id = ${keyId}`;
    });

    async function get(path: string): Promise<{ status: number; body: string }> {
      const res = await app.request(
        path,
        { headers: { Accept: "application/json", Authorization: `Bearer ${bearer}` } },
        env,
      );
      return { status: res.status, body: await res.text() };
    }

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
      const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`));
      const hex = Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, "0")).join("");
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

    const CARD = "Welcome https://news.example.dev/news/leak-test/?ref=slack-bot";
    const paths = () => [
      `/api/threads?channel=${channelId}&key=/news/leak-test/`,
      `/api/threads?channel=${channelId}&key=/news/leak-test/&perDay=2&total=3&viewer=U1`,
      `/api/messages?channel=${channelId}`,
      `/api/messages?channel=${channelId}&limit=200`,
      `/api/messages?channel=${channelId}&threadTs=1.01`,
      `/api/messages?channel=${channelId}&userId=U1`,
      `/feed/${channelId}`,
      `/feed/${channelId}.json`,
    ];

    test("a deleted message is served by no endpoint, and the live ones still are", async () => {
      await reset();
      await q.upsertMessage(db, message("1.01", { text: CARD, formattedText: CARD }));
      await q.upsertMessage(db, secretMessage("1.02", { threadTs: "1.01" }));
      await q.upsertMessage(db, message("1.03", { threadTs: "1.01" }));

      // Control: before the delete, the endpoints do serve the message, so the
      // assertions below are not passing on an error page.
      const before = await get(`/api/messages/1.02?channel=${channelId}`);
      expect(before.status).toBe(200);
      expect(before.body).toContain(SECRET);
      for (const path of paths()) {
        const response = await get(path);
        expect(response.status, path).toBe(200);
        expect(response.body, path).toContain("live 1.03");
      }

      await q.markMessageDeleted(db, channelId, "1.02");

      const single = await get(`/api/messages/1.02?channel=${channelId}`);
      expect(single.status).toBe(404);
      expect(single.body).not.toContain(SECRET);
      for (const path of paths()) {
        const response = await get(path);
        expect(response.status, path).toBe(200);
        expect(response.body, path).not.toContain(SECRET);
        expect(response.body, path).not.toContain(FORMATTED_SECRET);
        expect(response.body, path).not.toContain(METADATA_SECRET);
        expect(response.body, path).toContain("live 1.03");
      }
    });

    test("a Slack message_deleted event hides the message from every endpoint", async () => {
      await reset();
      await q.upsertMessage(db, message("1.01", { text: CARD, formattedText: CARD }));
      await q.upsertMessage(db, secretMessage("1.02", { threadTs: "1.01" }));
      await q.upsertMessage(db, message("1.03", { threadTs: "1.01" }));
      expect((await get(`/api/messages/1.02?channel=${channelId}`)).status).toBe(200);

      const res = await signedEvent({
        type: "message",
        subtype: "message_deleted",
        channel: channelId,
        deleted_ts: "1.02",
        ts: "1.99",
        previous_message: { ts: "1.02", thread_ts: "1.01", text: SECRET },
      });
      expect(res.status).toBe(200);

      expect((await get(`/api/messages/1.02?channel=${channelId}`)).status).toBe(404);
      for (const path of paths()) {
        const response = await get(path);
        expect(response.body, path).not.toContain(SECRET);
      }
      const [row] = await raw`select deleted_at from messages where channel_id = ${channelId} and slack_ts = '1.02'`;
      expect(row!.deleted_at).not.toBeNull();
    });

    test("a deletion event for a message from before the content existed here is harmless", async () => {
      await reset();
      const res = await signedEvent({ type: "message", subtype: "message_deleted", channel: channelId, deleted_ts: "7.77" });
      expect(res.status).toBe(200);
      expect(await q.getMessageCount(db, channelId)).toBe(0);
    });
  });
});
