import { afterAll, describe, expect, mock, test } from "bun:test";

const channel = (id: string, accessPermUsers: string[]) => ({
  id,
  name: id,
  enabled: true,
  accessPermUsers,
});

// Copy the real exports first: the mock below is process-wide, and the
// database tests need the real queries back once this file is done.
const realQueries = { ...(await import("../src/db/queries")) };
afterAll(() => {
  mock.module("../src/db/queries", () => realQueries);
});

mock.module("../src/db/queries", () => ({
  getChannel: async (_db: unknown, id: string) =>
    ({ C1: channel("C1", ["U_OWNER"]), C2: channel("C2", ["*"]) })[id],
  getMessages: async () => [],
  getMessageCount: async () => 0,
  getMessageBySlackTs: async () => ({ slackTs: "1.0" }),
}));

const { resolveDelegatedScope, isRevoked } =
  await import("../src/lib/api-keys");
const { childKeyName, strandedSubkeys } = await import(
  "../src/api/routers/apiKeys"
);
const { OpenAPIHandler } = await import("@orpc/openapi/fetch");
const { router } = await import("../src/api/router");

const parent = { canDelegate: true, parentId: null, channelIds: ["C1", "C2"] };

describe("delegated key scope", () => {
  test("defaults to the parent's full scope", () => {
    expect(resolveDelegatedScope(parent, undefined)).toEqual(["C1", "C2"]);
  });
  test("may narrow the parent's scope", () => {
    expect(resolveDelegatedScope(parent, ["C2", "C2"])).toEqual(["C2"]);
  });
  test("may not widen the parent's scope", () => {
    expect(() => resolveDelegatedScope(parent, ["C1", "C9"])).toThrow(/C9/);
  });
  test("non-delegating keys cannot mint", () => {
    expect(() =>
      resolveDelegatedScope({ ...parent, canDelegate: false }, undefined),
    ).toThrow();
  });
  test("child keys cannot mint grandchildren", () => {
    expect(() =>
      resolveDelegatedScope({ ...parent, parentId: 7 }, undefined),
    ).toThrow();
  });
  test("unscoped delegating keys cannot mint", () => {
    expect(() =>
      resolveDelegatedScope({ ...parent, channelIds: [] }, undefined),
    ).toThrow();
  });
  test("child names are namespaced under the parent", () => {
    expect(childKeyName("slacker-news", "U123")).toBe("slacker-news/U123");
  });
});

describe("narrowing a delegating key", () => {
  const subkeys = new Map([
    [1, ["C1"]],
    [2, ["C1", "C2"]],
    [3, ["C2"]],
  ]);
  test("only subkeys losing every channel are stranded", () => {
    expect(strandedSubkeys(subkeys, ["C1"])).toEqual([1]);
  });
  test("removing the whole scope strands every subkey", () => {
    expect(strandedSubkeys(subkeys, ["C1", "C2"])).toEqual([1, 2, 3]);
  });
  test("removing nothing strands nothing", () => {
    expect(strandedSubkeys(subkeys, [])).toEqual([]);
  });
});

describe("revocation", () => {
  test("revokedAt or legacy revokedBy both revoke", () => {
    expect(isRevoked({ revokedAt: null, revokedBy: null })).toBe(false);
    expect(isRevoked({ revokedAt: new Date(), revokedBy: null })).toBe(true);
    expect(isRevoked({ revokedAt: null, revokedBy: "user" })).toBe(true);
  });
});

describe("oRPC message routes enforce channel access", () => {
  const handler = new OpenAPIHandler(router);
  const call = (path: string, slackId: string) =>
    handler.handle(new Request(`http://x/api${path}`), {
      prefix: "/api",
      context: {
        db: {} as any,
        session: { user: { id: "u", name: "", email: "", slackId } },
        apiKey: null,
        databaseUrl: "",
        slackToken: "",
        lockdownUsers: [],
      },
    });

  test("listing a restricted channel is forbidden to other users", async () => {
    const { response } = await call("/messages?channel=C1", "U_OTHER");
    expect(response?.status).toBe(403);
  });
  test("fetching one message from a restricted channel is forbidden", async () => {
    const { response } = await call("/messages/1.0?channel=C1", "U_OTHER");
    expect(response?.status).toBe(403);
  });
  test("permitted users and public channels are allowed", async () => {
    expect(
      (await call("/messages?channel=C1", "U_OWNER")).response?.status,
    ).toBe(200);
    expect(
      (await call("/messages?channel=C2", "U_OTHER")).response?.status,
    ).toBe(200);
  });
});
