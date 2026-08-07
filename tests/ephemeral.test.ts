import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("../src/app.ts", import.meta.url)), "utf8");

function callsFor(method: "postMessage" | "postEphemeral"): string[] {
  const calls: string[] = [];
  const needle = `chat.${method}(`;
  let from = 0;
  while (true) {
    const start = source.indexOf(needle, from);
    if (start < 0) break;
    let depth = 0;
    let quote = "";
    let escaped = false;
    for (let i = start + needle.length - 1; i < source.length; i++) {
      const ch = source[i]!;
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
      if (ch === "(") depth++;
      if (ch === ")" && --depth === 0) {
        calls.push(source.slice(start, i + 1));
        from = i + 1;
        break;
      }
    }
  }
  return calls;
}

describe("Slack response visibility policy", () => {
  const messages = callsFor("postMessage");
  const ephemeral = callsFor("postEphemeral");

  test("error text is never sent with public postMessage", () => {
    expect(messages.filter((call) => call.includes("❌"))).toEqual([]);
  });

  test("every ephemeral call identifies its recipient", () => {
    expect(ephemeral.length).toBeGreaterThan(0);
    for (const call of ephemeral) expect(call).toMatch(/\buser\s*:/);
  });

  test("threadless postMessage calls are approved forwards", () => {
    for (const call of messages) {
      if (/\bthread_ts\s*:/.test(call)) continue;
      expect(call).toMatch(/sub\.subscriberChannelId/);
    }
  });

  test("all current public bot prompts and permalink replies are threaded", () => {
    for (const call of messages) {
      if (!call.includes("sub.subscriberChannelId")) expect(call).toMatch(/\bthread_ts\s*:/);
    }
  });
});
