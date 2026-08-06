import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type DB = ReturnType<typeof drizzle<typeof schema>>;

export function getDb(databaseUrl: string): DB {
  const client = postgres(databaseUrl, {
    max: 1,
    onnotice: () => {},
    idle_timeout: 0,
    connect_timeout: 10,
  });
  return drizzle(client, { schema });
}
