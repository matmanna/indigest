import { describe, expect, test } from "vitest";
import {
  extractForwarderComment,
  extractMessageMrkdwn,
  extractMessageText,
  extractOriginalAuthor,
  extractOriginalTimestamp,
  isBlankForwardMessage,
  isLinkOnly,
  isMessageEmpty,
  resolveMessageTimestamp,
  resolveSlackMrkdwn,
  resolveStoredAuthors,
} from "../src/app";
import { slackMessages } from "./fixtures/slack-messages";

// Pins what Indigest stores as `text` and how it judges messages. Formatting
// work must leave all of this exactly as it was.
describe("message extraction parity", () => {
  for (const [name, msg] of Object.entries(slackMessages)) {
    test(name, () => {
      const raw = extractMessageText(msg);
      expect({
        raw,
        text: resolveSlackMrkdwn(raw),
        isLinkOnly: isLinkOnly(raw),
        isEmpty: isMessageEmpty(raw),
        blankForward: isBlankForwardMessage(msg),
        forwarderComment: extractForwarderComment(msg),
        originalAuthor: extractOriginalAuthor(msg),
        originalTimestamp: extractOriginalTimestamp(msg),
        timestamp: resolveMessageTimestamp(msg, msg.ts),
        authors: resolveStoredAuthors(msg, msg.user || "", "forwarder"),
      }).toMatchSnapshot();
    });
  }
});

describe("message mrkdwn", () => {
  for (const [name, msg] of Object.entries(slackMessages)) {
    test(name, () => {
      expect(extractMessageMrkdwn(msg)).toMatchSnapshot();
    });
  }

  // Formatting may add markers, but never words: with markers, escapes and
  // structure stripped, the mrkdwn reads the same as the plain text.
  test("adds formatting only", () => {
    const unformat = (text: string) =>
      text
        .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2")
        .replace(/<(https?:\/\/[^>]+)>/g, "$1")
        .replace(/```/g, "")
        .replace(/^ *(?:•|\d+\.) /gm, "")
        .replace(/^> /gm, "")
        .replace(/[*_~`]/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/¦/g, "|")
        .replace(/<!(?:here|channel|everyone)>/g, "");
    for (const msg of Object.values(slackMessages)) {
      const plain = extractMessageText(msg).replace(/<!(?:here|channel|everyone)>/g, "");
      expect(unformat(extractMessageMrkdwn(msg))).toBe(unformat(plain));
    }
  });
});
