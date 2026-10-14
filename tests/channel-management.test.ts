import { describe, expect, it } from "vitest";
import { canManageChannel, manageableChannelIds } from "../src/api/context";
import { applyChannelPatch } from "../src/api/routers/channels";
import type { Channel } from "../src/db/queries";

const base: Channel = {
  id: "C1",
  name: "test",
  teamId: "T1",
  enabled: true,
  linkMode: false,
  webhookUrl: "",
  autoApproveUsers: [],
  manualUsers: [],
  triggerMode: "message",
  approvedPosters: [],
  accessPermUsers: ["*"],
  trackReplies: false,
  metadataSchema: "",
  metadataRequired: false,
  properties: "{}",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("canManageChannel", () => {
  // No Slack token, so the channel-manager lookup can't grant access.
  const ctx = (lockdownUsers: string[]) => ({ lockdownUsers, slackToken: "" });

  it("lets lockdown users manage any channel", async () => {
    expect(await canManageChannel(ctx(["UADMIN"]), "C1", "UADMIN")).toBe(true);
  });

  it("refuses everyone else while lockdown is on", async () => {
    expect(await canManageChannel(ctx(["UADMIN"]), "C1", "UOTHER")).toBe(false);
  });

  it("refuses sessions without a Slack ID", async () => {
    expect(await canManageChannel(ctx([]), "C1", null)).toBe(false);
  });

  it("lists every channel as manageable for lockdown users only", async () => {
    expect([...(await manageableChannelIds(ctx(["UADMIN"]), ["C1", "C2"], "UADMIN"))]).toEqual(["C1", "C2"]);
    expect([...(await manageableChannelIds(ctx(["UADMIN"]), ["C1", "C2"], "UOTHER"))]).toEqual([]);
  });
});

describe("applyChannelPatch", () => {
  it("only changes the fields given", () => {
    const next = applyChannelPatch(base, { linkMode: true });
    expect(next).toEqual({ ...base, linkMode: true });
  });

  it("collapses lists containing * to just *", () => {
    const next = applyChannelPatch(base, { accessPermUsers: ["U1", "*", "U1"] });
    expect(next.accessPermUsers).toEqual(["*"]);
  });

  it("stores compact JSON and resets cleared properties to {}", () => {
    expect(applyChannelPatch(base, { properties: '{\n  "a": 1\n}' }).properties).toBe('{"a":1}');
    expect(applyChannelPatch(base, { properties: "" }).properties).toBe("{}");
    expect(applyChannelPatch(base, { metadataSchema: "" }).metadataSchema).toBe("");
  });
});
