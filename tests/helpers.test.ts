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
  resolveMessageAdmission,
  resolvePublishDisposition,
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
  webhookUrl: "", autoApproveUsers: [], manualUsers: [], triggerMode: "message" as const, approvedPosters: [], accessPermUsers,
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
  describe("resolvePublishDisposition", () => {
    const ch = (auto = [], manual = []) => ({ autoApproveUsers: auto, manualUsers: manual });
    test("prompts everyone when no whitelist is configured", () => {
      expect(resolvePublishDisposition(ch(), "U1")).toBe("prompt");
      expect(resolvePublishDisposition(ch(["U2"]), "U1")).toBe("drop");
      expect(resolvePublishDisposition(ch([], ["U2"]), "U1")).toBe("drop");
    });
    test("auto-approves a whitelisted user and drops everyone else", () => {
      expect(resolvePublishDisposition(ch(["U1"]), "U1")).toBe("auto");
      expect(resolvePublishDisposition(ch(["U1"]), "U2")).toBe("drop");
      expect(resolvePublishDisposition(ch(["U1", "U2"]), "U2")).toBe("auto");
      expect(resolvePublishDisposition(ch(["U1", "U2"]), "U3")).toBe("drop");
    });
    test("auto-approves all users when the list contains *", () => {
      expect(resolvePublishDisposition(ch(["*"]), "U1")).toBe("auto");
      expect(resolvePublishDisposition(ch(["*"]), "U999")).toBe("auto");
      expect(resolvePublishDisposition(ch(["*", "U1"]), "U2")).toBe("auto");
    });
    test("prompts a manual-whitelisted user and drops everyone else", () => {
      expect(resolvePublishDisposition(ch([], ["U1"]), "U1")).toBe("prompt");
      expect(resolvePublishDisposition(ch([], ["U1"]), "U2")).toBe("drop");
    });
    test("keeps auto and manual whitelists independent", () => {
      const both = ch(["UA"], ["UM"]);
      expect(resolvePublishDisposition(both, "UA")).toBe("auto");
      expect(resolvePublishDisposition(both, "UM")).toBe("prompt");
      expect(resolvePublishDisposition(both, "UX")).toBe("drop");
    });
    test("treats a user on both lists as auto", () => {
      expect(resolvePublishDisposition(ch(["U1"], ["U1"]), "U1")).toBe("auto");
    });
    test("ignores empty strings in persisted lists", () => {
      expect(resolvePublishDisposition(ch([""]), "U1")).toBe("prompt");
      expect(resolvePublishDisposition(ch(["U1", ""]), "U2")).toBe("drop");
      expect(resolvePublishDisposition(ch([""], [""]), "")).toBe("prompt");
    });
    test("a user may not be dropped when a whitelist is present", () => {
      for (const userId of ["U1", "U2", "U3"]) {
        const result = resolvePublishDisposition(ch(["U1"], ["U2"]), userId);
        expect(["auto", "prompt", "drop"]).toContain(result);
        if (userId === "U3") expect(result).toBe("drop");
      }
    });
    test("accepts multiple candidate identities and matches on any of them", () => {
      expect(resolvePublishDisposition(ch(["B1"]), [undefined, "B1"])).toBe("auto");
      expect(resolvePublishDisposition(ch([], ["B1"]), ["U1", "B1"])).toBe("prompt");
      expect(resolvePublishDisposition(ch(["U1"]), [undefined, "B1"])).toBe("drop");
    });
  });
  describe("resolveMessageAdmission", () => {
    const admit = (
      overrides: Partial<Parameters<typeof resolveMessageAdmission>[0]>,
    ) =>
      resolveMessageAdmission({
        subtype: undefined,
        user: "U1",
        botId: undefined,
        selfUserId: "SELF",
        selfBotId: "BSELF",
        autoApproveUsers: [],
        manualUsers: [],
        triggerMode: "message",
        ...overrides,
      });

    test("rejects every message when trigger mode is shortcut, even for a whitelisted user", () => {
      expect(
        admit({ triggerMode: "shortcut", autoApproveUsers: ["*"] }),
      ).toEqual({ allowed: false, reason: "shortcut-only" });
    });

    test("admits a normal human message and applies disposition", () => {
      const human = admit({});
      expect(human).toEqual({ allowed: true, disposition: "prompt" });
      expect(
        admit({ autoApproveUsers: ["*"], user: "U9" }),
      ).toEqual({ allowed: true, disposition: "auto" });
      expect(
        admit({ autoApproveUsers: ["U1"], user: "U2" }),
      ).toEqual({ allowed: true, disposition: "drop" });
    });
    test("admits a whitelisted bot message with the matching disposition", () => {
      const manualBot = admit({ subtype: "bot_message", user: "UBOT", manualUsers: ["UBOT"] });
      expect(manualBot).toEqual({ allowed: true, disposition: "prompt" });
      const autoBot = admit({ subtype: "bot_message", user: "UBOT", autoApproveUsers: ["UBOT"] });
      expect(autoBot).toEqual({ allowed: true, disposition: "auto" });
      expect(
        admit({ subtype: "bot_message", user: "UBOT", autoApproveUsers: ["*"] }),
      ).toEqual({ allowed: true, disposition: "auto" });
    });
    test("drops bot messages that are not whitelisted", () => {
      const result = admit({ subtype: "bot_message", user: "UBOT" });
      expect(result).toEqual({ allowed: false, reason: "unwhitelisted bot" });
      expect(
        admit({ subtype: "bot_message", user: "UBOT", manualUsers: ["UOTHER"], autoApproveUsers: ["UOTHER"] }),
      ).toEqual({ allowed: false, reason: "unwhitelisted bot" });
    });
    test("drops a bot message with no user identity that can't match a whitelist", () => {
      const result = admit({ subtype: "bot_message", user: undefined, botId: "B1", manualUsers: ["UBOT"] });
      expect(result).toEqual({ allowed: false, reason: "unwhitelisted bot" });
    });
    test("admits a bot message with no user field when its bot ID is whitelisted", () => {
      const manual = admit({ subtype: "bot_message", user: undefined, botId: "B1", manualUsers: ["B1"] });
      expect(manual).toEqual({ allowed: true, disposition: "prompt" });
      const auto = admit({ subtype: "bot_message", user: undefined, botId: "B1", autoApproveUsers: ["B1"] });
      expect(auto).toEqual({ allowed: true, disposition: "auto" });
    });
    test("never admits the indigest bot's own messages, even with * auto-approve", () => {
      expect(admit({ subtype: "bot_message", user: "SELF", autoApproveUsers: ["*"] }))
        .toEqual({ allowed: false, reason: "self-authored" });
      expect(admit({ subtype: "bot_message", botId: "BSELF", user: undefined, autoApproveUsers: ["*"] }))
        .toEqual({ allowed: false, reason: "self-authored" });
    });
    test("self check runs before the whitelist, so self is never published", () => {
      expect(admit({ subtype: "bot_message", user: "SELF", manualUsers: ["SELF"], autoApproveUsers: ["SELF"] }))
        .toEqual({ allowed: false, reason: "self-authored" });
      expect(admit({ user: "SELF", autoApproveUsers: ["*"] }))
        .toEqual({ allowed: false, reason: "self-authored" });
    });
    test("drops every subtype that is not a plain message or bot_message", () => {
      for (const subtype of ["channel_join", "channel_leave", "group_join", "thread_broadcast", "file_share"]) {
        expect(admit({ subtype })).toEqual({ allowed: false, reason: `unhandled subtype ${subtype}` });
      }
    });
    test("disposition for admitted bot events matches the disposition as a human", () => {
      const auto = ["UA"];
      const manual = ["UM"];
      for (const uid of ["UA", "UM"]) {
        const asHuman = admit({ autoApproveUsers: auto, manualUsers: manual, user: uid, subtype: undefined });
        const asBot = admit({ autoApproveUsers: auto, manualUsers: manual, user: uid, subtype: "bot_message", botId: "B_" + uid });
        expect(asHuman).toEqual({ allowed: true, disposition: asHuman.disposition });
        expect(asBot).toEqual(asHuman);
      }
      expect(admit({ autoApproveUsers: auto, manualUsers: manual, user: "UX", subtype: undefined }))
        .toEqual({ allowed: true, disposition: "drop" });
      expect(admit({ autoApproveUsers: auto, manualUsers: manual, user: "UX", subtype: "bot_message" }))
        .toEqual({ allowed: false, reason: "unwhitelisted bot" });
    });
  });
});
