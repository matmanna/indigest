import { describe, expect, test } from "vitest";
import {
  actorFor,
  canonical,
  diff,
  hashRow,
  verifyAuditChain,
  type HashedFields,
} from "../src/lib/audit";

const fields = (action: string, at: number): HashedFields => ({
  createdAt: new Date(at),
  action,
  outcome: "success",
  severity: "medium",
  source: "web",
  actorType: "user",
  actorId: "u1",
  actorName: "Mat",
  actorSlackId: "U1",
  targetType: "channel",
  targetId: "C1",
  targetName: "general",
  reason: null,
  changes: { patch: [{ op: "replace", path: "/linkMode", value: true }] },
  context: { ip: "1.2.3.4" },
});

async function chain(n: number) {
  const rows = [];
  let prev: string | null = null;
  for (let i = 0; i < n; i++) {
    const f = fields(`channel.update`, 1_700_000_000_000 + i * 1000);
    const hash = await hashRow(prev, f);
    rows.push({ id: i + 1, ...f, prevHash: prev, hash });
    prev = hash;
  }
  return rows;
}

describe("audit hash chain", () => {
  test("an untouched chain verifies", async () => {
    expect(await verifyAuditChain(await chain(4))).toBeNull();
  });

  test("editing a row is caught at that row", async () => {
    const rows = await chain(4);
    rows[2]!.actorName = "Someone else";
    expect(await verifyAuditChain(rows)).toBe(3);
  });

  test("deleting a row is caught at the row after it", async () => {
    const rows = await chain(4);
    rows.splice(1, 1);
    expect(await verifyAuditChain(rows)).toBe(3);
  });

  test("canonical JSON ignores key order, so jsonb round-trips hash the same", () => {
    expect(canonical({ b: 1, a: { d: 2, c: 3 } })).toBe(canonical({ a: { c: 3, d: 2 }, b: 1 }));
  });
});

describe("audit helpers", () => {
  test("diff redacts secrets", () => {
    const d = diff({ secretHash: "old", name: "a" }, { secretHash: "new", name: "b" });
    expect(JSON.stringify(d)).not.toContain("new");
    expect(d.patch.some((p) => p.path === "/name")).toBe(true);
  });

  test("actors come from the session first, then the API key", () => {
    expect(actorFor({ session: { user: { id: "u1", name: "Mat" } } })).toEqual({
      type: "user",
      id: "u1",
      displayName: "Mat",
    });
    expect(actorFor({ apiKey: { id: 7, name: "bot" } })).toEqual({
      type: "api",
      id: "api_key:7",
      displayName: "bot",
    });
  });
});
