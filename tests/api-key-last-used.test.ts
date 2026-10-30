import { afterAll, beforeAll, describe, expect, test } from "vitest";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { authenticateApiKey, generateApiKey } from "../src/lib/api-keys";

const url =
  process.env.TEST_DATABASE_URL ||
  "postgres://indigest:indigest@localhost:5433/indigest_test";

describe.skipIf(!process.env.TEST_DATABASE_URL)("recording when an API key was last used", () => {
  const raw = postgres(url, { max: 1 });
  const db = getDb(url);
  let id = 0;
  let token = "";

  // Through the same driver the code under test uses: the column has no time
  // zone, and a different client would read and write it differently.
  const lastUsed = async () =>
    (await db.select({ at: schema.apiKeys.lastUsedAt }).from(schema.apiKeys).where(eq(schema.apiKeys.id, id)))[0]!.at;
  const setLastUsed = (date: Date | null) =>
    db.update(schema.apiKeys).set({ lastUsedAt: date }).where(eq(schema.apiKeys.id, id));

  beforeAll(async () => {
    const { fullKey, keyPrefix, secretHash } = generateApiKey();
    token = fullKey;
    const [row] = await db
      .insert(schema.apiKeys)
      .values({ name: `last-used-test-${Date.now()}`, keyPrefix, secretHash: await secretHash })
      .returning({ id: schema.apiKeys.id });
    id = row!.id;
  });

  afterAll(async () => {
    await raw`delete from api_keys where id = ${id}`;
    await raw.end();
  });

  test("a key never used is recorded, and the write is handed to defer when given one", async () => {
    await setLastUsed(null);
    const deferred: Promise<unknown>[] = [];
    const identity = await authenticateApiKey(token, url, (work) => void deferred.push(work));
    expect(identity.id).toBe(id);
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
    expect(await lastUsed()).toBeInstanceOf(Date);
  });

  test("without defer the write finishes before the key is returned", async () => {
    await setLastUsed(null);
    await authenticateApiKey(token, url);
    expect(await lastUsed()).toBeInstanceOf(Date);
  });

  test("a key used within the last minute is not written again", async () => {
    const recent = new Date(Date.now() - 10_000);
    await setLastUsed(recent);
    const deferred: Promise<unknown>[] = [];
    await authenticateApiKey(token, url, (work) => void deferred.push(work));
    expect(deferred).toHaveLength(0);
    expect((await lastUsed())!.getTime()).toBe(recent.getTime());
  });

  test("an older record is brought up to date", async () => {
    const old = new Date(Date.now() - 5 * 60_000);
    await setLastUsed(old);
    await authenticateApiKey(token, url);
    expect((await lastUsed())!.getTime()).toBeGreaterThan(old.getTime() + 60_000);
  });

  test("a revoked or unknown key is still refused", async () => {
    await expect(authenticateApiKey("ind_notarealkeyatall000000000", url)).rejects.toThrow();
    await raw`update api_keys set revoked_at = now() where id = ${id}`;
    await expect(authenticateApiKey(token, url)).rejects.toThrow(/revoked/);
  });
});
