import { describe, expect, test } from "bun:test";
import { extractMessageText, resolveSlackMrkdwn } from "../src/app";

describe("Slack text sanitization", () => {
  test("removes broadcast mentions", () => {
    expect(resolveSlackMrkdwn("<!here> <!channel> <!everyone>hello")).toBe("  hello");
  });

  test("resolves channel and user labels", () => {
    expect(resolveSlackMrkdwn("<#C123|general> <@U123|Ada>")).toBe("#general @Ada");
  });

  test("resolves links and HTML entities", () => {
    expect(resolveSlackMrkdwn("<https://example.com|Example> &amp; &lt;x&gt;")).toBe("Example & <x>");
  });

  test("extracts section and context block text", () => {
    expect(extractMessageText({ blocks: [
      { type: "section", text: { type: "mrkdwn", text: "section" } },
      { type: "context", elements: [{ type: "mrkdwn", text: "context" }] },
    ], text: "fallback" })).toBe("section\ncontext");
  });

  test("falls back safely for empty or malformed blocks", () => {
    expect(extractMessageText({ blocks: [], text: "fallback" })).toBe("fallback");
    expect(extractMessageText({ blocks: [{ type: "divider" }] })).toBe("");
    expect(extractMessageText({})).toBe("");
  });
});
