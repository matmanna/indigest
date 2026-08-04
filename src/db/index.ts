import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// postgres driver — direct TCP, works with this Orchard database.
// Each call creates a fresh client (no I/O reuse across Worker requests).
export function getDb(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  return drizzle(client, { schema });
}
