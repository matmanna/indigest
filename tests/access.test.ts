import { describe, expect, test } from "bun:test";
import { canAccessFeed, canApproveMessage } from "../src/app";
import { canCreateApiKeyForChannel } from "../src/api/routers/apiKeys";

const feed = (users: string[]) => ({ id: "C1", name: "", teamId: "", enabled: true, linkMode: false, webhookUrl: "", autoApproveUsers: [], approvedPosters: [], accessPermUsers: users, trackReplies: false, metadataSchema: "", createdAt: "" });

describe("feed access invariants", () => {
  test("wildcard always allows", () => expect(canAccessFeed(feed(["*"]), null)).toBe(true));
  test("matching user allows and non-matching user denies", () => {
    expect(canAccessFeed(feed(["U123"]), { type: "session", slackId: "U123" })).toBe(true);
    expect(canAccessFeed(feed(["U123"]), { type: "session", slackId: "U999" })).toBe(false);
  });
  test("null identity is denied for restricted feeds", () => expect(canAccessFeed(feed(["U123"]), null)).toBe(false));
  test("an unspecified access list denies everyone except higher-level manager/lockdown bypasses", () => {
    const privateByDefault = feed([]);
    expect(canAccessFeed(privateByDefault, null)).toBe(false);
    expect(canAccessFeed(privateByDefault, { type: "session", slackId: "U123" })).toBe(false);
    expect(canAccessFeed(privateByDefault, { type: "apikey", slackId: "U123" })).toBe(false);
    // canAccessFeed only evaluates feed ACLs; channel-manager and lockdown
    // authorization is intentionally handled by the command layer.
  });
  test("scoped API keys only access their channels", () => {
    expect(canAccessFeed(feed(["U999"]), { type: "apikey", slackId: "U123", channelIds: ["C1"] })).toBe(true);
    expect(canAccessFeed({ ...feed(["*"]), id: "C2" }, { type: "apikey", slackId: "U123", channelIds: ["C1"] })).toBe(false);
  });
  test("unscoped API keys use user-level access", () => {
    expect(canAccessFeed(feed(["U123"]), { type: "apikey", slackId: "U123" })).toBe(true);
    expect(canAccessFeed(feed(["U999"]), { type: "apikey", slackId: "U123" })).toBe(false);
  });
  test("users without channel access cannot create scoped API keys", () => {
    expect(canCreateApiKeyForChannel(feed([]), "U123", { isLockdown: false, isManager: false })).toBe(false);
    expect(canCreateApiKeyForChannel(feed(["U999"]), "U123", { isLockdown: false, isManager: false })).toBe(false);
    expect(canCreateApiKeyForChannel(feed(["U123"]), "U123", { isLockdown: false, isManager: false })).toBe(true);
    expect(canCreateApiKeyForChannel(feed(["*"]), "U123", { isLockdown: false, isManager: false })).toBe(true);
    expect(canCreateApiKeyForChannel(feed([]), "U123", { isLockdown: true, isManager: false })).toBe(true);
    expect(canCreateApiKeyForChannel(feed([]), "U123", { isLockdown: false, isManager: true })).toBe(true);
  });
  test("only listed approved posters can approve messages", () => {
    const base = {
      clickingUser: "U999",
      messageUser: "U123",
      isManager: false,
      isLockdown: false,
    };
    expect(canApproveMessage({ approvedPosters: ["U123"], ...base, clickingUser: "U123" })).toBe(true);
    expect(canApproveMessage({ approvedPosters: ["U123"], ...base })).toBe(false);
    expect(canApproveMessage({ approvedPosters: ["U123"], ...base, isLockdown: true })).toBe(true);
    expect(canApproveMessage({ approvedPosters: ["U123"], ...base, isManager: true })).toBe(true);
  });
  test("poster mode lets the message author approve their own message only", () => {
    expect(canApproveMessage({
      approvedPosters: ["poster"], clickingUser: "U123", messageUser: "U123",
      isManager: false, isLockdown: false,
    })).toBe(true);
    expect(canApproveMessage({
      approvedPosters: ["poster"], clickingUser: "U999", messageUser: "U123",
      isManager: false, isLockdown: false,
    })).toBe(false);
    expect(canApproveMessage({
      approvedPosters: ["poster", "U999"], clickingUser: "U999", messageUser: "U123",
      isManager: false, isLockdown: false,
    })).toBe(true);
  });
  test("metadata modal submissions enforce the same approval rule before forwarding", () => {
    expect(canApproveMessage({
      approvedPosters: ["U123"], clickingUser: "U999", messageUser: "U123",
      isManager: false, isLockdown: false,
    })).toBe(false);
    expect(canApproveMessage({
      approvedPosters: ["poster"], clickingUser: "U999", messageUser: "U123",
      isManager: false, isLockdown: false,
    })).toBe(false);
    expect(canApproveMessage({
      approvedPosters: ["poster"], clickingUser: "U123", messageUser: "U123",
      isManager: false, isLockdown: false,
    })).toBe(true);
    expect(canApproveMessage({
      approvedPosters: [], clickingUser: "U999", messageUser: "U123",
      isManager: false, isLockdown: true,
    })).toBe(true);
  });
});
