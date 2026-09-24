import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { isSlackFileUrl, verifySignature } from "../src/app";

const SECRET = "test-signing-secret";

function signedRequest(
  body: string,
  { ts = Math.floor(Date.now() / 1000), secret = SECRET } = {},
): Request {
  const sig =
    "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
  return new Request("https://indigest.test/interactions", {
    method: "POST",
    headers: {
      "X-Slack-Request-Timestamp": String(ts),
      "X-Slack-Signature": sig,
    },
    body,
  });
}

describe("verifySignature", () => {
  const body = "payload=%7B%7D";

  test("accepts a correctly signed, fresh request", async () => {
    expect(await verifySignature(signedRequest(body), body, SECRET)).toBe(true);
  });

  test("rejects a request signed with the wrong secret", async () => {
    const req = signedRequest(body, { secret: "attacker" });
    expect(await verifySignature(req, body, SECRET)).toBe(false);
  });

  test("rejects a tampered body", async () => {
    const req = signedRequest(body);
    expect(await verifySignature(req, body + "x", SECRET)).toBe(false);
  });

  test("rejects unsigned requests", async () => {
    const req = new Request("https://indigest.test/interactions", {
      method: "POST",
      body,
    });
    expect(await verifySignature(req, body, SECRET)).toBe(false);
  });

  test("rejects stale timestamps (replay)", async () => {
    const req = signedRequest(body, {
      ts: Math.floor(Date.now() / 1000) - 60 * 10,
    });
    expect(await verifySignature(req, body, SECRET)).toBe(false);
  });

  test("rejects everything when the signing secret is unset", async () => {
    const req = signedRequest(body, { secret: "" });
    expect(await verifySignature(req, body, "")).toBe(false);
  });
});

describe("isSlackFileUrl", () => {
  test("accepts Slack file hosts", () => {
    expect(isSlackFileUrl("https://files.slack.com/files-pri/T1-F1/a.png")).toBe(true);
  });

  test("rejects non-Slack and lookalike hosts", () => {
    expect(isSlackFileUrl("https://attacker.example/a.png")).toBe(false);
    expect(isSlackFileUrl("https://files.slack.com.attacker.example/a")).toBe(false);
    expect(isSlackFileUrl("https://files.slack.com@attacker.example/a")).toBe(false);
    expect(isSlackFileUrl("http://files.slack.com/a")).toBe(false);
    expect(isSlackFileUrl("not a url")).toBe(false);
  });
});
