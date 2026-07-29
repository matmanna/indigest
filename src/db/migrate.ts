import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

export async function pushSchema(connectionString: string) {
  const client = postgres(connectionString, { max: 1 });
  const db = drizzle(client);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      team_id TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 0,
      webhook_url TEXT NOT NULL DEFAULT '',
      auto_approve_users TEXT NOT NULL DEFAULT '',
      approved_posters TEXT NOT NULL DEFAULT '',
      track_replies INTEGER NOT NULL DEFAULT 0,
      metadata_schema TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      slack_ts TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '',
      user_name TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      thread_ts TEXT,
      timestamp TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'
    )
  `);

  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_channel_ts ON messages(channel_id, slack_ts)
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_messages_channel_ts ON messages(channel_id, timestamp DESC)
  `);

  // Add columns if they don't exist (for existing DBs) — each in try/catch so one failure doesn't block others
  const alters: Array<[string, any]> = [
    ["auto_approve_users", sql`ALTER TABLE channels ADD COLUMN IF NOT EXISTS auto_approve_users TEXT NOT NULL DEFAULT ''`],
    ["approved_posters", sql`ALTER TABLE channels ADD COLUMN IF NOT EXISTS approved_posters TEXT NOT NULL DEFAULT ''`],
    ["track_replies", sql`ALTER TABLE channels ADD COLUMN IF NOT EXISTS track_replies INTEGER NOT NULL DEFAULT 0`],
    ["metadata_schema", sql`ALTER TABLE channels ADD COLUMN IF NOT EXISTS metadata_schema TEXT NOT NULL DEFAULT ''`],
    ["metadata", sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'`],
    ["thread_ts", sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_ts TEXT`],
  ];
  for (const [col, query] of alters) {
    try {
      await db.execute(query);
    } catch (err: any) {
      console.error(`pushSchema: failed to add column ${col}:`, err.message);
    }
  }

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      subscriber_channel_id TEXT NOT NULL,
      source_channel_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_subscriptions ON subscriptions(subscriber_channel_id, source_channel_id)
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_subscriptions_source ON subscriptions(source_channel_id)
  `);

  await client.end();
}
