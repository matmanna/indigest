import { describe, expect, test } from "vitest";
import {
  extractMessageText,
  extractForwarderComment,
  extractOriginalAuthor,
  extractOriginalTimestamp,
  isBlankForwardMessage,
  resolveMessageTimestamp,
  resolveStoredAuthors,
  resolveSlackMrkdwn,
} from "../src/app";

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

  test("extracts forwarded content when the Slack text field is blank", () => {
    expect(extractMessageText({
      text: "",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "forwarded content" } }],
    })).toBe("forwarded content");
    expect(extractMessageText({
      text: "",
      attachments: [{ title: "Forwarded title", text: "Forwarded body" }],
    })).toBe("Forwarded title\nForwarded body");
    expect(extractMessageText({
      text: "",
      blocks: [{
        type: "rich_text",
        elements: [{
          type: "rich_text_section",
          elements: [
            { type: "text", text: "Rich text content " },
            { type: "emoji", name: "eyes" },
          ],
        }],
      }],
    })).toBe("Rich text content :eyes:");
  });

  test("keeps rich_text inline elements on one line", () => {
    expect(extractMessageText({
      blocks: [{
        type: "rich_text",
        elements: [{
          type: "rich_text_section",
          elements: [
            { type: "text", text: "Listen for a " },
            { type: "link", url: "https://example.com" },
            { type: "text", text: " and watch " },
            { type: "emoji", name: "eyes" },
            { type: "channel", channel_id: "C123" },
          ],
        }],
      }],
    })).toBe("Listen for a https://example.com and watch :eyes:<#C123>");
  });

  test("rich_text list items and line breaks become newlines", () => {
    expect(extractMessageText({
      blocks: [{
        type: "rich_text",
        elements: [{
          type: "rich_text_list",
          style: "bullet",
          elements: [
            { type: "rich_text_section", elements: [{ type: "text", text: "one" }] },
            { type: "rich_text_section", elements: [{ type: "text", text: "two" }] },
          ],
        }, {
          type: "rich_text_section",
          elements: [
            { type: "text", text: "a" },
            { type: "line_break" },
            { type: "text", text: "b" },
          ],
        }],
      }],
    })).toBe("one\ntwo\na\nb");
  });

  test("attributes shared content to the original author", () => {
    expect(extractOriginalAuthor({
      user: "U_FORWARDER",
      message: { user: "U_ORIGINAL", username: "original-author" },
    })).toEqual({ userId: "U_ORIGINAL", userName: "original-author" });
    expect(extractOriginalAuthor({
      user: "U_FORWARDER",
      attachments: [{ author_id: "U_ORIGINAL", author_name: "original-author" }],
    })).toEqual({ userId: "U_ORIGINAL", userName: "original-author" });
  });

  test("extracts the original timestamp from shared messages", () => {
    expect(extractOriginalTimestamp({
      ts: "200.2",
      message: { ts: "100.1" },
    })).toBe("100.1");
    expect(extractOriginalTimestamp({
      attachments: [{ timestamp: "100.1" }],
    })).toBe("100.1");
    expect(resolveMessageTimestamp({
      text: "",
      message: { ts: "100.1" },
    }, "200.2")).toBe(new Date(100000).toISOString());
    expect(resolveMessageTimestamp({
      text: "forwarded content",
      message: { ts: "100.1" },
    }, "200.2")).toBe(new Date(200000).toISOString());
    expect(resolveMessageTimestamp({
      text: "",
      message: { user: "U_ORIGINAL" },
    }, "200.2", "1999-01-01T00:00:00.000Z")).toBe("1999-01-01T00:00:00.000Z");
    expect(resolveStoredAuthors({
      text: "",
      user: "U_FORWARDER",
      message: { ts: "100.1", user: "U_ORIGINAL", username: "Original" },
    }, "U_FORWARDER", "Forwarder")).toEqual({
      userId: "U_ORIGINAL",
      userName: "Original",
    });
    expect(resolveStoredAuthors({
      text: "forwarded content",
      user: "U_FORWARDER",
      message: { ts: "100.1", user: "U_ORIGINAL", username: "Original" },
    }, "U_FORWARDER", "Forwarder")).toEqual({
      userId: "U_FORWARDER,U_ORIGINAL",
      userName: "Forwarder,Original",
    });
    expect(resolveStoredAuthors({
      text: "",
      user: "U_FORWARDER",
      message: { user: "U_ORIGINAL", username: "Original" },
    }, "U_FORWARDER", "Forwarder")).toEqual({
      userId: "U_ORIGINAL",
      userName: "Original",
    });
    expect(extractForwarderComment({
      text: "",
      message: { text: "original message", user: "U_ORIGINAL" },
    })).toBe("");
    expect(isBlankForwardMessage({
      text: "",
      message: { text: "original message", user: "U_ORIGINAL", ts: "100.1" },
    })).toBe(true);
    expect(isBlankForwardMessage({
      text: "please publish this",
      message: { text: "original message", user: "U_ORIGINAL", ts: "100.1" },
    })).toBe(false);
  });

  test("falls back safely for empty or malformed blocks", () => {
    expect(extractMessageText({ blocks: [], text: "fallback" })).toBe("fallback");
    expect(extractMessageText({ blocks: [{ type: "divider" }] })).toBe("");
    expect(extractMessageText({})).toBe("");
  });
});
