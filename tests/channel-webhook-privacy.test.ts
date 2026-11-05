import { afterAll, describe, expect, mock, test } from "bun:test";

const SECRET = "https://hooks.example.com/receive?token=s3cret";
const channel = (id: string, webhookUrl: string) => ({
  id,
  name: id,
  teamId: "T1",
  enabled: true,
  linkMode: false,
  webhookUrl,
  autoApproveUsers: [],
  manualUsers: [],
  triggerMode: "message",
  approvedPosters: [],
  accessPermUsers: ["*"],
  trackReplies: false,
  metadataSchema: "",
  metadataRequired: false,
  properties: "{}",
  staticMetadata: "",
  createdAt: "2026-01-01T00:00:00.000Z",
});
const channels = [channel("C1", SECRET), channel("C2", "")];

// The mock is process-wide: put the real queries back for the database tests.
const realQueries = { ...(await import("../src/db/queries")) };
afterAll(() => {
  mock.module("../src/db/queries", () => realQueries);
});
mock.module("../src/db/queries", () => ({
  ...realQueries,
  getChannel: async (_db: unknown, id: string) => channels.find((c) => c.id === id),
  listChannels: async () => channels,
  listEnabledChannels: async () => channels,
}));

const { OpenAPIHandler } = await import("@orpc/openapi/fetch");
const { router } = await import("../src/api/router");
const handler = new OpenAPIHandler(router);

/** Calls the API as `slackId` (null = signed out). UADMIN is a lockdown admin. */
async function get(path: string, slackId: string | null) {
  const { response } = await handler.handle(new Request(`http://x/api${path}`), {
    prefix: "/api",
    context: {
      db: {} as any,
      session: slackId ? { user: { id: "u", name: "", email: "", slackId } } : null,
      apiKey: null,
      databaseUrl: "",
      slackToken: "",
      lockdownUsers: ["UADMIN"],
    } as any,
  });
  expect(response?.status).toBe(200);
  return response!.json() as Promise<any>;
}

describe("webhook URLs are only shown to channel managers", () => {
  test("the public channel list hides them but says whether one is set", async () => {
    for (const who of [null, "UOTHER", "UADMIN"]) {
      const list = await get("/channels", who);
      expect(JSON.stringify(list)).not.toContain("s3cret");
      expect(list.map((c: any) => [c.id, c.webhookUrl, c.hasWebhook])).toEqual([
        ["C1", "", true],
        ["C2", "", false],
      ]);
    }
  });

  test("a single channel shows the URL to managers only", async () => {
    expect((await get("/channels/C1", null)).webhookUrl).toBe("");
    expect((await get("/channels/C1", "UOTHER")).webhookUrl).toBe("");
    const managed = await get("/channels/C1", "UADMIN");
    expect(managed.webhookUrl).toBe(SECRET);
    expect(managed.hasWebhook).toBe(true);
  });

  test("the manageable list hides URLs of channels the caller can't manage", async () => {
    const other = await get("/channels/manageable", "UOTHER");
    expect(JSON.stringify(other)).not.toContain("s3cret");
    const admin = await get("/channels/manageable", "UADMIN");
    expect(admin.channels.find((c: any) => c.id === "C1").webhookUrl).toBe(SECRET);
  });
});
