import { describe, expect, test } from "vitest";
import {
  canAccessFeed,
  findExistingForward,
  hasProvidedMetadata,
  hasChannelPing,
  hasRecentSubstantiveMessage,
  isLinkOnly,
  isMessageEmpty,
  isSlackPermalink,
  metadataRequirementSatisfied,
  resolveSubProfileValue,
  shouldForward,
} from "../src/app";
import { generateApiKey, hashSecret, verifySecret } from "../src/lib/api-keys";
import {
  mergeAuthorLists,
  parseBool,
  splitAuthorList,
  toBool,
} from "../src/db/queries";

const channel = (accessPermUsers = ["*"]) => ({
  id: "C1", name: "feed", teamId: "T1", enabled: true, linkMode: false,
  webhookUrl: "", autoApproveUsers: [], approvedPosters: [], accessPermUsers,
  trackReplies: false, metadataSchema: "", metadataRequired: false, properties: "", createdAt: "",
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
    expect(hasChannelPing("<!channel>")).toBe(true);
    expect(hasChannelPing("<!everyone>")).toBe(true);
    expect(hasChannelPing("here")).toBe(false);
  });
  test("suppresses group pings after a recent substantive message", () => {
    const current = {
      slackTs: "2.2",
      text: "",
      rawText: "<!everyone>",
    };
    expect(
      hasRecentSubstantiveMessage(current, [
        { slackTs: "1.1", text: "announcement" },
      ]),
    ).toBe(true);
    expect(
      hasRecentSubstantiveMessage(current, [
        { slackTs: "1.1", text: "<!channel>" },
      ]),
    ).toBe(false);
  });
  test("forward policy prioritizes permalinks and empty messages", async () => {
    const db = {};
    expect(await shouldForward(msg("https://hackclub.slack.com/archives/C1/p123"), db)).toBe(true);
    expect(await shouldForward(msg("https://example.com"), db)).toBe(false);
    expect(await shouldForward(msg("   "), db)).toBe(true);
  });
  test("uses an existing pub bot action as the update target", () => {
    const action = {
      type: "pub",
      sourceChannelId: "C1",
      sourceMessageTs: "1.1",
      botChannelId: "C2",
      botMessageTs: "9.9",
      createdAt: "",
    };
    expect(findExistingForward([action], "C2")?.botMessageTs).toBe("9.9");
    expect(findExistingForward([{ ...action, type: "approve" }], "C2")).toBeUndefined();
    expect(findExistingForward([action], "C3")).toBeUndefined();
  });
  test("recognizes when metadata has actually been provided", () => {
    expect(hasProvidedMetadata({})).toBe(false);
    expect(hasProvidedMetadata({ title: "" })).toBe(false);
    expect(hasProvidedMetadata('{"title":"Launch"}')).toBe(true);
    expect(hasProvidedMetadata({ tags: ["news"] })).toBe(true);
    expect(metadataRequirementSatisfied(false, {})).toBe(true);
    expect(metadataRequirementSatisfied(true, {})).toBe(false);
    expect(metadataRequirementSatisfied(true, { title: "Launch" })).toBe(true);
  });
  test("normalizes comma-separated author lists", () => {
    expect(mergeAuthorLists("U_FORWARDER", "U_ORIGINAL", "U_FORWARDER")).toBe(
      "U_FORWARDER,U_ORIGINAL",
    );
    expect(splitAuthorList("U_FORWARDER, U_ORIGINAL")).toEqual([
      "U_FORWARDER",
      "U_ORIGINAL",
    ]);
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
  describe("resolveSubProfileValue", () => {
    const props = { title: "Hack Club", depth: { level: "3" }, tags: ["a", "b"] };
    test("returns static string verbatim", () => {
      expect(resolveSubProfileValue("Indigest Bot", props)).toBe("Indigest Bot");
      expect(resolveSubProfileValue("  spaced  ", props)).toBe("spaced");
    });
    test("returns null when unset", () => {
      expect(resolveSubProfileValue(undefined, props)).toBeNull();
      expect(resolveSubProfileValue("", props)).toBeNull();
      expect(resolveSubProfileValue(null, props)).toBeNull();
    });
    test("resolves a bracketed property from the channel properties map", () => {
      expect(resolveSubProfileValue("[title]", props)).toBe("Hack Club");
      expect(resolveSubProfileValue("[depth.level]", props)).toBe("3");
    });
    test("returns null when the referenced property is missing", () => {
      expect(resolveSubProfileValue("[missing]", props)).toBeNull();
      expect(resolveSubProfileValue("[missing]", null)).toBeNull();
      expect(resolveSubProfileValue("[title]", null)).toBeNull();
    });
  });
});
