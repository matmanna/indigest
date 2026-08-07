import { describe, expect, test } from "bun:test";
import postgres from "postgres";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../src/db/schema";

const sql = postgres(process.env.TEST_DATABASE_URL || "postgres://indigest:indigest@localhost:5433/indigest_test", { max: 1 });
const tables = [schema.channels, schema.messages, schema.subscriptions, schema.botActions, schema.apiKeys, schema.apiKeyChannels, schema.authUser, schema.authSession, schema.authAccount, schema.authVerification];

function kind(type: string): string {
  if (type.includes("character") || type === "text") return "text";
  if (type.includes("integer") || type === "bigint" || type === "smallint") return "integer";
  if (type === "boolean") return "boolean";
  if (type.startsWith("timestamp")) return "timestamp";
  return type;
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("database schema drift", () => {
  test("all Drizzle columns exist in PostgreSQL with matching types, and vice versa", async () => {
    const dbRows = await sql<{ table_name: string; column_name: string; data_type: string }[]>`
      select table_name, column_name, data_type
      from information_schema.columns
      where table_schema = 'public'
      order by table_name, ordinal_position
    `;
    const actual = new Map(dbRows.map((r) => [`${r.table_name}.${r.column_name}`, kind(r.data_type)]));
    const expected = new Map<string, string>();
    for (const table of tables) {
      const config = getTableConfig(table);
      for (const column of config.columns) expected.set(`${config.name}.${column.name}`, kind(column.getSQLType()));
    }
    expect([...expected.keys()].filter((key) => !actual.has(key))).toEqual([]);
    expect([...actual.keys()].filter((key) => expected.has(key) === false && tables.some((t) => getTableConfig(t).name === key.split(".")[0]))).toEqual([]);
    const mismatches = [...expected].filter(([key, type]) => actual.has(key) && actual.get(key) !== type).map(([key, type]) => `${key}: expected ${type}, got ${actual.get(key)}`);
    expect(mismatches).toEqual([]);
  });
});
