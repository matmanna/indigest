import { describe, expect, test } from "bun:test";
import {
  canAccessFeed,
  hasChannelPing,
  isLinkOnly,
  isMessageEmpty,
  isSlackPermalink,
  shouldForward,
} from "../src/app";
import { generateApiKey, hashSecret, verifySecret } from "../src/lib/api-keys";
import { parseBool, toBool } from "../src/db/queries";

const channel = (accessPermUsers = ["*"]) => ({
  id: "C1", name: "feed", teamId: "T1", enabled: true, linkMode: false,
  webhookUrl: "", autoApproveUsers: [], approvedPosters: [], accessPermUsers,
  trackReplies: false, metadataSchema: "", createdAt: "",
});
const msg = (text: string) => ({ slackTs: "1.1", channelId: "C1", userId: "U1", userName: "u", text, timestamp: new Date().toISOString(), metadata: {} });

describe("pure helpers", () => {
  test("recognizes Slack permalinks", () => {
    expect(isSlackPermalink("https://hackclub.slack.com/archives/C1/p123")).toBe(true);
    expect(isSlackPermalink("https://team.slack.com/archives/C1/p123")).toBe(true);
    expect(isSlackPermalink("https://example.com/archives/C1/p123")).toBe(false);
  });
  test("recognizes link-only text", () => {
    expect(isLinkOnly(" https://example.com/a ")).toBe(true);
    expect(isLinkOnly("read https://example.com/a")).toBe(false);
  });
  test("recognizes empty messages", () => {
    expect(isMessageEmpty("")).toBe(true);
    expect(isMessageEmpty(" \n\t")).toBe(true);
    expect(isMessageEmpty("<https://example.com|x>")).toBe(false);
  });
  test("documents ping behavior (raw Slack syntax only)", () => {
    expect(hasChannelPing("<!here>")).toBe(true);
    expect(hasChannelPing("here")).toBe(false);
  });
  test("forward policy prioritizes permalinks and empty messages", async () => {
    const db = {};
    expect(await shouldForward(msg("https://hackclub.slack.com/archives/C1/p123"), db)).toBe(true);
    expect(await shouldForward(msg("https://example.com"), db)).toBe(false);
    expect(await shouldForward(msg("   "), db)).toBe(true);
  });
  test("enforces public and restricted feed access", () => {
    expect(canAccessFeed(channel(), null)).toBe(true);
    expect(canAccessFeed(channel(["U123"]), { type: "session", slackId: "U123" })).toBe(true);
    expect(canAccessFeed(channel(["U123"]), { type: "session", slackId: "U999" })).toBe(false);
    expect(canAccessFeed(channel(["U123"]), null)).toBe(false);
    expect(canAccessFeed(channel(["U123"]), { type: "apikey", slackId: "U999", channelIds: ["C1"] })).toBe(true);
  });
  test("parses persisted boolean representations without throwing", () => {
    for (const value of ["0", "1", "true", "false", "public"]) {
      expect(() => parseBool(value)).not.toThrow();
      expect(() => toBool(value)).not.toThrow();
    }
    expect(parseBool("1")).toBe(true);
    expect(parseBool("0")).toBe(false);
  });
  test("generates and verifies API keys", async () => {
    const key = generateApiKey();
    expect(key.fullKey.startsWith("ind_")).toBe(true);
    expect(key.fullKey).toHaveLength(52);
    expect(key.keyPrefix).toHaveLength(12);
    expect(await verifySecret(key.fullKey, await key.secretHash)).toBe(true);
    expect(await verifySecret(`${key.fullKey}x`, await hashSecret(key.fullKey))).toBe(false);
  });
});
