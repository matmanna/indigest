import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { WebClient } from "@slack/web-api";
import { getAuth } from "./lib/auth";
import { Feed } from "feed";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIGenerator } from "@orpc/openapi";
import { RPCHandler } from "@orpc/server/fetch";
import { ZodSmartCoercionPlugin } from "@orpc/zod";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { router } from "./api/router";
import type { ORPCContext } from "./api/context";
import { ORPCError } from "@orpc/server";
import { authenticateApiKey, createApiKeyContext } from "./lib/api-keys";
import {
  canAccessFeed,
  feedIdentityForApiKey,
  type FeedIdentity,
} from "./lib/access";
import { getDb } from "./db";
import * as schema from "./db/schema";
import { eq } from "drizzle-orm";
import * as q from "./db/queries";
import { graphCache, invalidateGraphCache } from "./lib/graph-cache";
import { auditActions, recordAudit } from "./lib/audit";
import { handleMessageDeleted } from "./lib/deletions";
import type {
  Channel as StoreChannel,
  Message as StoreMessage,
  Subscription as StoreSubscription,
} from "./db/queries";

// --- Helpers ---

function getDbUrl(env: Env): string {
  return env.HYPERDRIVE_BINDING?.connectionString || env.DATABASE_URL;
}

async function syncChannelName(
  db: any,
  slack: WebClient,
  channel: StoreChannel,
): Promise<void> {
  try {
    const info = await slack.conversations.info({ channel: channel.id });
    const name = (info.channel as any)?.name;
    if (typeof name === "string" && name && name !== channel.name) {
      channel.name = name;
      await q.updateChannelName(db, channel.id, name);
      console.log(`Updated channel name in DB: ${channel.id} -> #${name}`);
    }
  } catch (err: any) {
    console.warn(
      `Unable to sync channel name for ${channel.id}:`,
      err?.data?.error || err?.message || err,
    );
  }
}

export function resolveSlackMrkdwn(text: string): string {
  if (!text) return text;
  return text
    .replace(/<!here>/g, "")
    .replace(/<!channel>/g, "")
    .replace(/<!everyone>/g, "")
    .replace(/<#([A-Z0-9]+)\|([^>]+)>/g, "#$2")
    .replace(/<#([A-Z0-9]+)>/g, (_, id) => `#${id}`)
    .replace(/<@([A-Z0-9]+)\|([^>]+)>/g, "@$2")
    .replace(/<@([A-Z0-9]+)>/g, (_, id) => `<@${id}>`)
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function extractMessageText(msg: any): string {
  return walkMessageText(msg, false);
}

/**
 * The same text as extractMessageText, taken from the same blocks,
 * attachments or fallback, but kept as Slack mrkdwn: rich text styles,
 * lists, quotes, code blocks, labelled links and channel references survive.
 * Only formatting differs; broadcasts (<!here> and friends) are dropped as
 * resolveSlackMrkdwn drops them from text.
 */
export function extractMessageMrkdwn(msg: any): string {
  return walkMessageText(msg, true)
    .replace(/<!here>/g, "")
    .replace(/<!channel>/g, "")
    .replace(/<!everyone>/g, "");
}

// Escapes text the way Slack does inside mrkdwn.
function escapeMrkdwn(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Wraps styled text in mrkdwn markers. Markers must touch the text, so
// surrounding whitespace stays outside them.
function styleMrkdwn(text: string, style: any): string {
  if (!style || !text.trim()) return text;
  const [, lead, core, trail] = text.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
  let out = core!;
  if (style.code) {
    out = `\`${out}\``;
  } else {
    if (style.strike) out = `~${out}~`;
    if (style.italic) out = `_${out}_`;
    if (style.bold) out = `*${out}*`;
  }
  return `${lead}${out}${trail}`;
}

const sameStyle = (a: any, b: any) =>
  Boolean(a?.bold) === Boolean(b?.bold) &&
  Boolean(a?.italic) === Boolean(b?.italic) &&
  Boolean(a?.strike) === Boolean(b?.strike) &&
  Boolean(a?.code) === Boolean(b?.code);

function walkMessageText(msg: any, format: boolean): string {
  if (msg.blocks && msg.blocks.length > 0) {
    const parts: string[] = [];
    for (const block of msg.blocks) {
      if (block.type === "section" && block.text?.text) {
        parts.push(
          format && block.text.type === "plain_text"
            ? escapeMrkdwn(block.text.text)
            : block.text.text,
        );
      } else if (block.type === "rich_text" && block.elements) {
        const richInline = (elements: any[], plain = false): string => {
          if (format) return richMrkdwn(elements, plain);
          let out = "";
          for (const el of elements) {
            if (typeof el.text === "string" && el.text) {
              out += el.text;
            } else if (el.type === "emoji" && el.name) {
              out += `:${el.name}:`;
            } else if (el.type === "link") {
              out += el.url || el.text || "";
            } else if (el.type === "user") {
              out += `<@${el.user_id}>`;
            } else if (el.type === "channel") {
              out += `<#${el.channel_id}>`;
            } else if (el.type === "line_break") {
              out += "\n";
            } else if (Array.isArray(el.elements)) {
              out += richInline(el.elements);
            }
          }
          return out;
        };
        // The mrkdwn of inline elements. Neighbours that share a style,
        // links included, are wrapped once, so an italic sentence with a
        // link in it reads _see <url|this>_ rather than broken markers.
        const richMrkdwn = (elements: any[], plain: boolean): string => {
          const pieces: { text: string; style?: any }[] = [];
          for (const el of elements) {
            let text = "";
            if (el.type === "link") {
              text = el.url
                ? `<${el.url}${
                  el.text && el.text !== el.url
                    ? `|${escapeMrkdwn(el.text).replace(/\|/g, "¦")}`
                    : ""
                }>`
                : escapeMrkdwn(el.text || "");
            } else if (typeof el.text === "string" && el.text) {
              text = escapeMrkdwn(el.text);
            } else if (el.type === "emoji" && el.name) {
              text = `:${el.name}:`;
            } else if (el.type === "user") {
              text = `<@${el.user_id}>`;
            } else if (el.type === "channel") {
              text = `<#${el.channel_id}>`;
            } else if (el.type === "line_break") {
              text = "\n";
            } else if (Array.isArray(el.elements)) {
              text = richMrkdwn(el.elements, plain);
              pieces.push({ text });
              continue;
            }
            if (text) pieces.push({ text, style: plain ? undefined : el.style });
          }

          let out = "";
          for (let i = 0; i < pieces.length; ) {
            const style = pieces[i]!.style;
            let run = "";
            while (i < pieces.length && sameStyle(pieces[i]!.style, style)) {
              run += pieces[i]!.text;
              i += 1;
            }
            // A run may span lines; markers cannot, so each line is wrapped.
            out += run
              .split("\n")
              .map((line) => styleMrkdwn(line, style))
              .join("\n");
          }
          return out;
        };
        const extractRichText = (elements: any[]): string[] => {
          const richParts: string[] = [];
          for (const element of elements) {
            if (
              element.type === "rich_text_section" ||
              element.type === "rich_text_preformatted" ||
              element.type === "rich_text_quote"
            ) {
              if (!format || element.type === "rich_text_section") {
                richParts.push(richInline(element.elements));
              } else if (element.type === "rich_text_preformatted") {
                richParts.push(`\`\`\`${richInline(element.elements, true)}\`\`\``);
              } else {
                richParts.push(
                  richInline(element.elements)
                    .split("\n")
                    .map((line) => `> ${line}`)
                    .join("\n"),
                );
              }
            } else if (element.type === "rich_text_list") {
              const indent = "    ".repeat(Math.max(0, element.indent || 0));
              (element.elements || []).forEach((item: any, index: number) => {
                const text = richInline(item.elements);
                if (!format) {
                  richParts.push(text);
                  return;
                }
                const marker =
                  element.style === "ordered"
                    ? `${(element.offset || 0) + index + 1}.`
                    : "•";
                richParts.push(`${indent}${marker} ${text}`);
              });
            } else if (Array.isArray(element.elements)) {
              richParts.push(...extractRichText(element.elements));
            }
          }
          return richParts;
        };
        parts.push(...extractRichText(block.elements));
      } else if (block.type === "context" && block.elements) {
        for (const el of block.elements) {
          if (el.type === "mrkdwn") {
            parts.push(el.text);
          } else if (el.type === "plain_text") {
            parts.push(format ? escapeMrkdwn(el.text) : el.text);
          }
        }
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  if (msg.attachments && msg.attachments.length > 0) {
    const parts: string[] = [];
    for (const attachment of msg.attachments) {
      for (const value of [
        attachment.pretext,
        attachment.title,
        attachment.text,
      ]) {
        if (typeof value === "string" && value) parts.push(value);
      }
      for (const field of attachment.fields || []) {
        if (field.title) parts.push(String(field.title));
        if (field.value) parts.push(String(field.value));
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  if (msg.message && typeof msg.message === "object") {
    const nestedText = walkMessageText(msg.message, format);
    // The fallback below must trigger exactly when it does for plain text.
    if (format ? walkMessageText(msg.message, false) : nestedText) {
      return nestedText;
    }
  }
  return msg.text || "";
}

export function extractOriginalAuthor(msg: any): {
  userId?: string;
  userName?: string;
} {
  if (msg.originalUserId || msg.originalUserName) {
    return {
      userId: msg.originalUserId,
      userName: msg.originalUserName,
    };
  }

  const nested = msg.message || msg.original_message;
  if (nested?.user || nested?.username || nested?.user_name) {
    return {
      userId: nested.user,
      userName: nested.username || nested.user_name,
    };
  }

  const attachment = (msg.attachments || []).find(
    (item: any) => item.author_id || item.author_name,
  );
  if (attachment) {
    return {
      userId: attachment.author_id,
      userName: attachment.author_name,
    };
  }

  return {};
}

export function extractOriginalTimestamp(msg: any): string | undefined {
  const nested = msg.message || msg.original_message;
  const nestedTimestamp = nested?.ts || nested?.message_ts || nested?.timestamp;
  if (typeof nestedTimestamp === "string" && nestedTimestamp) {
    return nestedTimestamp;
  }
  const attachmentTimestamp = (msg.attachments || []).find(
    (item: any) => item.ts || item.timestamp,
  );
  const timestamp = attachmentTimestamp?.ts || attachmentTimestamp?.timestamp;
  return typeof timestamp === "string" && timestamp ? timestamp : undefined;
}

/** Text written by the person sharing a nested Slack message, excluding the original. */
export function extractForwarderComment(msg: any): string {
  const nested = msg.message || msg.original_message;
  if (nested && typeof msg.text === "string") return msg.text;
  return typeof msg.rawText === "string" ? msg.rawText : msg.text || "";
}

export function isBlankForwardMessage(msg: any): boolean {
  const nested = msg.message || msg.original_message;
  const attachmentAuthor = (msg.attachments || []).some(
    (item: any) => item.author_id || item.author_name,
  );
  const isForward = Boolean(nested || attachmentAuthor || msg.originalUserId);
  return isForward && !extractForwarderComment(msg).trim();
}

export function resolveMessageTimestamp(
  msg: any,
  fallbackTimestamp: string,
  existingTimestamp?: string,
): string {
  const originalTimestamp = extractOriginalTimestamp(msg);
  if (isBlankForwardMessage(msg) || !extractMessageText(msg).trim()) {
    if (originalTimestamp) return slackTsToTime(originalTimestamp).toISOString();
    if (existingTimestamp) return existingTimestamp;
  }
  return slackTsToTime(fallbackTimestamp).toISOString();
}

export function resolveStoredAuthors(
  msg: any,
  forwarderId: string,
  forwarderName: string,
): { userId: string; userName: string } {
  const originalAuthor = extractOriginalAuthor(msg);
  const isBlankForward = isBlankForwardMessage(msg);
  if (
    isBlankForward &&
    (originalAuthor.userId || originalAuthor.userName)
  ) {
    return {
      userId: originalAuthor.userId || "",
      userName: originalAuthor.userName || "",
    };
  }
  return {
    userId: q.mergeAuthorLists(forwarderId, originalAuthor.userId),
    userName: q.mergeAuthorLists(forwarderName, originalAuthor.userName),
  };
}

function logMessageContentProbe(stage: string, msg: any): void {
  const extractedText = msg.rawText ?? extractMessageText(msg);
  const originalAuthor = extractOriginalAuthor(msg);
  console.log(
    `[message-content:${stage}]`,
    JSON.stringify({
      channelId: msg.channelId || msg.channel,
      slackTs: msg.slackTs || msg.ts,
      subtype: msg.subtype || null,
      text: typeof msg.text === "string" ? msg.text : null,
      textLength: typeof msg.text === "string" ? msg.text.length : 0,
      rawText: typeof msg.rawText === "string" ? msg.rawText : null,
      rawTextLength: typeof msg.rawText === "string" ? msg.rawText.length : null,
      extractedText,
      extractedTextLength: extractedText.length,
      originalAuthor,
      blocks: Array.isArray(msg.blocks)
        ? msg.blocks.map((block: any) => ({
          type: block.type,
          text: block.text?.text || null,
          elementTypes: Array.isArray(block.elements)
            ? block.elements.map((element: any) => element.type)
            : [],
        }))
        : [],
      attachments: Array.isArray(msg.attachments)
        ? msg.attachments.map((attachment: any) => ({
          title: attachment.title || null,
          text: attachment.text || null,
          pretext: attachment.pretext || null,
          fieldCount: Array.isArray(attachment.fields)
            ? attachment.fields.length
            : 0,
        }))
        : [],
      files: Array.isArray(msg.files)
        ? msg.files.map((file: any) => ({
          id: file.id || null,
          name: file.name || null,
          title: file.title || null,
          mimetype: file.mimetype || null,
          hasPreview: Boolean(file.preview || file.plain_text),
        }))
        : [],
    }),
  );
}

function slackTsToTime(ts: string): Date {
  const parts = ts.split(".");
  const sec = parseInt(parts[0] || "0") || 0;
  const nsec = parseInt(parts[1] || "0") || 0;
  return new Date(sec * 1000 + nsec / 1e6);
}

async function isChannelManager(
  channelId: string,
  userId: string,
  slack: WebClient,
): Promise<boolean> {
  // Check if user is the channel creator
  try {
    const conv = await slack.conversations.info({ channel: channelId });
    if ((conv.channel as any)?.creator === userId) return true;
  } catch { }

  // Check if user is a workspace admin or owner (channel managers in Slack)
  try {
    const user = await slack.users.info({ user: userId });
    const u = user.user as any;
    if (u?.is_admin || u?.is_owner || u?.is_primary_owner) return true;
  } catch { }

  return false;
}

export async function verifySignature(
  request: Request,
  body: string,
  signingSecret: string,
): Promise<boolean> {
  if (!signingSecret) return false;
  const ts = request.headers.get("X-Slack-Request-Timestamp") || "";
  const sig = request.headers.get("X-Slack-Signature") || "";
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 60 * 5) return false;
  const baseString = `v0:${ts}:${body}`;
  const encoder = new TextEncoder();
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(signingSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sigBytes = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(baseString),
    );
    const computed =
      "v0=" +
      Array.from(new Uint8Array(sigBytes))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    if (computed.length !== sig.length) return false;
    return timingSafeEqual(encoder.encode(computed), encoder.encode(sig));
  } catch {
    return false;
  }
}

async function slackResponse(responseUrl: string, text: string) {
  try {
    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        response_type: "ephemeral",
        replace_original: false,
      }),
    });
  } catch { }
}

async function postPermalinkReply(
  slack: WebClient,
  channelId: string,
  messageTs: string,
): Promise<void> {
  try {
    const permalink = await slack.chat.getPermalink({
      channel: channelId,
      message_ts: messageTs,
    });
    const url = (permalink as any)?.permalink || "";
    if (!url) return;
    await slack.chat.postMessage({
      channel: channelId,
      thread_ts: messageTs,
      text: url,
      unfurl_links: false,
      unfurl_media: false,
    } as any);
  } catch { }
}

async function fireWebhook(ch: StoreChannel, msg: StoreMessage) {
  if (!ch.webhookUrl) return;
  try {
    await fetch(ch.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "message.approved",
        channel: { id: ch.id, name: ch.name },
        message: {
          ts: msg.slackTs,
          user_id: msg.userId,
          user_name: msg.userName,
          text: msg.text,
          timestamp: msg.timestamp,
          metadata: msg.metadata ? JSON.parse(msg.metadata) : undefined,
        },
      }),
    });
  } catch { }
}

export function isSlackFileUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    const host = hostname.toLowerCase();
    return (
      protocol === "https:" && (host === "slack.com" || host.endsWith(".slack.com"))
    );
  } catch {
    return false;
  }
}

async function uploadToCDN(
  slackUrl: string,
  botToken: string,
  cdnKey: string,
): Promise<string> {
  if (!cdnKey || !isSlackFileUrl(slackUrl)) return slackUrl;
  const resp = await fetch(slackUrl, {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  if (!resp.ok) return slackUrl;
  const blob = await resp.blob();
  const formData = new FormData();
  formData.append("file", blob, "upload");
  const cdnResp = await fetch("https://cdn.hackclub.com/api/v4/upload", {
    method: "POST",
    headers: { Authorization: `Bearer ${cdnKey}` },
    body: formData,
  });
  if (!cdnResp.ok) {
    console.error("CDN upload failed:", await cdnResp.text());
    return slackUrl;
  }
  const data = (await cdnResp.json()) as any;
  return data.url || slackUrl;
}

// --- Forwarding helpers ---

export function isLinkOnly(text: string): boolean {
  const trimmed = text.trim();
  return /^https?:\/\/\S+$/.test(trimmed);
}

export function isMessageEmpty(text: string): boolean {
  return text.trim().length === 0;
}

export function hasChannelPing(text: string): boolean {
  return /<!(?:here|channel|everyone)>/.test(text);
}

export function hasRecentSubstantiveMessage(
  current: Pick<StoreMessage, "slackTs" | "text" | "rawText">,
  recent: Array<Pick<StoreMessage, "slackTs" | "text" | "rawText">>,
): boolean {
  return recent.some((m) => {
    const text = m.rawText ?? m.text;
    return (
      m.slackTs !== current.slackTs &&
      !isLinkOnly(text) &&
      !isMessageEmpty(text) &&
      !hasChannelPing(text)
    );
  });
}

export async function shouldForward(
  msg: StoreMessage,
  db: any,
): Promise<boolean> {
  const policyText = msg.rawText ?? msg.text;
  // Always forward Slack permalink cross-posts
  if (isSlackPermalink(policyText)) return true;
  // Always forward empty messages (Slack forwarded messages often come as empty)
  if (isMessageEmpty(policyText)) return true;
  if (isLinkOnly(policyText)) {
    console.log(
      `shouldForward: skipping link-only message ${msg.slackTs}: ${policyText.substring(0, 80)}`,
    );
    return false;
  }
  if (hasChannelPing(policyText)) {
    const since = new Date(Date.now() - 5 * 60 * 1000);
    const recent = await q.getRecentMessages(db, msg.channelId, since);
    if (hasRecentSubstantiveMessage(msg, recent)) return false;
  }
  return true;
}

export function isSlackPermalink(text: string): boolean {
  const trimmed = text.trim();
  return (
    /^https:\/\/hackclub\.slack\.com\/archives\/[A-Z0-9]+\/p\d+$/.test(
      trimmed,
    ) ||
    /^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/[A-Z0-9]+\/p\d+$/.test(
      trimmed,
    )
  );
}

// --- Feed access control ---

export { canAccessFeed, type FeedIdentity };

async function resolveFeedIdentity(
  c: any,
  env: Env,
): Promise<FeedIdentity | null> {
  const dbUrl = getDbUrl(env);

  // 1. Try session from cookie
  try {
    const auth = getAuth(dbUrl, env as any);
    const s = await auth.api.getSession({ headers: c.req.raw.headers });
    if (s?.user && (s.user as any).slackId) {
      return { type: "session", slackId: (s.user as any).slackId };
    }
  } catch { }

  // 2. Try API key from header or ?api_key= param
  const authHeader = c.req.header("Authorization") || "";
  const queryKey = c.req.query("api_key") || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : queryKey;
  if (token && token.startsWith("ind_")) {
    try {
      const identity = await authenticateApiKey(token, dbUrl);
      return await feedIdentityForApiKey(getDb(dbUrl), identity);
    } catch (err: any) {
      if (!(err instanceof ORPCError)) {
        console.error("Feed API key resolution error:", err?.message || err);
      }
    }
  }

  return null;
}

export function canApproveMessage({
  approvedPosters,
  clickingUser,
  messageUser,
  isManager,
  isLockdown,
}: {
  approvedPosters: string[];
  clickingUser: string;
  messageUser: string;
  isManager: boolean;
  isLockdown: boolean;
}): boolean {
  const messageUsers = q.splitAuthorList(messageUser);
  if (isLockdown || isManager) return true;
  if (approvedPosters.includes("poster") && messageUsers.includes(clickingUser)) {
    return true;
  }
  return approvedPosters.includes(clickingUser);
}

export type PublishDisposition = "auto" | "prompt" | "drop";

/**
 * Decide how a message should be handled for a channel with publish
 * whitelists. `identity` is the author's Slack user ID, or for a bot message
 * whose event carries no user field, its bot ID (or both, since either may be
 * whitelisted) - a match on any identity counts. If either whitelist (auto or
 * manual) is non-empty, only whitelisted identities are published: auto
 * identities are auto-published, manual identities get a Yep!/No prompt, and
 * everyone else is dropped. With no whitelist, everyone is prompted.
 */
export function resolvePublishDisposition(
  ch: { autoApproveUsers: string[]; manualUsers: string[] },
  identity: string | (string | undefined)[],
): PublishDisposition {
  const ids = (Array.isArray(identity) ? identity : [identity]).filter(
    (id): id is string => !!id,
  );
  const auto = ch.autoApproveUsers.filter(Boolean);
  if (auto.includes("*") || ids.some((id) => auto.includes(id))) return "auto";
  const manual = ch.manualUsers.filter(Boolean);
  if (ids.some((id) => manual.includes(id))) return "prompt";
  const anyWhitelist = auto.length > 0 || manual.length > 0;
  return anyWhitelist ? "drop" : "prompt";
}

export type MessageAdmission =
  | { allowed: true; disposition: PublishDisposition }
  | { allowed: false; reason: string };

/**
 * Decide whether a Slack message event should be admitted into the publish
 * pipeline, and if so how it should be handled. `bot_message` events are only
 * admitted when the bot user is in a publish whitelist (auto or manual), and
 * events authored by the indigest bot itself are always rejected so an
 * `*` auto-approve list can never create a forward loop.
 */
export function resolveMessageAdmission(opts: {
  subtype?: string;
  user?: string;
  botId?: string;
  selfUserId?: string;
  selfBotId?: string;
  autoApproveUsers: string[];
  manualUsers: string[];
  /** "shortcut" channels never admit ambient messages; publishing only happens via the message shortcut. */
  triggerMode: "message" | "shortcut";
}): MessageAdmission {
  if (opts.triggerMode === "shortcut") {
    return { allowed: false, reason: "shortcut-only" };
  }
  if (opts.selfUserId && opts.user === opts.selfUserId) {
    return { allowed: false, reason: "self-authored" };
  }
  if (opts.selfBotId && opts.botId && opts.botId === opts.selfBotId) {
    return { allowed: false, reason: "self-authored" };
  }
  if (opts.subtype && opts.subtype !== "bot_message") {
    return { allowed: false, reason: `unhandled subtype ${opts.subtype}` };
  }
  if (opts.subtype === "bot_message") {
    // Bot events often carry only a bot_id and no user field, so a whitelist
    // entry may name either the bot's Slack user ID or its bot ID.
    const whitelisted =
      opts.autoApproveUsers.includes("*") ||
      [opts.user, opts.botId].some(
        (id) =>
          !!id &&
          (opts.autoApproveUsers.includes(id) || opts.manualUsers.includes(id)),
      );
    if (!whitelisted) {
      return { allowed: false, reason: "unwhitelisted bot" };
    }
  }
const dispositionId =
    [opts.user, opts.botId].find(
      (id) =>
        !!id &&
        (opts.autoApproveUsers.includes(id) || opts.manualUsers.includes(id)),
    ) || opts.user || opts.botId || "";
  return {
    allowed: true,
    disposition: resolvePublishDisposition(
      { autoApproveUsers: opts.autoApproveUsers, manualUsers: opts.manualUsers },
      dispositionId,
    ),
  };
}

export const MAX_BLOCK_TEXT = 3000;
export const MAX_MESSAGE_TEXT = 40000;

/**
 * Slack caps mrkdwn text inside a section block at 3000 chars. Split a long
 * message into <=3000-char chunks (preferring newline boundaries) so a
 * forward is never silently truncated mid-message.
 */
export function chunkLongText(text: string, max = MAX_BLOCK_TEXT): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut <= 0) {
      cut = max;
    } else {
      cut += 1; // keep the boundary newline on the current chunk so nothing is lost
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * Approval/backfill paths re-fetch the source message live from Slack, so
 * an edit made after indigest stored the message (e.g. a teaser bot
 * trimming an announcement) would shrink or clobber the forward. Never let
 * that happen: when the stored record is a fuller version, keep it.
 */
export async function resolveForwardText(
  db: any,
  channelId: string,
  messageTs: string,
  liveText: string,
): Promise<string> {
  const stored = await q.getMessageBySlackTs(db, channelId, messageTs);
  if (stored?.text && stored.text.length >= liveText.length) {
    return stored.text;
  }
  return liveText;
}

/**
 * resolveForwardText, plus the matching formatted text. When a different
 * stored record wins, formattedText is left undefined so the stored one is
 * kept: text and formatted text always come from the same version.
 */
export async function resolveForwardContent(
  db: any,
  channelId: string,
  messageTs: string,
  liveText: string,
  liveFormattedText: string,
): Promise<{ text: string; formattedText?: string }> {
  const stored = await q.getMessageBySlackTs(db, channelId, messageTs);
  if (stored?.text && stored.text.length >= liveText.length) {
    // Identical text is the same version, so its formatting can be filled
    // in, which also backfills messages stored before formatted text.
    return stored.text === liveText
      ? { text: stored.text, formattedText: liveFormattedText }
      : { text: stored.text };
  }
  return { text: liveText, formattedText: liveFormattedText };
}

/** The bot's prompt once a message is approved. */
export function approvedPromptBlocks(
  messageTs: string,
  hasMetadataSchema: boolean,
): any[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "✅ *Message approved and added to the feed!*",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "indigest_no",
          text: { type: "plain_text", text: "Undo" },
          style: "danger" as const,
          value: messageTs,
        },
        ...(hasMetadataSchema
          ? [
            {
              type: "button",
              action_id: "indigest_edit_metadata",
              text: { type: "plain_text", text: "Edit metadata" },
              value: messageTs,
            },
          ]
          : []),
        {
          type: "button",
          action_id: "indigest_refresh",
          text: { type: "plain_text", text: "Refresh" },
          value: messageTs,
        },
      ],
    },
  ];
}

export function canEditBotMessage(
  userId: string,
  lockdownUsers: string[],
): boolean {
  return lockdownUsers.includes(userId);
}

export function isMetadataValueSet(value: unknown): boolean {
  return !(
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

export function hasProvidedMetadata(metadata: unknown): boolean {
  if (metadata === undefined || metadata === null || metadata === "") {
    return false;
  }
  const parsed =
    typeof metadata === "string"
      ? (() => {
        try {
          return JSON.parse(metadata);
        } catch {
          return null;
        }
      })()
      : metadata;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  return Object.values(parsed).some(isMetadataValueSet);
}

export function metadataRequirementSatisfied(
  metadataRequired: boolean,
  metadata: unknown,
): boolean {
  return !metadataRequired || hasProvidedMetadata(metadata);
}

/**
 * Resolve a sub channel's profile override string. A value wrapped in square
 * brackets (e.g. `[title]` or `[a.b]` / `[a].[b]`) is looked up in the source
 * channel's static `properties` map. Any other string is returned verbatim.
 * Returns `null` when there is no override or the referenced property is unset.
 * @param props - parsed source-channel static properties object
 */
export function resolveSubProfileValue(
  value: string | undefined | null,
  props: Record<string, unknown> | null,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const bracketMatch = trimmed.match(/^\[(.+)\]$/);
  if (!bracketMatch) return value.trim();
  if (!props || typeof props !== "object") return null;
  const keyPath = bracketMatch[1]!.replace(/\]\[/g, ".");
  const resolved = keyPath.split(".").reduce<unknown>(
    (acc, key) => (acc && typeof acc === "object" ? (acc as any)[key] : undefined),
    props,
  );
  if (typeof resolved === "string") return resolved;
  if (Array.isArray(resolved)) return resolved.join(",");
  if (resolved === 0 || resolved === false) return String(resolved);
  return null;
}

/**
 * Render a channel's static metadata as bold mrkdwn, one row per line, for
 * the top of every forward. Returns "" when there is nothing to show.
 */
export function formatStaticMetadata(staticMetadata: string | undefined): string {
  return (staticMetadata || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `*${line.replace(/^\*+|\*+$/g, "")}*`)
    .join("\n");
}

export function findExistingForward(
  actions: q.BotAction[],
  subscriberChannelId: string,
): q.BotAction | undefined {
  return actions.find(
    (action) =>
      action.type === "pub" && action.botChannelId === subscriberChannelId,
  );
}

export function upsertMetadataBlock(
  blocks: any[],
  metadataSection: string,
): any[] {
  const withoutExistingMetadata = blocks.filter(
    (block) => block?.block_id !== "indigest_metadata",
  );
  const metadataBlock = {
    type: "section",
    block_id: "indigest_metadata",
    text: { type: "mrkdwn", text: metadataSection },
  };
  const contextIdx = withoutExistingMetadata.findIndex(
    (block) => block?.type === "context",
  );
  if (contextIdx >= 0) {
    withoutExistingMetadata.splice(contextIdx, 0, metadataBlock);
  } else {
    withoutExistingMetadata.push(metadataBlock);
  }
  return withoutExistingMetadata;
}

/**
 * Look up a display name + avatar for a Slack user OR bot ID. Bot messages
 * often carry only a bot_id (no user field), and `users.info` rejects a bot
 * ID outright, so this dispatches to `bots.info` for anything shaped like
 * one instead. Returns null (never throws) if the lookup fails, so callers
 * can fall back to whatever attribution they already had.
 */
async function resolveAttributionProfile(
  slack: WebClient,
  id: string,
): Promise<{ name: string; icon: string } | null> {
  const isBot = /^B[A-Z0-9]+$/.test(id);
  try {
    if (isBot) {
      const r = await slack.bots.info({ bot: id });
      const bot = (r as any)?.bot;
      if (!bot) return null;
      return {
        name: bot.name || id,
        icon:
          bot.icons?.image_72 || bot.icons?.image_48 || bot.icons?.image_36 || "",
      };
    }
    const u = await slack.users.info({ user: id });
    const user = u.user as any;
    const profile = user?.profile;
    return {
      name: user?.real_name || user?.name || profile?.display_name || id,
      icon:
        profile?.image_72 || profile?.image_original || profile?.image_48 || "",
    };
  } catch (err) {
    console.error(`Failed to fetch ${isBot ? "bot" : "user"} info for ${id}:`, err);
    return null;
  }
}

export async function forwardToSubscribers(
  msg: StoreMessage,
  sourceChannel: StoreChannel,
  db: any,
  slack: WebClient,
) {
  logMessageContentProbe("forward", msg);
  await syncChannelName(db, slack, sourceChannel);
  const subs = await q.getSubscribersBySource(db, msg.channelId);
  if (subs.length === 0) {
    console.log(
      `forwardToSubscribers: no subscribers for channel ${msg.channelId}`,
    );
    return;
  }
  const existingPubActions = await q.getBotActionsBySource(
    db,
    msg.channelId,
    msg.slackTs,
  );
  const hasExistingForward = existingPubActions.some(
    (action) => action.type === "pub",
  );
  if (
    !metadataRequirementSatisfied(
      sourceChannel.metadataRequired,
      msg.metadata,
    ) &&
    !hasExistingForward
  ) {
    console.log(
      `forwardToSubscribers: metadata required for ${msg.slackTs}, skipping`,
    );
    return;
  }
  if (!(await shouldForward(msg, db)) && !hasExistingForward) {
    console.log(
      `forwardToSubscribers: shouldForward returned false for ${msg.slackTs}`,
    );
    return;
  }

  let permalink = "";
  try {
    const r = await slack.chat.getPermalink({
      channel: msg.channelId,
      message_ts: msg.slackTs,
    });
    permalink = (r as any)?.permalink || "";
  } catch { }
  if (!permalink) {
    const slackTsClean = msg.slackTs.replace(".", "");
    permalink = `https://slack.com/archives/${msg.channelId}/p${slackTsClean}`;
  }
  const msgDate = new Date(msg.timestamp);
  const dateStr = `${msgDate.getFullYear()}-${msgDate.getMonth() + 1}-${msgDate.getDate()}`;

  const originalAuthor = extractOriginalAuthor(msg);
  let displayName = originalAuthor.userName || msg.userName || "unknown";
  let avatarUrl = "";

  const attributionUserId =
    originalAuthor.userId || (originalAuthor.userName ? "" : msg.userId);
  if (attributionUserId) {
    const profile = await resolveAttributionProfile(slack, attributionUserId);
    if (profile) {
      displayName = profile.name;
      avatarUrl = profile.icon;
    }
  }

  for (const sub of subs) {
    const existingForward = findExistingForward(
      existingPubActions,
      sub.subscriberChannelId,
    );
    const subCh = await q.getChannel(db, sub.subscriberChannelId);
    if (!subCh) {
      console.warn(
        `Subscriber channel ${sub.subscriberChannelId} is not cached; attempting delivery by Slack channel ID`,
      );
    } else {
      await syncChannelName(db, slack, subCh);
    }

    // Get the link to forward from the message text or the computed permalink.
    let forwardLink = "";
    let originalAuthorName = "";
    let originalAuthorAvatar = "";
    let originalText = "";

    // Check if text is a Slack permalink
    if (isSlackPermalink(msg.text)) {
      forwardLink = msg.text.trim();
    }
    if (!forwardLink) forwardLink = permalink;

    // Link mode: don't fetch/repost the original text
    if (sourceChannel.linkMode) {
      originalText = "";
    }
    // If we have a Slack permalink and we're not in link mode, try to fetch the original message details
    if (
      !sourceChannel.linkMode &&
      forwardLink &&
      forwardLink.includes("slack.com/archives/")
    ) {
      const permalinkMatch = forwardLink.match(
        /\/archives\/([A-Z0-9]+)\/p(\d+)/,
      );
      if (permalinkMatch) {
        const origChannel = permalinkMatch[1]!;
        const origTs =
          permalinkMatch[2]!.slice(0, 10) + "." + permalinkMatch[2]!.slice(10);
        try {
          const history = await slack.conversations.history({
            channel: origChannel,
            latest: origTs,
            limit: 1,
            inclusive: true,
          });
          const origMsg = history.messages?.[0] as any;
          if (origMsg) {
            const liveText = extractMessageText(origMsg);
            const storedMsg = await q
              .getMessageBySlackTs(db, origChannel, origTs)
              .catch(() => null);
            originalText =
              storedMsg?.text && storedMsg.text.length >= liveText.length
                ? storedMsg.text
                : liveText;
            const origAuthorId = origMsg.user || origMsg.bot_id;
            if (origAuthorId) {
              const profile = await resolveAttributionProfile(
                slack,
                origAuthorId,
              );
              originalAuthorName =
                profile?.name || origMsg.username || origAuthorId;
              originalAuthorAvatar = profile?.icon || "";
            }
          }
        } catch { }
      }
    }

    // Use original author details if available, otherwise use the forwarder
    const postUsername = originalAuthorName || displayName;
    const postIcon = originalAuthorAvatar || avatarUrl || undefined;

    // Per-sub profile override: a sub channel can pin a static bot username /
    // pfp, or reference a static [property] on the source channel. Falls back
    // to the original author details above when unset or unresolved.
    let props: Record<string, unknown> | null = null;
    if (sourceChannel.properties && sourceChannel.properties !== "{}") {
      try {
        const parsed = JSON.parse(sourceChannel.properties);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          props = parsed;
        }
      } catch {
        props = null;
      }
    }
    const resolvedSubName = resolveSubProfileValue(sub.profileName, props);
    const resolvedSubIcon = resolveSubProfileValue(sub.profileImageUrl, props);
    const effectiveUsername = resolvedSubName ?? postUsername;
    const effectiveIcon = resolvedSubIcon ?? postIcon;

    // Build the context footer
    // If this message has a forwardLink to another channel, show the full chain
    let footerText: string;
    if (forwardLink && !forwardLink.includes(msg.channelId)) {
      // This is a forward from another channel — extract the original source
      const fm = forwardLink.match(/\/archives\/([A-Z0-9]+)/);
      const origSourceChannel = fm ? fm[1] : "";
      let origSourceName = origSourceChannel;
      if (origSourceChannel) {
        const origCh = await q.getChannel(db, origSourceChannel);
        if (origCh?.name) origSourceName = origCh.name;
      }
      footerText = `📰 Forwarded from <#${msg.channelId}|${sourceChannel.name}> from <#${origSourceChannel}|${origSourceName}> — <${permalink}|view source from ${dateStr}>`;
    } else {
      footerText = `📰 Forwarded from <#${msg.channelId}|${sourceChannel.name}> — <${permalink}|view original from ${dateStr}>`;
    }
    const contextElements = [{ type: "mrkdwn", text: footerText }];

    const parsedMetadata =
      msg.metadata && msg.metadata != ""
        ? typeof msg.metadata === "string"
          ? JSON.parse(msg.metadata)
          : msg.metadata
        : null;
    const parsedSchema = sourceChannel.metadataSchema
      ? JSON.parse(sourceChannel.metadataSchema)
      : null;
    const metadataLines =
      parsedMetadata && parsedSchema
        ? Object.keys(parsedMetadata)
          .filter((metaProp) => isMetadataValueSet(parsedMetadata[metaProp]))
          .map((metaProp) => {
            const field = parsedSchema.fields?.find(
              (e: any) => e.action_id === metaProp,
            );
            return `*${field?.label || metaProp}:* ${parsedMetadata[metaProp]}`;
          })
        : [];
    const metadataSection = metadataLines.length
      ? metadataLines.join("\n") + "\n"
      : "";
    const staticSection = formatStaticMetadata(sourceChannel.staticMetadata);
    const staticBlocks = staticSection
      ? [
        {
          type: "section",
          block_id: "indigest_static_metadata",
          text: { type: "mrkdwn", text: staticSection },
        },
      ]
      : [];

    console.log(
      "metadata:",
      parsedMetadata,
      "schema:",
      sourceChannel.metadataSchema,
    );

    try {
      if (sourceChannel.linkMode) {
        const payload: any = {
          username: effectiveUsername,
          icon_url: effectiveIcon,
          unfurl_links: false,
          unfurl_media: false,
          text: [staticSection, metadataSection.trim(), footerText]
            .filter(Boolean)
            .join("\n"),
          blocks: [
            ...staticBlocks,
            ...(metadataSection
              ? [
                {
                  type: "section",
                  block_id: "indigest_metadata",
                  text: { type: "mrkdwn", text: metadataSection.trim() },
                },
              ]
              : []),
            { type: "context", elements: [{ type: "mrkdwn", text: footerText }] },
          ],
        };
        const res = existingForward
          ? await slack.chat.update({
            channel: sub.subscriberChannelId,
            ts: existingForward.botMessageTs,
            text: payload.text,
            ...(payload.blocks ? { blocks: payload.blocks } : {}),
          } as any)
          : await slack.chat.postMessage({
            channel: sub.subscriberChannelId,
            ...payload,
          } as any);
        if (!existingForward && res?.ts) {
          await q.addBotAction(db, {
            type: "pub",
            sourceChannelId: msg.channelId,
            sourceMessageTs: msg.slackTs,
            botChannelId: sub.subscriberChannelId,
            botMessageTs: res.ts,
            createdAt: "",
          });
        }
        continue;
      }

      const messageText = originalText
        ? originalText
        : forwardLink
          ? `<${forwardLink}|🔗 View forwarded message>`
          : msg.text || "_[no text]_";
      const blocks: any[] = [
        ...staticBlocks,
        ...chunkLongText(messageText, MAX_BLOCK_TEXT).map((chunk) => ({
          type: "section",
          text: { type: "mrkdwn", text: chunk },
        })),
      ];
      if (metadataSection) {
        blocks.push({
          type: "section",
          block_id: "indigest_metadata",
          text: { type: "mrkdwn", text: metadataSection.trim() },
        });
      }
      blocks.push({ type: "context", elements: contextElements });
      const payload: any = {
        username: effectiveUsername,
        icon_url: effectiveIcon,
        unfurl_links: false,
        unfurl_media: false,
        text: (
          (staticSection ? staticSection + "\n" : "") +
          (originalText
            ? `📰 *${effectiveUsername}* in #${sourceChannel.name}:\n${originalText}`
            : forwardLink
              ? `📰 Forwarded from #${sourceChannel.name}\n${forwardLink}`
              : `📰 *${displayName}* in #${sourceChannel.name}:\n${msg.text}`)
        ).slice(0, MAX_MESSAGE_TEXT),
        blocks,
      };
      const res = existingForward
        ? await slack.chat.update({
          channel: sub.subscriberChannelId,
          ts: existingForward.botMessageTs,
          text: payload.text,
          blocks: payload.blocks,
        } as any)
        : await slack.chat.postMessage({
          channel: sub.subscriberChannelId,
          ...payload,
        });
      if (!existingForward && res?.ts) {
        await q.addBotAction(db, {
          type: "pub",
          sourceChannelId: msg.channelId,
          sourceMessageTs: msg.slackTs,
          botChannelId: sub.subscriberChannelId,
          botMessageTs: res.ts,
          createdAt: "",
        });
      }
    } catch (err: any) {
      console.error(
        `Failed to forward to ${sub.subscriberChannelId}:`,
        err?.data || err?.message || err,
      );
    }
  }
}

// --- Hono App ---

const app = new Hono<{ Bindings: Env }>();

// --- oRPC ---
const openAPIHandler = new OpenAPIHandler(router, {
  plugins: [new ZodSmartCoercionPlugin()],
});

const rpcHandler = new RPCHandler(router, {
  plugins: [new ZodSmartCoercionPlugin()],
});

const openAPIGenerator = new OpenAPIGenerator({
  schemaConverters: [new ZodToJsonSchemaConverter()],
});

app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth/")) return next();

  const dbUrl = getDbUrl(c.env);
  const db = getDb(dbUrl);

  let session: ORPCContext["session"] = null;
  let apiKey: ORPCContext["apiKey"] = null;

  // Resolve session from cookies
  try {
    const auth = getAuth(dbUrl, c.env as any);
    const s = await auth.api.getSession({ headers: c.req.raw.headers });
    if (s?.user) {
      session = { user: s.user as any };
    }
  } catch (err: any) {
    console.error("Session resolution error:", err.message);
  }

  // Resolve API key from Bearer token (if present)
  const authHeader = c.req.header("Authorization") || "";
  if (authHeader.startsWith("Bearer ")) {
    try {
      apiKey = await createApiKeyContext({
        req: c.req.raw,
        databaseUrl: dbUrl,
      });
    } catch (err: any) {
      // A rejected key gets its real reason; anything else (e.g. the
      // database being down) is logged and reported as a 503 rather than
      // passed off as a missing key.
      if (err instanceof ORPCError && err.code === "UNAUTHORIZED") {
        return c.json({ error: "unauthorized", message: err.message }, 401);
      }
      console.error("API key resolution error:", err?.message || err);
      c.header("Retry-After", "5");
      return c.json(
        { error: "unavailable", message: "Could not verify API key" },
        503,
      );
    }
  }

  const ctx: ORPCContext = {
    db,
    session,
    apiKey,
    databaseUrl: dbUrl,
    slackToken: c.env.SLACK_BOT_TOKEN || "",
    lockdownUsers: (c.env.LOCKDOWN_USERS || "")
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean),
    request: {
      ip: c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || null,
      userAgent: c.req.header("user-agent") || null,
    },
  };

  const { matched: openMatched, response: openResponse } =
    await openAPIHandler.handle(c.req.raw, {
      prefix: "/api",
      context: ctx,
    });
  if (openMatched) return c.newResponse(openResponse.body, openResponse);

  const { matched: rpcMatched, response: rpcResponse } =
    await rpcHandler.handle(c.req.raw, {
      context: ctx,
      prefix: "/api",
    });
  if (rpcMatched) return c.newResponse(rpcResponse.body, rpcResponse);
  await next();
});

app.get("/docs", (c) => {
  const html = `<!doctype html>
<html>
  <head>
    <title>Indigest API</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <div id="app"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
    <script>
      Scalar.createApiReference('#app', {
        url: '/spec.json',
        authentication: {
          preferredSecurityScheme: 'BearerAuth',
        },
      })
    </script>
  </body>
</html>`;
  return c.html(html);
});

let authDbReady: Record<string, Promise<void>> = {};
app.on(["POST", "GET"], "/api/auth/*", async (c) => {
  try {
    const dbUrl = getDbUrl(c.env);
    const auth = getAuth(dbUrl, c.env as any);
    return auth.handler(c.req.raw);
  } catch (err: any) {
    console.error("Auth handler error:", err.message, err.stack);
    return c.json({ error: "auth handler failed" }, 500);
  }
});

// GitHub stars cache
let cachedStars: number | null = null;
let starsFetchedAt = 0;
const STARS_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function getGithubStars(): Promise<number> {
  if (cachedStars !== null && Date.now() - starsFetchedAt < STARS_CACHE_TTL)
    return cachedStars;
  try {
    const res = await fetch("https://api.github.com/repos/matmanna/indigest", {
      headers: {
        "User-Agent": "indigest-bot",
        Accept: "application/vnd.github.v3+json",
      },
    });
    const data = (await res.json()) as any;
    if (typeof data.stargazers_count === "number") {
      cachedStars = data.stargazers_count;
      starsFetchedAt = Date.now();
    }
  } catch { }
  if (cachedStars !== null) return cachedStars;
  return 0;
}

// Public site configuration used by the static frontend.
app.get("/site-config", async (c) => {
  c.header("Cache-Control", "no-store");
  const env = c.env;
  const ids = (env.LOCKDOWN_USERS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const [lockdownUsers, githubStars] = await Promise.all([
    ids.length === 0
      ? Promise.resolve([])
      : (async () => {
        const slack = new WebClient(env.SLACK_BOT_TOKEN);
        return Promise.all(
          ids.map(async (id) => {
            let name = id;
            try {
              const response = await slack.users.info({ user: id });
              const user = response.user as any;
              name =
                user?.profile?.display_name ||
                user?.name ||
                user?.real_name ||
                id;
            } catch { }
            return {
              id,
              name,
              url: `https://hackclub.enterprise.slack.com/team/${id}`,
            };
          }),
        );
      })(),
    getGithubStars(),
  ]);

  return c.json({ lockdownUsers, githubStars });
});

// === Scalar API Docs ===
app.get("/spec.json", (c) => {
  const spec = {
    openapi: "3.1.0",
    info: {
      title: "Indigest API",
      version: "1.0.0",
      description: "A Slack bot that curates messages into digestible feeds",
    },
    servers: [{ url: "/" }],
    security: [{ BearerAuth: [] }],
    paths: {
      "/feed/{channelId}": {
        get: {
          operationId: "getFeed",
          summary: "Get channel feed",
          description:
            "Returns an RSS feed or JSON feed of messages for a channel. Requires auth if accessPermUsers is not *.",
          tags: ["Feed"],
          security: [{ BearerAuth: [] }, { session: [] }],
          parameters: [
            {
              name: "channelId",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Slack channel ID",
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", default: 50, maximum: 200 },
            },
            {
              name: "offset",
              in: "query",
              schema: { type: "integer", default: 0 },
            },
            {
              name: "api_key",
              in: "query",
              schema: { type: "string" },
              description: "API key (alternative to Authorization header)",
            },
          ],
          responses: {
            "200": {
              description:
                "RSS feed (application/rss+xml) or JSON array depending on Accept header or .json suffix",
            },
            "403": {
              description: "Forbidden — no access to this feed",
            },
          },
        },
      },
      "/api/messages": {
        get: {
          operationId: "listMessages",
          summary: "List messages",
          description:
            "List messages for a channel with filtering and pagination. Requires auth if accessPermUsers is not *.",
          tags: ["Messages"],
          security: [{ BearerAuth: [] }, { session: [] }],
          parameters: [
            {
              name: "channel",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "Slack channel ID",
            },
            {
              name: "after",
              in: "query",
              schema: { type: "string", format: "date-time" },
              description: "Filter messages after this timestamp",
            },
            {
              name: "before",
              in: "query",
              schema: { type: "string", format: "date-time" },
              description: "Filter messages before this timestamp",
            },
            {
              name: "userId",
              in: "query",
              schema: { type: "string" },
              description: "Filter by Slack user ID",
            },
            {
              name: "threadTs",
              in: "query",
              schema: { type: "string" },
              description: "Filter by thread parent timestamp",
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", default: 50, maximum: 10000 },
            },
            {
              name: "page",
              in: "query",
              schema: { type: "integer", default: 1 },
            },
          ],
          responses: {
            "200": {
              description: "Paginated list of messages",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      data: {
                        type: "array",
                        items: { $ref: "#/components/schemas/Message" },
                      },
                      pagination: { $ref: "#/components/schemas/Pagination" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/messages/{slackTs}": {
        get: {
          operationId: "getMessage",
          summary: "Get message",
          description:
            "Get a single message by its Slack timestamp. Requires auth if accessPermUsers is not *.",
          tags: ["Messages"],
          security: [{ BearerAuth: [] }, { session: [] }],
          parameters: [
            {
              name: "slackTs",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Slack message timestamp",
            },
            {
              name: "channel",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "Slack channel ID",
            },
          ],
          responses: {
            "200": {
              description: "Single message",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/Message" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/channels": {
        get: {
          operationId: "listChannels",
          summary: "List channels",
          description:
            "List all channels known to indigest (enabled and disabled).",
          tags: ["Channels"],
          security: [{ basicAuth: [] }],
          responses: {
            "200": {
              description: "All channels",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      data: {
                        type: "array",
                        items: { $ref: "#/components/schemas/Channel" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/channels/{id}": {
        get: {
          operationId: "getChannel",
          summary: "Get channel",
          description: "Get a single channel by Slack channel ID.",
          tags: ["Channels"],
          security: [{ basicAuth: [] }],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Slack channel ID",
            },
          ],
          responses: {
            "200": {
              description: "Single channel",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      data: { $ref: "#/components/schemas/Channel" },
                    },
                  },
                },
              },
            },
            "404": {
              description: "Channel not found",
            },
          },
        },
      },
      "/api/channels/by-user/{userId}": {
        get: {
          operationId: "listChannelsByUser",
          summary: "List channels by user",
          description:
            "List channels the user has access to based on accessPermUsers.",
          tags: ["Channels"],
          security: [{ BearerAuth: [] }, { session: [] }],
          parameters: [
            {
              name: "userId",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Better Auth user ID",
            },
          ],
          responses: {
            "200": {
              description: "Channels the user can access",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Channel" },
                  },
                },
              },
            },
          },
        },
      },
      "/api/subscriptions": {
        get: {
          operationId: "listSubscriptions",
          summary: "List subscriptions",
          description:
            "List all subscriber channels for a given source channel.",
          tags: ["Subscriptions"],
          parameters: [
            {
              name: "sourceChannelId",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "Source Slack channel ID",
            },
          ],
          responses: {
            "200": {
              description: "List of subscriptions",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Subscription" },
                  },
                },
              },
            },
          },
        },
        post: {
          operationId: "addSubscription",
          summary: "Add subscription",
          description: "Subscribe a channel to a source channel.",
          tags: ["Subscriptions"],
          security: [{ BearerAuth: [] }, { session: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["subscriberChannelId", "sourceChannelId"],
                  properties: {
                    subscriberChannelId: {
                      type: "string",
                      description: "Channel to receive forwards",
                    },
                    sourceChannelId: {
                      type: "string",
                      description: "Channel to forward from",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Subscription created" },
          },
        },
        delete: {
          operationId: "removeSubscription",
          summary: "Remove subscription",
          description: "Unsubscribe a channel from a source channel.",
          tags: ["Subscriptions"],
          security: [{ BearerAuth: [] }, { session: [] }],
          parameters: [
            {
              name: "subscriberChannelId",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "Channel to unsubscribe",
            },
            {
              name: "sourceChannelId",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "Source channel to unsubscribe from",
            },
          ],
          responses: {
            "200": { description: "Subscription removed" },
          },
        },
      },
      "/api/subscriptions/by-subscriber": {
        get: {
          operationId: "listSubscriptionsBySubscriber",
          summary: "List subscriptions by subscriber",
          description:
            "List all source channels a subscriber channel is subscribed to.",
          tags: ["Subscriptions"],
          parameters: [
            {
              name: "subscriberChannelId",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "Subscriber Slack channel ID",
            },
          ],
          responses: {
            "200": {
              description: "List of subscriptions",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Subscription" },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "API Key",
          description: "API key (ind_...)",
        },
        session: {
          type: "apiKey",
          in: "cookie",
          name: "better-auth.session_token",
          description: "Session cookie (browser login)",
        },
      },
      schemas: {
        Channel: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            teamId: { type: "string" },
            enabled: { type: "boolean" },
            linkMode: { type: "boolean" },
            webhookUrl: { type: "string" },
            autoApproveUsers: { type: "array", items: { type: "string" } },
            manualUsers: { type: "array", items: { type: "string" } },
            approvedPosters: { type: "array", items: { type: "string" } },
            trackReplies: { type: "boolean" },
            metadataSchema: { type: "string" },
            metadataRequired: { type: "boolean" },
            properties: { type: "string" },
            createdAt: { type: "string" },
          },
        },
        Message: {
          type: "object",
          properties: {
            slackTs: { type: "string" },
            channelId: { type: "string" },
            userId: { type: "string" },
            userName: { type: "string" },
            authorIds: { type: "array", items: { type: "string" } },
            authorNames: { type: "array", items: { type: "string" } },
            text: { type: "string" },
            timestamp: { type: "string", format: "date-time" },
            metadata: { type: "object" },
          },
        },
        Pagination: {
          type: "object",
          properties: {
            page: { type: "integer" },
            limit: { type: "integer" },
            total: { type: "integer" },
            total_pages: { type: "integer" },
          },
        },
        Subscription: {
          type: "object",
          properties: {
            id: { type: "integer" },
            subscriberChannelId: { type: "string" },
            sourceChannelId: { type: "string" },
            profileName: { type: "string", nullable: true },
            profileImageUrl: { type: "string", nullable: true },
            createdAt: { type: "string" },
          },
        },
      },
    },
  };
  return c.json(spec);
});

// === Slack Events ===
app.post("/events", async (c) => {
  const env = c.env;
  const body = await c.req.text();
  const payload = JSON.parse(body);

  if (payload.type === "url_verification") {
    return c.text(payload.challenge, 200, { "Content-Type": "text/plain" });
  }

  if (!(await verifySignature(c.req.raw, body, env.SLACK_SIGNING_SECRET))) {
    return c.json({ error: "invalid signature" }, 401);
  }

  // Respond immediately to prevent Slack retries
  c.res = new Response("ok", {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });

  c.executionCtx.waitUntil(
    (async () => {
      console.log(
        "Received Slack event:",
        payload.event?.type,
        "thread_ts:",
        payload.event?.thread_ts,
        "channel:",
        payload.event?.channel,
      );
      const ev = payload.event;
      const db = getDb(getDbUrl(env));
      const slack = new WebClient(env.SLACK_BOT_TOKEN);

      if (ev.type === "member_joined_channel") {
        const auth = await slack.auth.test();
        if (ev.user !== auth.user_id) return;
        const existing = await q.getChannel(db, ev.channel);
        if (existing) {
          try {
            const conv = await slack.conversations.info({ channel: ev.channel });
            const name = (conv.channel as any)?.name || "";
            if (name && name !== existing.name) {
              existing.name = name;
              await q.upsertChannel(db, existing);
            }
          } catch { }
          return;
        }
        const ch: StoreChannel = {
          id: ev.channel,
          name: "",
          teamId: auth.team_id || "",
          enabled: false,
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
          properties: "",
          staticMetadata: "",
          createdAt: "",
        };
        await q.upsertChannel(db, ch);
        try {
          const conv = await slack.conversations.info({ channel: ev.channel });
          ch.name = (conv.channel as any)?.name || "";
          await q.upsertChannel(db, ch);
        } catch { }
      }

      // Handled before the message branches below: a deletion event has no
      // thread_ts of its own, and those branches would drop it.
      if (ev.type === "message" && ev.subtype === "message_deleted") {
        const marked = await handleMessageDeleted(db, ev);
        console.log(
          `Message deleted: channel=${ev.channel} ts=${ev.deleted_ts} marked=${marked}`,
        );
        return;
      }

      if (ev.type === "channel_rename") {
        const renamedChannelId = ev.channel?.id || ev.channel_id;
        const renamedName = ev.channel?.name || ev.name;
        if (renamedChannelId && renamedName) {
          const renamedChannel = await q.getChannel(db, renamedChannelId);
          if (renamedChannel) {
            renamedChannel.name = renamedName;
            await q.upsertChannel(db, renamedChannel);
          }
        }
        return;
      }

      if (ev.type === "message" && !ev.thread_ts) {
        const ch = await q.getChannel(db, ev.channel);
        if (!ch || !ch.enabled) return;

        let selfUserId: string | undefined;
        let selfBotId: string | undefined;
        if (ev.subtype === "bot_message") {
          const auth = await slack.auth.test();
          selfUserId = auth.user_id;
          selfBotId = (auth as any).bot_id;
        }
        const admission = resolveMessageAdmission({
          subtype: ev.subtype,
          user: ev.user,
          botId: ev.bot_id,
          selfUserId,
          selfBotId,
          autoApproveUsers: ch.autoApproveUsers,
          manualUsers: ch.manualUsers,
          triggerMode: ch.triggerMode,
        });
        if (!admission.allowed) return;

        await syncChannelName(db, slack, ch);
        logMessageContentProbe("incoming", ev);

        // Log full event for debugging empty forward messages
        if (!ev.text && !ev.subtype) {
          console.log(
            "Empty message event:",
            JSON.stringify({
              text: ev.text,
              subtype: ev.subtype,
              attachments: ev.attachments,
              files: ev.files,
              x_files: ev.x_files,
              user: ev.user,
            }),
          );
        }

        const disposition = admission.disposition;

        if (disposition === "auto") {
          console.log(`Auto-approving message from ${ev.user} in #${ch.name}`);
          let userName = ev.user;
          try {
            const u = await slack.users.info({ user: ev.user });
            userName = (u.user as any)?.name || ev.user;
          } catch { }
          const metadata = {};
          const rawText = extractMessageText(ev);
          const text = resolveSlackMrkdwn(rawText);
          const originalAuthor = extractOriginalAuthor(ev);
          const storedTimestamp = resolveMessageTimestamp(ev, ev.ts);
          const storedAuthors = resolveStoredAuthors(ev, ev.user, userName);

          await q.upsertMessage(db, {
            slackTs: ev.ts,
            channelId: ev.channel,
            userId: storedAuthors.userId,
            userName: storedAuthors.userName,
            text,
            formattedText: extractMessageMrkdwn(ev),
            timestamp: storedTimestamp,
            metadata,
          });
          await q.addBotAction(db, {
            type: "approve",
            sourceChannelId: ev.channel,
            sourceMessageTs: ev.ts,
            botChannelId: ev.channel,
            botMessageTs: "0",
            command: "auto_approve",
            createdAt: "",
          });
          await fireWebhook(ch, {
            slackTs: ev.ts,
            channelId: ev.channel,
            userId: storedAuthors.userId,
            userName: storedAuthors.userName,
            text,
            timestamp: storedTimestamp,
            metadata,
          });
          await forwardToSubscribers(
            {
              slackTs: ev.ts,
              channelId: ev.channel,
              userId: ev.user,
              userName,
              text,
              rawText,
              originalUserId: originalAuthor.userId,
              originalUserName: originalAuthor.userName,
              timestamp: storedTimestamp,
              metadata,
            },
            ch,
            db,
            slack,
          );
          // if (ch.linkMode) await postPermalinkReply(slack, ev.channel, ev.ts);

          // If channel has a metadata schema, prompt the user to add metadata
          if (ch.metadataSchema) {
            let schema: any = null;
            try {
              schema = JSON.parse(ch.metadataSchema);
            } catch { }
            if (schema && schema.fields?.length > 0) {
              try {
                await slack.chat.postMessage({
                  channel: ev.channel,
                  thread_ts: ev.ts,
                  text: "Your message has been posted to the feed!",
                  blocks: [
                    {
                      type: "section",
                      text: {
                        type: "mrkdwn",
                        text: "📰 Your message has been posted to the feed! Would you like to add some extra data?",
                      },
                      accessory: {
                        type: "button",
                        action_id: "indigest_metadata",
                        text: { type: "plain_text", text: "Add Metadata" },
                        value: ev.ts,
                        style: "primary" as const,
                      },
                    },
                  ],
                });
              } catch { }
            }
          }
        } else if (disposition === "prompt") {
          // Non-auto-approve: prompt for manual approval
          const section = {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "Expose this message to indigest via RSS and API?",
            },
          };
          const actions = {
            type: "actions",
            elements: [
              {
                type: "button",
                action_id: "indigest_yes",
                text: { type: "plain_text", text: "Yep!" },
                value: ev.ts,
              },
              {
                type: "button",
                action_id: "indigest_no",
                text: { type: "plain_text", text: "No thanks" },
                style: "danger" as const,
                value: ev.ts,
              },
            ],
          };
          try {
            await slack.chat.postMessage({
              channel: ev.channel,
              thread_ts: ev.ts,
              text: "Expose this message to indigest via RSS and API?",
              blocks: [section, actions],
            });
          } catch { }
        }
      }

      // Thread reply tracking (separate from the top-level message handler above)
      if (ev.type === "message" && !ev.subtype && ev.thread_ts) {
        console.log(
          `Thread reply: channel=${ev.channel} thread_ts=${ev.thread_ts} ts=${ev.ts}`,
        );
        const ch = await q.getChannel(db, ev.channel);
        console.log(
          `Channel lookup: ch=${!!ch} enabled=${ch?.enabled} trackReplies=${ch?.trackReplies}`,
        );
        if (!ch || !ch.enabled || !ch.trackReplies) return;

        // Store the parent message if not already stored
        const existingParent = (
          await q.getMessages(db, ev.channel, { limit: 200 })
        ).find((m) => m.slackTs === ev.thread_ts);
        if (!existingParent) {
          try {
            const parentHistory = await slack.conversations.history({
              channel: ev.channel,
              latest: ev.thread_ts!,
              limit: 1,
              inclusive: true,
            });
            const parentMsg = parentHistory.messages?.[0] as any;
            if (parentMsg && !parentMsg.subtype) {
              let parentUserName = parentMsg.user || "";
              try {
                const u = await slack.users.info({ user: parentMsg.user });
                parentUserName = (u.user as any)?.name || parentMsg.user;
              } catch { }
              await q.upsertMessage(db, {
                slackTs: ev.thread_ts!,
                channelId: ev.channel,
                userId: parentMsg.user || "",
                userName: parentUserName,
                text: resolveSlackMrkdwn(extractMessageText(parentMsg)),
                formattedText: extractMessageMrkdwn(parentMsg),
                timestamp: slackTsToTime(ev.thread_ts!).toISOString(),
                metadata: {},
              });
            }
          } catch { }
        }

        // Store the reply
        let userName = ev.user;
        try {
          const u = await slack.users.info({ user: ev.user });
          userName = (u.user as any)?.name || ev.user;
        } catch { }
        await q.upsertMessage(db, {
          slackTs: ev.ts,
          channelId: ev.channel,
          threadTs: ev.thread_ts,
          userId: ev.user,
          userName,
          text: resolveSlackMrkdwn(ev.text),
          // The reply's text comes from ev.text alone, so its mrkdwn does too.
          formattedText: extractMessageMrkdwn({ text: ev.text }),
          timestamp: slackTsToTime(ev.ts).toISOString(),
          metadata: {},
        });
        console.log(
          `Thread reply stored: ts=${ev.ts} threadTs=${ev.thread_ts}`,
        );
      }
    })(),
  );
});

// === Interactive Components ===
app.post("/interactions", async (c) => {
  const env = c.env;
  const body = await c.req.text();
  if (!(await verifySignature(c.req.raw, body, env.SLACK_SIGNING_SECRET))) {
    return c.json({ error: "invalid signature" }, 401);
  }
  const formData = new URLSearchParams(body);
  const payloadStr = formData.get("payload");
  if (!payloadStr) return c.json({ error: "missing payload" }, 400);

  const cb = JSON.parse(payloadStr);

  // Metadata modal must open BEFORE responding — trigger_id expires in 3 seconds
  if (cb.type === "block_actions") {
    const action = cb.actions?.[0];
    if (
      action?.action_id === "indigest_metadata" ||
      action?.action_id === "indigest_edit_metadata"
    ) {
      const db = getDb(getDbUrl(env));
      const slack = new WebClient(env.SLACK_BOT_TOKEN);
      const channelId = cb.channel?.id;
      const messageTs = action.value;
      const triggerId = cb.trigger_id;
      const responseUrl = cb.response_url;

      const ch = await q.getChannel(db, channelId);
      if (!ch || !ch.enabled || !ch.metadataSchema) {
        return c.json({
          response_action: "update",
          view: {
            type: "modal",
            title: { type: "plain_text", text: "Error" },
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: "No metadata schema configured for this channel.",
                },
              },
            ],
          },
        });
      }
      let schema: any = null;
      try {
        schema = JSON.parse(ch.metadataSchema);
      } catch { }
      if (!schema || schema.fields?.length === 0) {
        return c.json({
          response_action: "update",
          view: {
            type: "modal",
            title: { type: "plain_text", text: "Error" },
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: "No metadata schema configured for this channel.",
                },
              },
            ],
          },
        });
      }
      const { openMetadataModal } = await import("./api/modal");
      let initialMetadata: Record<string, any> = {};
      if (action.action_id === "indigest_edit_metadata") {
        const storedMessage = await q.getMessageBySlackTs(
          db,
          channelId,
          messageTs,
        );
        if (storedMessage?.metadata) {
          try {
            initialMetadata =
              typeof storedMessage.metadata === "string"
                ? JSON.parse(storedMessage.metadata)
                : storedMessage.metadata;
          } catch { }
        }
      }
      try {
        await openMetadataModal(
          slack,
          triggerId,
          channelId,
          messageTs,
          schema,
          cb.container?.message_ts,
          false,
          initialMetadata,
        );
      } catch (err: any) {
        return c.json({
          response_action: "update",
          view: {
            type: "modal",
            title: { type: "plain_text", text: "Error" },
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `Error opening form: ${err.message}`,
                },
              },
            ],
          },
        });
      }

      // Permission check after modal opens
      c.executionCtx.waitUntil(
        (async () => {
          const clickingUser = cb.user?.id || "";
          const lockdownUsers = (env.LOCKDOWN_USERS || "")
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean);
          const isLockdown = lockdownUsers.includes(clickingUser);
          const isManager = isLockdown
            ? false
            : await isChannelManager(channelId, clickingUser, slack);
          const msgs = await q.getMessages(db, channelId, { limit: 100 });
          const originalMsg = msgs.find((m) => m.slackTs === messageTs);
          let messageUser = originalMsg?.userId || "";
          if (!messageUser) {
            try {
              const history = await slack.conversations.history({
                channel: channelId,
                latest: messageTs,
                limit: 1,
                inclusive: true,
              });
              messageUser = (history.messages?.[0] as any)?.user || "";
            } catch { }
          }
          if (
            !canApproveMessage({
              approvedPosters: ch.approvedPosters,
              clickingUser,
              messageUser,
              isManager,
              isLockdown,
            })
          ) {
            await slack.chat.postEphemeral({
              channel: channelId,
              user: clickingUser,
              text: "❌ You don't have permission to edit metadata for this message.",
            });
          }
        })(),
      );
      return c.json({});
    }
  }

  if (cb.type === "message_action" && cb.callback_id === "edit_bot_message") {
    const channelId = cb.channel?.id;
    const messageTs = cb.message?.ts;
    const clickingUser = cb.user?.id || "";
    const slack = new WebClient(env.SLACK_BOT_TOKEN);
    const lockdownUsers = (env.LOCKDOWN_USERS || "")
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);

    if (!canEditBotMessage(clickingUser, lockdownUsers)) {
      if (channelId) {
        await slack.chat.postEphemeral({
          channel: channelId,
          user: clickingUser,
          text: "❌ Only lockdown users can edit bot messages.",
        });
      }
      return c.json({});
    }

    if (!channelId || !messageTs) return c.json({});
    try {
      const history = await slack.conversations.history({
        channel: channelId,
        latest: messageTs,
        limit: 1,
        inclusive: true,
      });
      const message = history.messages?.[0] as any;
      const auth = await slack.auth.test();
      const isOwnBotMessage =
        message &&
        (message.user === auth.user_id ||
          (message.bot_id && message.bot_id === (auth as any).bot_id));
      if (!isOwnBotMessage) {
        await slack.chat.postEphemeral({
          channel: channelId,
          user: clickingUser,
          text: "❌ This action can only edit messages posted by indigest.",
        });
        return c.json({});
      }

      const { openBotMessageEditModal } = await import("./api/modal");
      await openBotMessageEditModal(
        slack,
        cb.trigger_id,
        channelId,
        messageTs,
        message.text || "",
      );
    } catch (err: any) {
      if (channelId) {
        await slack.chat.postEphemeral({
          channel: channelId,
          user: clickingUser,
          text: `❌ Could not open the edit form: ${err.message}`,
        });
      }
    }
    return c.json({});
  }

  // Respond immediately for everything else to prevent Slack timeout
  c.res = new Response(JSON.stringify({}), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  c.executionCtx.waitUntil(
    (async () => {
      const db = getDb(getDbUrl(env));
      const slack = new WebClient(env.SLACK_BOT_TOKEN);

      if (
        cb.type === "view_submission" &&
        cb.view?.callback_id === "metadata_modal"
      ) {
        const privateMeta = JSON.parse(cb.view.private_metadata || "{}");
        const { channelId, messageTs, botMessageTs, apiOnly } = privateMeta;
        const channel = await q.getChannel(db, channelId);
        if (!channel || !channel.enabled) return;
        const client = new WebClient(env.SLACK_BOT_TOKEN);
        let approvalHistory: any = null;
        const storedOriginal = (
          await q.getMessages(db, channelId, { limit: 200 })
        ).find((m) => m.slackTs === messageTs);
        let approvalMessageUser = storedOriginal?.userId || "";
        if (!approvalMessageUser) {
          try {
            approvalHistory = await client.conversations.history({
              channel: channelId,
              latest: messageTs,
              limit: 1,
              inclusive: true,
            });
            approvalMessageUser =
              (approvalHistory.messages?.[0] as any)?.user || "";
          } catch {
            approvalMessageUser = "";
          }
        }

        // The modal may have been opened before authorization completed. The
        // submission is the final security boundary: reject unauthorized
        // users before parsing uploads, saving metadata, or forwarding.
        const clickingUser = cb.user?.id || "";
        const lockdownUsers = (env.LOCKDOWN_USERS || "")
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean);
        const isLockdown = lockdownUsers.includes(clickingUser);
        const isManager = isLockdown
          ? false
          : await isChannelManager(channelId, clickingUser, slack);
        if (!isManager && !isLockdown) {
          if (
            !canApproveMessage({
              approvedPosters: channel.approvedPosters,
              clickingUser,
              messageUser: approvalMessageUser,
              isManager: false,
              isLockdown: false,
            })
          ) {
            await slack.chat.postEphemeral({
              channel: channelId,
              user: clickingUser,
              text: "❌ You don't have permission to approve this message.",
            });
            return;
          }
        }

        let schema: any = null;
        try {
          schema = JSON.parse(channel.metadataSchema);
        } catch { }

        const metadata = schema
          ? await (async () => {
            const m: Record<string, any> = {};
            for (const field of schema.fields || []) {
              const values =
                cb.view.state?.values?.[`field_${field.action_id}`]?.[
                field.action_id
                ];
              if (!values) continue;
              if (field.type === "static_select") {
                // A single select reports its choice as selected_option, not value.
                if (values.selected_option?.value) {
                  m[field.action_id] = values.selected_option.value;
                }
              } else if (field.type === "multi_static_select") {
                if (values.selected_options?.length) {
                  m[field.action_id] = values.selected_options.map(
                    (o: any) => o.value,
                  );
                }
              } else if (field.type === "datepicker") {
                if (values.selected_date) {
                  m[field.action_id] = values.selected_date;
                }
              }
              else if (field.type === "file_input") {
                const files = values.files || [];
                if (files.length) {
                  m[field.action_id] = await Promise.all(
                    files.map(async (f: any) => {
                      if (!f.url_private) return { ...f, cdn_url: null };
                      const cdnUrl = await uploadToCDN(
                        f.url_private,
                        env.SLACK_BOT_TOKEN,
                        env.HACK_CLUB_CDN_KEY || "",
                      );
                      return { ...f, cdn_url: cdnUrl };
                    }),
                  );
                }
              } else if (values.value) {
                m[field.action_id] = values.value;
              }
            }
            return JSON.stringify(m);
          })()
          : "";

        if (channel.metadataRequired && !hasProvidedMetadata(metadata)) {
          await client.chat.postEphemeral({
            channel: channelId,
            user: clickingUser,
            text: "❌ Metadata is required before this message can be forwarded.",
          });
          return;
        }

        try {
          const history = approvalHistory || await client.conversations.history({
            channel: channelId,
            latest: messageTs,
            limit: 1,
            inclusive: true,
          });
          const msg = history.messages?.[0] as any;
          if (!msg) return;

          let userName = msg.user || "";
          try {
            const u = await client.users.info({ user: msg.user });
            userName = (u.user as any)?.name || userName;
          } catch { }

          const originalAuthor = extractOriginalAuthor(msg);
          const storedUserId = q.mergeAuthorLists(
            msg.user || "",
            originalAuthor.userId,
          );
          const storedUserName = q.mergeAuthorLists(
            userName,
            originalAuthor.userName,
          );
          const storedTimestamp = resolveMessageTimestamp(
            msg,
            messageTs,
            storedOriginal?.timestamp,
          );
          const storedAuthors = resolveStoredAuthors(
            msg,
            msg.user || "",
            userName,
          );

          const liveText = resolveSlackMrkdwn(extractMessageText(msg));
          const { text: forwardText, formattedText } =
            await resolveForwardContent(
              db,
              channelId,
              messageTs,
              liveText,
              extractMessageMrkdwn(msg),
            );

          await q.upsertMessage(db, {
            slackTs: messageTs,
            channelId,
            userId: storedAuthors.userId,
            userName: storedAuthors.userName,
            text: forwardText,
            formattedText,
            timestamp: storedTimestamp,
            metadata,
          });
          await q.addBotAction(db, {
            type: "approve",
            sourceChannelId: channelId,
            sourceMessageTs: messageTs,
            botChannelId: channelId,
            botMessageTs: botMessageTs || "0",
            userId: clickingUser,
            command: "metadata_submit",
            createdAt: "",
          });

          await fireWebhook(channel, {
            slackTs: messageTs,
            channelId,
            userId: storedAuthors.userId,
            userName: storedAuthors.userName,
            text: forwardText,
            timestamp: storedTimestamp,
            metadata,
          });

          // Build metadata section for editing subscriber messages
          const parsedMetadata = metadata ? JSON.parse(metadata) : null;
          const parsedSchema = channel.metadataSchema
            ? JSON.parse(channel.metadataSchema)
            : null;
          const metadataSection =
            parsedMetadata && parsedSchema
              ? Object.keys(parsedMetadata)
                .map((metaProp) => {
                  const field = parsedSchema.fields?.find(
                    (e: any) => e.action_id === metaProp,
                  );
                  return `*${field?.label || metaProp}:* ${parsedMetadata[metaProp]}`;
                })
                .join("\n")
              : "";

          // Find existing bot actions for this source message and edit them with metadata
          const botActions = await q.getBotActionsBySource(db,
            channelId,
            messageTs,
          );
          for (const action of botActions) {
            if (action.type === "pub" && metadataSection) {
              try {
                // Fetch the current bot message to get its blocks
                const botMsg = await client.conversations.history({
                  channel: action.botChannelId,
                  latest: action.botMessageTs,
                  limit: 1,
                  inclusive: true,
                });
                const existingMsg = botMsg.messages?.[0] as any;
                if (existingMsg?.blocks) {
                  const blocks = upsertMetadataBlock(
                    existingMsg.blocks,
                    metadataSection,
                  );
                  await client.chat.update({
                    channel: action.botChannelId,
                    ts: action.botMessageTs,
                    text: existingMsg.text || "",
                    blocks,
                  } as any);
                }
              } catch (err: any) {
                console.error(
                  `Failed to update bot message ${action.botChannelId}:${action.botMessageTs}:`,
                  err.message,
                );
              }
            }
          }

          // Also forward to any new subscribers that weren't captured in the initial forward
          if (!apiOnly) {
            const originalAuthor = extractOriginalAuthor(msg);
            await forwardToSubscribers(
              {
                slackTs: messageTs,
                channelId,
                userId: msg.user || "",
                userName,
                text: forwardText,
                rawText: extractMessageText(msg),
                originalUserId: originalAuthor.userId,
                originalUserName: originalAuthor.userName,
                timestamp: storedTimestamp,
                metadata,
              },
              channel,
              db,
              slack,
            );
          }
          // if (channel.linkMode) await postPermalinkReply(client, channelId, messageTs);

          // Update the bot's prompt to show approved state
          if (botMessageTs) {
            try {
              await client.chat.update({
                channel: channelId,
                ts: botMessageTs,
                text: "✅ Message approved and added to the feed!",
                blocks: approvedPromptBlocks(
                  messageTs,
                  Boolean(channel.metadataSchema),
                ),
              } as any);
            } catch (err: any) {
              console.error(
                "chat.update (view_submission) failed:",
                err.message,
              );
            }
          }
        } catch (err: any) {
          console.error("view_submission error:", err.message);
        }
        return;
      }

      if (
        cb.type === "view_submission" &&
        cb.view?.callback_id === "edit_bot_message_modal"
      ) {
        const privateMeta = JSON.parse(cb.view.private_metadata || "{}");
        const { channelId, messageTs } = privateMeta;
        const clickingUser = cb.user?.id || "";
        const lockdownUsers = (env.LOCKDOWN_USERS || "")
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean);
        if (!canEditBotMessage(clickingUser, lockdownUsers)) return;

        const value =
          cb.view.state?.values?.edit_message?.edit_message?.value || "";
        if (!channelId || !messageTs || !value.trim()) return;

        const history = await slack.conversations.history({
          channel: channelId,
          latest: messageTs,
          limit: 1,
          inclusive: true,
        });
        const message = history.messages?.[0] as any;
        const auth = await slack.auth.test();
        const isOwnBotMessage =
          message &&
          (message.user === auth.user_id ||
            (message.bot_id && message.bot_id === (auth as any).bot_id));
        if (!isOwnBotMessage) return;

        const update: any = {
          channel: channelId,
          ts: messageTs,
          text: value.trim(),
        };
        if (Array.isArray(message.blocks) && message.blocks.length > 0) {
          const blocks = message.blocks.map((block: any) => ({ ...block }));
          const edited = chunkLongText(value.trim(), MAX_BLOCK_TEXT).map(
            (chunk) => ({
              type: "section",
              text: { type: "mrkdwn", text: chunk },
            }),
          );
          const contextAndMetadata = blocks.filter(
            (block: any) =>
              block.type === "context" ||
              block.block_id === "indigest_metadata",
          );
          const staticMetadata = blocks.filter(
            (block: any) => block.block_id === "indigest_static_metadata",
          );
          update.blocks = [...staticMetadata, ...edited, ...contextAndMetadata];
        }
        await slack.chat.update(update);
        return;
      }

      // Backfill shortcuts: manually pub a message
      if (cb.type === "message_action") {
        const channelId = cb.channel?.id;
        const messageTs = cb.message?.ts;
        const triggerId = cb.trigger_id;
        const clickingUser = cb.user?.id || "";
        const apiOnly = cb.callback_id === "backfill_api_only";

        if (!channelId || !messageTs) {
          await slackResponse(
            cb.response_url || "",
            "Could not identify the message to backfill.",
          );
          return c.json({});
        }

        c.executionCtx.waitUntil(
          (async () => {
            const db = getDb(getDbUrl(env));
            const slack = new WebClient(env.SLACK_BOT_TOKEN);

            const lockdownUsers = (env.LOCKDOWN_USERS || "")
              .split(",")
              .map((s: string) => s.trim())
              .filter(Boolean);
            const isLockdown = lockdownUsers.includes(clickingUser);
            const isManager =
              isLockdown ||
              (await isChannelManager(channelId, clickingUser, slack));

            if (!isManager) {
              const ch = await q.getChannel(db, channelId);
              if (!ch || !ch.enabled) {
                await slack.chat.postEphemeral({
                  channel: channelId,
                  user: clickingUser,
                  text: "❌ This channel isn't enabled for indigest. Run `/in pub` first.",
                });
                return;
              }
            }

            try {
              const history = await slack.conversations.history({
                channel: channelId,
                latest: messageTs,
                limit: 1,
                inclusive: true,
              });
              const msg = history.messages?.[0] as any;
              if (!msg) {
                await slack.chat.postEphemeral({
                  channel: channelId,
                  user: clickingUser,
                  text: "❌ That message can't be added to the feed (system message).",
                });
                return;
              }

              let userName = msg.user || "";
              const userId = msg.user || msg.bot_id || "";
              if (msg.user) {
                try {
                  const u = await slack.users.info({ user: msg.user });
                  userName = (u.user as any)?.name || msg.user;
                } catch { }
              } else if (msg.bot_id) {
                userName = msg.username || msg.bot_id;
              }

              const originalAuthor = extractOriginalAuthor(msg);
              const storedUserId = q.mergeAuthorLists(userId, originalAuthor.userId);
              const storedUserName = q.mergeAuthorLists(userName, originalAuthor.userName);
              const storedTimestamp = resolveMessageTimestamp(msg, messageTs);
              const storedAuthors = resolveStoredAuthors(msg, userId, userName);

              const metadata = {};

              const ch = await q.getChannel(db, channelId);

              // If channel has a metadata schema, open modal instead of posting immediately
              if (ch?.metadataSchema) {
                let schema: any = null;
                try {
                  schema = JSON.parse(ch.metadataSchema);
                } catch { }
                if (schema && schema.fields?.length > 0) {
                  try {
                    const { openMetadataModal } = await import("./api/modal");
                    await openMetadataModal(
                      slack,
                      triggerId,
                      channelId,
                      messageTs,
                      schema,
                      undefined,
                      apiOnly,
                    );
                  } catch (err: any) {
                    console.error("backfill openMetadataModal failed:", err.message);
                    await slack.chat.postEphemeral({
                      channel: channelId,
                      user: clickingUser,
                      text: `❌ Error opening form: ${err.message}`,
                    });
                  }
                  return;
                }
              }

              const {
                text: backfillText,
                formattedText: backfillFormattedText,
              } = await resolveForwardContent(
                db,
                channelId,
                messageTs,
                resolveSlackMrkdwn(extractMessageText(msg)),
                extractMessageMrkdwn(msg),
              );

              await q.upsertMessage(db, {
                slackTs: messageTs,
                channelId,
                userId: storedAuthors.userId,
                userName: storedAuthors.userName,
                text: backfillText,
                formattedText: backfillFormattedText,
                timestamp: storedTimestamp,
                metadata,
              });

              const savedMsg = {
                ...(() => {
                  const originalAuthor = extractOriginalAuthor(msg);
                  return {
                    originalUserId: originalAuthor.userId,
                    originalUserName: originalAuthor.userName,
                  };
                })(),
                slackTs: messageTs,
                channelId,
                userId,
                userName,
                text: backfillText,
                rawText: extractMessageText(msg),
                timestamp: storedTimestamp,
                metadata,
              };
              await q.addBotAction(db, {
                type: "backfill",
                sourceChannelId: channelId,
                sourceMessageTs: messageTs,
                botChannelId: channelId,
                botMessageTs: "0",
                userId: clickingUser,
                command: apiOnly ? "backfill_api_only" : "backfill",
                createdAt: "",
              });
              if (ch) await fireWebhook(ch, savedMsg);
              if (ch && !apiOnly) await forwardToSubscribers(savedMsg, ch, db, slack);
            } catch (err: any) {
              console.error("backfill shortcut error:", err.message);
              await slack.chat.postEphemeral({
                channel: channelId,
                user: clickingUser,
                text: `❌ Error backfilling message: ${err.message}`,
              });
            }
          })(),
        );
        return c.json({});
      }

      if (cb.type !== "block_actions") return;

      const action = cb.actions?.[0];
      if (!action) return;

      const channelId = cb.channel?.id;
      const messageTs = action.value;
      const responseUrl = cb.response_url;
      const triggerId = cb.trigger_id;
      const botMessageTs = cb.container?.message_ts || "";

      const ch = await q.getChannel(db, channelId);
      if (!ch || !ch.enabled) {
        await slackResponse(responseUrl, "This channel is not enabled.");
        return;
      }

      if (action.action_id === "indigest_yes") {
        const clickingUser = cb.user?.id || "";

        // Open modal IMMEDIATELY — trigger_id expires in 3s, can't afford slow checks first
        if (ch.metadataSchema) {
          let schema: any = null;
          try {
            schema = JSON.parse(ch.metadataSchema);
          } catch { }
          if (schema && schema.fields?.length > 0) {
            const { openMetadataModal } = await import("./api/modal");
            try {
              await openMetadataModal(
                slack,
                triggerId,
                channelId,
                messageTs,
                schema,
                cb.container?.message_ts,
              );
            } catch (err: any) {
              console.error("openMetadataModal failed:", err.message);
              if (err.message?.includes("expired_trigger_id")) {
                await slack.chat.postEphemeral({
                  channel: channelId,
                  user: clickingUser,
                  text: "⏱️ Form expired — please click Approve again.",
                });
              } else {
                await slack.chat.postEphemeral({
                  channel: channelId,
                  user: clickingUser,
                  text: `❌ Error opening form: ${err.message}`,
                });
              }
              return;
            }

            // Permission check AFTER modal is open
            const lockdownUsers = (env.LOCKDOWN_USERS || "")
              .split(",")
              .map((s: string) => s.trim())
              .filter(Boolean);
            const isLockdown = lockdownUsers.includes(clickingUser);
            const isManager =
              isLockdown ||
              (await isChannelManager(channelId, clickingUser, slack));
            if (!isManager) {
              const msgs = await q.getMessages(db, channelId, { limit: 100 });
              const originalMsg = msgs.find((m) => m.slackTs === messageTs);
              let messageUser = originalMsg?.userId || "";
              if (!messageUser) {
                try {
                  const history = await slack.conversations.history({
                    channel: channelId,
                    latest: messageTs,
                    limit: 1,
                    inclusive: true,
                  });
                  messageUser = (history.messages?.[0] as any)?.user || "";
                } catch { }
              }
              const allowed = canApproveMessage({
                approvedPosters: ch.approvedPosters,
                clickingUser,
                messageUser,
                isManager: false,
                isLockdown,
              });
              if (!allowed) {
                await slack.chat.postEphemeral({
                  channel: channelId,
                  user: clickingUser,
                  text: "❌ You don't have permission to approve this message.",
                });
                return;
              }
            }
            return;
          }
        }

        // No metadata schema — do permission checks first, then approve directly
        const lockdownUsers = (env.LOCKDOWN_USERS || "")
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean);
        const isLockdown = lockdownUsers.includes(clickingUser);
        const isManager =
          isLockdown ||
          (await isChannelManager(channelId, clickingUser, slack));

        try {
          const history = await slack.conversations.history({
            channel: channelId,
            latest: messageTs,
            limit: 1,
            inclusive: true,
          });
          const msg = history.messages?.[0] as any;
          if (!msg) {
            await slackResponse(responseUrl, "Couldn't fetch that message.");
            return;
          }

          if (
            !canApproveMessage({
              approvedPosters: ch.approvedPosters,
              clickingUser,
              messageUser: msg.user || "",
              isManager,
              isLockdown,
            })
          ) {
            await slack.chat.postEphemeral({
              channel: channelId,
              user: clickingUser,
              text: "❌ You don't have permission to approve this message.",
            });
            return;
          }

          if (ch.metadataRequired) {
            await slack.chat.postEphemeral({
              channel: channelId,
              user: clickingUser,
              text: "❌ This channel requires metadata before messages can be forwarded.",
            });
            return;
          }

          await q.addBotAction(db, {
            type: "approve",
            sourceChannelId: channelId,
            sourceMessageTs: messageTs,
            botChannelId: channelId,
            botMessageTs: botMessageTs || "0",
            userId: clickingUser,
            command: "indigest_yes",
            createdAt: "",
          });

          let userName = msg.user || "";
          try {
            const u = await slack.users.info({ user: msg.user });
            userName = (u.user as any)?.name || userName;
          } catch { }

          const originalAuthor = extractOriginalAuthor(msg);
          const storedUserId = q.mergeAuthorLists(
            msg.user || "",
            originalAuthor.userId,
          );
          const storedUserName = q.mergeAuthorLists(
            userName,
            originalAuthor.userName,
          );
          const storedTimestamp = resolveMessageTimestamp(msg, messageTs);
          const storedAuthors = resolveStoredAuthors(
            msg,
            msg.user || "",
            userName,
          );

          const {
            text: approvedText,
            formattedText: approvedFormattedText,
          } = await resolveForwardContent(
            db,
            channelId,
            messageTs,
            resolveSlackMrkdwn(extractMessageText(msg)),
            extractMessageMrkdwn(msg),
          );

          await q.upsertMessage(db, {
            slackTs: messageTs,
            channelId,
                userId: storedAuthors.userId,
                userName: storedAuthors.userName,
                text: approvedText,
                formattedText: approvedFormattedText,
                timestamp: storedTimestamp,
            metadata: {},
          });

          const savedMsg = {
            ...(() => {
              const originalAuthor = extractOriginalAuthor(msg);
              return {
                originalUserId: originalAuthor.userId,
                originalUserName: originalAuthor.userName,
              };
            })(),
            slackTs: messageTs,
            channelId,
            userId: msg.user || "",
            userName,
            text: approvedText,
            rawText: extractMessageText(msg),
            timestamp: storedTimestamp,
            metadata: {},
          };
          await fireWebhook(ch, savedMsg);
          await forwardToSubscribers(savedMsg, ch, db, slack);
          // if (ch.linkMode) await postPermalinkReply(slack, channelId, messageTs);

          // Update the bot's prompt to show approved state
          if (botMessageTs) {
            try {
              await slack.chat.update({
                channel: channelId,
                ts: botMessageTs,
                text: "✅ Message approved and added to the feed!",
                blocks: approvedPromptBlocks(
                  messageTs,
                  Boolean(ch.metadataSchema),
                ),
              } as any);
            } catch (err: any) {
              console.error(
                "chat.update (yes) failed:",
                err.message,
                "botMessageTs:",
                botMessageTs,
                "channel:",
                channelId,
              );
            }
          } else {
            console.warn(
              "indigest_yes: botMessageTs is empty, skipping chat.update. container:",
              JSON.stringify(cb.container),
            );
          }

          await slackResponse(responseUrl, "");
        } catch (err: any) {
          await slackResponse(responseUrl, `Error: ${err.message}`);
        }
      } else if (action.action_id === "indigest_refresh") {
        // Re-reads an approved message from Slack and stores it again, so
        // edits made after approval, or changes to how Indigest stores
        // messages, reach the feed. Metadata is kept; nothing is forwarded.
        const clickingUser = cb.user?.id || "";
        const lockdownUsers = (env.LOCKDOWN_USERS || "")
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean);
        const isLockdown = lockdownUsers.includes(clickingUser);
        const isManager = isLockdown
          ? false
          : await isChannelManager(channelId, clickingUser, slack);
        const stored = await q.getMessageBySlackTs(db, channelId, messageTs);
        if (!stored) {
          await slack.chat.postEphemeral({
            channel: channelId,
            user: clickingUser,
            text: "❌ This message isn't in the feed, so there's nothing to refresh.",
          });
          return;
        }
        if (!canApproveMessage({
          approvedPosters: ch.approvedPosters,
          clickingUser,
          messageUser: stored.userId,
          isManager,
          isLockdown,
        })) {
          await slack.chat.postEphemeral({
            channel: channelId,
            user: clickingUser,
            text: "❌ You don't have permission to refresh this message.",
          });
          return;
        }

        try {
          const history = await slack.conversations.history({
            channel: channelId,
            latest: messageTs,
            limit: 1,
            inclusive: true,
          });
          const msg = history.messages?.[0] as any;
          if (!msg || msg.ts !== messageTs) {
            await slack.chat.postEphemeral({
              channel: channelId,
              user: clickingUser,
              text: "❌ Couldn't fetch that message from Slack.",
            });
            return;
          }

          const text = resolveSlackMrkdwn(extractMessageText(msg));
          // Never let a failed read wipe what the feed already has.
          if (!text.trim() && stored.text.trim()) {
            await slack.chat.postEphemeral({
              channel: channelId,
              user: clickingUser,
              text: "❌ Slack returned no text for this message, so the stored version was kept.",
            });
            return;
          }

          let userName = msg.user || "";
          try {
            const u = await slack.users.info({ user: msg.user });
            userName = (u.user as any)?.name || userName;
          } catch { }
          const storedAuthors = resolveStoredAuthors(
            msg,
            msg.user || "",
            userName,
          );

          await q.upsertMessage(db, {
            slackTs: messageTs,
            channelId,
            threadTs: stored.threadTs,
            userId: storedAuthors.userId,
            userName: storedAuthors.userName,
            text,
            formattedText: extractMessageMrkdwn(msg),
            timestamp: resolveMessageTimestamp(
              msg,
              messageTs,
              stored.timestamp,
            ),
            metadata: stored.metadata,
          });
          await q.addBotAction(db, {
            type: "refresh",
            sourceChannelId: channelId,
            sourceMessageTs: messageTs,
            botChannelId: channelId,
            botMessageTs: botMessageTs || "0",
            userId: clickingUser,
            command: "indigest_refresh",
            createdAt: "",
          });
          await slack.chat.postEphemeral({
            channel: channelId,
            user: clickingUser,
            text: "🔄 Refreshed this message from Slack.",
          });
        } catch (err: any) {
          console.error("indigest_refresh failed:", err.message);
          await slack.chat.postEphemeral({
            channel: channelId,
            user: clickingUser,
            text: `❌ Error refreshing message: ${err.message}`,
          });
        }
      } else if (action.action_id === "indigest_no") {
        const clickingUser = cb.user?.id || "";
        const lockdownUsers = (env.LOCKDOWN_USERS || "")
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean);
        const isLockdown = lockdownUsers.includes(clickingUser);
        const isManager = isLockdown
          ? false
          : await isChannelManager(channelId, clickingUser, slack);
        let messageUser = (await q.getMessageBySlackTs(db, channelId, messageTs))?.userId || "";
        if (!messageUser) {
          try {
            const history = await slack.conversations.history({
              channel: channelId,
              latest: messageTs,
              limit: 1,
              inclusive: true,
            });
            messageUser = (history.messages?.[0] as any)?.user || "";
          } catch { }
        }
        if (!canApproveMessage({
          approvedPosters: ch.approvedPosters,
          clickingUser,
          messageUser,
          isManager,
          isLockdown,
        })) {
          await slack.chat.postEphemeral({
            channel: channelId,
            user: clickingUser,
            text: "❌ You don't have permission to decline this message.",
          });
          return;
        }

        await q.addBotAction(db, {
          type: "decline",
          sourceChannelId: channelId,
          sourceMessageTs: messageTs,
          botChannelId: channelId,
          botMessageTs: botMessageTs || "0",
          userId: clickingUser,
          command: "indigest_no",
          createdAt: "",
        });

        // Remove the message from the DB if it was previously approved
        try {
          await q.deleteMessage(db, channelId, messageTs);
        } catch (err: any) {
          console.error("deleteMessage failed:", err.message);
        }

        // Update the bot's prompt to show declined state
        if (botMessageTs) {
          try {
            await slack.chat.update({
              channel: channelId,
              ts: botMessageTs,
              text: "❌ Message declined.",
              blocks: [
                {
                  type: "section",
                  text: { type: "mrkdwn", text: "❌ *Message declined.*" },
                },
                {
                  type: "actions",
                  elements: [
                    {
                      type: "button",
                      action_id: "indigest_yes",
                      text: { type: "plain_text", text: "Approve instead" },
                      value: messageTs,
                    },
                  ],
                },
              ],
            } as any);
          } catch (err: any) {
            console.error(
              "chat.update (no) failed:",
              err.message,
              "botMessageTs:",
              botMessageTs,
              "channel:",
              channelId,
            );
          }
        } else {
          console.warn(
            "indigest_no: botMessageTs is empty, skipping chat.update. container:",
            JSON.stringify(cb.container),
          );
        }

        await slackResponse(responseUrl, "");
      }

      return;
    })(),
  );
});

// === Slash Commands ===

type SubOverrideCtx = {
  subcmd: string;
  arg: string;
  subscriberChannelId: string;
};

async function handleSubOverride(
  db: any,
  slack: WebClient,
  respond: (msg: string) => Promise<void>,
  logCommand: (cmd: string, db: any) => Promise<void>,
  ctx: SubOverrideCtx,
): Promise<void> {
  const { subcmd, arg, subscriberChannelId } = ctx;
  const name = subcmd === "name" ? "bot username" : "profile picture";

  if (!arg) {
    await respond(
      `Usage: \`/in sub ${subcmd} #source <value>\` — set the ${name} for forwards from #source. Use \`[property]\` to pull from the source channel's properties, or \`clear\` to reset.`,
    );
    return;
  }

  const match = arg.match(/^(<#(\w+)(\|[^>]*)?>|#(\S+))\s*([\s\S]*)$/);
  if (!match) {
    await respond(
      `Usage: \`/in sub ${subcmd} #source <value>\` — I couldn't parse a source channel.`,
    );
    return;
  }
  const idFromRef = match[2];
  const nameFromRef = match[4];
  const value = (match[5] || "").trim();

  let sourceId: string;
  if (idFromRef) {
    sourceId = idFromRef;
  } else {
    try {
      const list = await slack.conversations.list({
        types: "public_channel,private_channel",
        limit: 1000,
      });
      const channels = (list.channels as any[]) || [];
      const found = channels.find((ch) => ch.name === nameFromRef);
      if (!found) {
        await respond(`Channel #${nameFromRef} not found.`);
        return;
      }
      sourceId = found.id;
    } catch {
      await respond("Couldn't look up channels.");
      return;
    }
  }

  const existing = await q.getSubscriptionsBySubscriber(db, subscriberChannelId);
  const sub = existing.find((s) => s.sourceChannelId === sourceId);
  if (!sub) {
    await respond(
      `This channel isn't subscribed to #${nameFromRef || sourceId} yet. Run \`/in sub #${nameFromRef || sourceId}\` first.`,
    );
    return;
  }

  if (value.toLowerCase() === "clear") {
    await q.updateSubscriptionOverrides(db, subscriberChannelId, sourceId, {
      profileName: subcmd === "name" ? null : undefined,
      profileImageUrl: subcmd === "pfp" ? null : undefined,
    });
    await logCommand(`sub ${subcmd} clear`, db);
    await respond(`${name} override cleared for this channel.`);
    return;
  }

  await q.updateSubscriptionOverrides(db, subscriberChannelId, sourceId, {
    profileName: subcmd === "name" ? value : undefined,
    profileImageUrl: subcmd === "pfp" ? value : undefined,
  });
  await logCommand(`sub ${subcmd} ${value}`, db);
  await respond(
    `📰 ${name} override set for forwards from #${nameFromRef || sourceId}.${value.startsWith("[") ? " (resolved from properties)" : ""}`,
  );
}

const slackSlashCommand = async (c: any) => {  const env = c.env;
  const body = await c.req.text();
  if (!(await verifySignature(c.req.raw, body, env.SLACK_SIGNING_SECRET))) {
    return c.json({ error: "invalid signature" }, 401);
  }
  const form = new URLSearchParams(body);

  const sourceChannelId = form.get("channel_id") || "";
  const userId = form.get("user_id") || "";
  const text = (form.get("text") || "").trim();
  const responseUrl = form.get("response_url") || "";

  const respond = async (msg: string) => {
    if (responseUrl) {
      await slackResponse(responseUrl, msg);
    }
  };

  // Updated once the command's target channel is resolved.
  let commandTarget = sourceChannelId;
  const userName = form.get("user_name") || undefined;
  const auditCommand = (
    db: any,
    command: string,
    outcome: "success" | "denied" = "success",
    reason?: string,
  ) =>
    recordAudit(
      db,
      auditActions.channelCommand({
        actor: { type: "user", id: userId, displayName: userName },
        target: { id: commandTarget },
        outcome,
        reason,
      }),
      {
        source: "slack",
        actorSlackId: userId,
        command: `/in ${command}`,
        ranIn: sourceChannelId,
      },
    );

  const logCommand = async (command: string, db: any) => {
    // Any logged command may change what the feed map shows.
    invalidateGraphCache();
    await auditCommand(db, command);
    try {
      await db.insert(schema.botActions).values({
        type: "command",
        sourceChannelId,
        sourceMessageTs: "0",
        botChannelId: sourceChannelId,
        botMessageTs: "0",
        userId,
        command,
      });
    } catch {}
  };

  c.header("Content-Type", "application/json");
  c.header("X-Slack-Response-Accepted", "1");
  c.res = new Response(
    JSON.stringify({ response_type: "ephemeral", text: "⏳ Processing..." }),
    { status: 200, headers: c.res.headers },
  );

  c.executionCtx.waitUntil(
    (async () => {
      const db = getDb(getDbUrl(env));
      const slack = new WebClient(env.SLACK_BOT_TOKEN);
      const baseUrl = env.BASE_URL || "http://localhost:8787";
      const lockdownUsers = (env.LOCKDOWN_USERS || "")
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);

      const channelRefMatch = text.match(
        /^(<#(\w+)(\|[^>]*)?>|#(\S+))\s*(.*)$/,
      );
      let targetChannelId: string;
      let rest: string;

      if (channelRefMatch) {
        const idFromRef = channelRefMatch[2];
        const nameFromRef = channelRefMatch[4];
        rest = channelRefMatch[5]!.trim();

        if (idFromRef) {
          targetChannelId = idFromRef;
        } else {
          try {
            const list = await slack.conversations.list({
              types: "public_channel,private_channel",
              limit: 1000,
            });
            const channels = (list.channels as any[]) || [];
            const found = channels.find((c: any) => c.name === nameFromRef);
            if (!found) {
              await respond(`Channel #${nameFromRef} not found.`);
              return;
            }
            targetChannelId = found.id;
          } catch {
            await respond("Couldn't look up channels.");
            return;
          }
        }
      } else {
        targetChannelId = sourceChannelId;
        rest = text;
      }

      commandTarget = targetChannelId;
      let ch = await q.getChannel(db, targetChannelId);
      if (!ch) {
        let name = targetChannelId;
        try {
          const conv = await slack.conversations.info({
            channel: targetChannelId,
          });
          name = (conv.channel as any)?.name || targetChannelId;
        } catch { }
        const auth = await slack.auth.test();
        ch = {
          id: targetChannelId,
          name,
          teamId: auth.team_id || "",
          enabled: false,
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
          properties: "",
          staticMetadata: "",
          createdAt: "",
        };
        await q.upsertChannel(db, ch);
      }

      const parts = rest.split(/\s+/);
      const cmd = parts[0];
      const subcmd = parts[1];
      const arg = parts.slice(2).join(" ");
      console.log(
        `Slash command: user=${userId} channel=${targetChannelId} cmd=${cmd} subcmd=${subcmd} arg=${arg}`,
      );
      const targetManager = async () => {
        const ok =
          lockdownUsers.includes(userId) ||
          (await isChannelManager(targetChannelId, userId, slack));
        if (!ok)
          await auditCommand(db, rest, "denied", "not a channel manager");
        return ok;
      };

      if (
        lockdownUsers.length > 0 &&
        !lockdownUsers.includes(userId) &&
        cmd !== "status" &&
        cmd !== ""
      ) {
        await auditCommand(db, rest, "denied", "lockdown mode");
        await respond(
          "🔒 indigest is in lockdown mode. Only authorized users can run commands.",
        );
        return;
      }

      const doUnpub = async (logTag: string) => {
        if (!(await targetManager())) {
          await respond("Only the channel creator can unpub indigest.");
          return;
        }
        ch.enabled = false;
        await q.upsertChannel(db, ch);
        await logCommand(logTag, db);
        const label =
          targetChannelId === sourceChannelId ? "" : ` in #${ch.name}`;
        await respond(`indigest unpub'd${label}.`);
      };

      const doUnsub = async (unsubArg: string) => {
        const unsubChannelMatch = unsubArg.match(
          /^(<#(\w+)(\|[^>]*)?>|#(\S+))\s*$/,
        );
        if (!unsubChannelMatch) {
          await respond(
            "Usage: \`/in unsub #channel\` | \`/in sub off #channel\`",
          );
          return;
        }
        const unsubIdFromRef = unsubChannelMatch[2];
        const unsubNameFromRef = unsubChannelMatch[4];
        let sourceId: string;
        let sourceName: string;
        if (unsubIdFromRef) {
          sourceId = unsubIdFromRef;
        } else {
          try {
            const list = await slack.conversations.list({
              types: "public_channel,private_channel",
              limit: 1000,
            });
            const channels = (list.channels as any[]) || [];
            const found = channels.find(
              (c: any) => c.name === unsubNameFromRef,
            );
            if (!found) {
              await respond(`Channel #${unsubNameFromRef} not found.`);
              return;
            }
            sourceId = found.id;
          } catch {
            await respond("Couldn't look up channels.");
            return;
          }
        }
        const sourceCh = await q.getChannel(db, sourceId);
        sourceName = sourceCh?.name || unsubNameFromRef || sourceId;
        const existingSubs = await q.getSubscriptionsBySubscriber(
          db,
          sourceChannelId,
        );
        if (!existingSubs.some((s) => s.sourceChannelId === sourceId)) {
          await respond(`Not subscribed to #${sourceName}.`);
          return;
        }
        await q.removeSubscription(db, sourceChannelId, sourceId);
        invalidateGraphCache();
        await logCommand(`unsub #${sourceName}`, db);
        await respond(`📰 Unsubscribed from #${sourceName}.`);
      };

      switch (cmd) {
        case "pub": {
          if (subcmd === "off") {
            await doUnpub("pub off");
            return;
          }

          if (subcmd === "auto") {
            const target = arg.replace(/^<@(\w+)(\|[^>]*)?>$/, "$1").trim();

            ch.enabled = true;

            if (!target) {
              ch.autoApproveUsers = ["*"];
              ch.manualUsers = [];
              await q.upsertChannel(db, ch);
              await logCommand("pub auto *", db);
              await respond(
                `📰 Auto-approve enabled for all users in #${ch.name}.\nRSS: ${baseUrl}/feed/${targetChannelId}\nJSON: ${baseUrl}/feed/${targetChannelId}.json`,
              );
              return;
            }

            if (target !== userId) {
              try {
                const u = await slack.users.info({ user: target });
                const isBot = (u.user as any)?.is_bot;
                if (!isBot) {
                  if (!(await targetManager())) {
                    await respond(
                      "Only the channel creator can enable auto-approve for another non-bot user.",
                    );
                    return;
                  }
                }
              } catch {
                await respond("Couldn't look up that user.");
                return;
              }
            }

            if (ch.autoApproveUsers.includes(target)) {
              await respond(`<@${target}> already has auto-approve.`);
              return;
            }
            ch.autoApproveUsers.push(target);
            ch.manualUsers = ch.manualUsers.filter((id) => id !== target);
            await q.upsertChannel(db, ch);
            await logCommand(`pub auto <@${target}>`, db);
            await respond(
              `📰 Auto-approve enabled for <@${target}> in #${ch.name}. Only their messages will be published.\nRSS: ${baseUrl}/feed/${targetChannelId}\nJSON: ${baseUrl}/feed/${targetChannelId}.json`,
            );
            return;
          }

          if (subcmd === "link") {
            if (!(await targetManager())) {
              await respond("Only the channel creator can enable link mode.");
              return;
            }
            ch.enabled = true;
            const wantsOff = [
              "off",
              "disable",
              "disabled",
              "0",
              "false",
            ].includes((arg || "").trim().toLowerCase());
            ch.linkMode = !wantsOff;
            await q.upsertChannel(db, ch);
            const label =
              targetChannelId === sourceChannelId
                ? "this channel"
                : `#${ch.name}`;
            if (ch.linkMode) {
              await logCommand("pub link on", db);
              await respond(
                `🔗 Link mode enabled for ${label}. Approved messages will get an unfurlable permalink reply.\nRSS: ${baseUrl}/feed/${targetChannelId}\nJSON: ${baseUrl}/feed/${targetChannelId}.json`,
              );
            } else {
              await logCommand("pub link off", db);
              await respond(`🔗 Link mode disabled for ${label}.`);
            }
            return;
          }

          if (subcmd === "manual") {
            if (!(await targetManager())) {
              await respond("Only the channel creator can enable manual mode.");
              return;
            }
            ch.enabled = true;
            const target = (arg || "").replace(/^<@(\w+)(\|[^>]*)?>$/, "$1").trim();
            const label =
              targetChannelId === sourceChannelId
                ? "this channel"
                : `#${ch.name}`;
            if (target) {
              const wasAuto = ch.autoApproveUsers.includes(target);
              ch.autoApproveUsers = ch.autoApproveUsers.filter(
                (id) => id !== target,
              );
              if (!ch.manualUsers.includes(target)) {
                ch.manualUsers.push(target);
              }
              await q.upsertChannel(db, ch);
              await logCommand(`pub manual <@${target}>`, db);
              const verb = wasAuto ? "moved to" : "added to";
              await respond(
                `📰 <@${target}> ${verb} manual mode in ${label}. Their messages will get a Yep!/No prompt; other users' messages won't be published.`,
              );
              return;
            }
            ch.autoApproveUsers = [];
            ch.manualUsers = [];
            await q.upsertChannel(db, ch);
            await logCommand("pub manual", db);
            await respond(
              `📰 Manual mode enabled for ${label}. Every message will get a Yep!/No prompt.\nRSS: ${baseUrl}/feed/${targetChannelId}\nJSON: ${baseUrl}/feed/${targetChannelId}.json`,
            );
            return;
          }

          if (subcmd === "replies") {
            if (!(await targetManager())) {
              await respond(
                "Only the channel creator can toggle reply tracking.",
              );
              return;
            }
            ch.trackReplies = !ch.trackReplies;
            ch.enabled = true;
            await q.upsertChannel(db, ch);
            await logCommand(`pub replies ${ch.trackReplies ? "on" : "off"}`, db);
            const label =
              targetChannelId === sourceChannelId
                ? "this channel"
                : `#${ch.name}`;
            if (ch.trackReplies) {
              await respond(
                `📰 Reply tracking enabled for ${label}. Thread replies will now be backed up with their reply relationship.`,
              );
            } else {
              await respond(`📰 Reply tracking disabled for ${label}.`);
            }
            return;
          }

          if (subcmd === "trigger") {
            if (!(await targetManager())) {
              await respond(
                "Only the channel creator can change the trigger mode.",
              );
              return;
            }
            const mode = (arg || "").trim().toLowerCase();
            if (mode !== "message" && mode !== "shortcut") {
              await respond(
                "Usage: \`/in pub trigger message\` | \`/in pub trigger shortcut\`",
              );
              return;
            }
            ch.enabled = true;
            ch.triggerMode = mode;
            await q.upsertChannel(db, ch);
            const label =
              targetChannelId === sourceChannelId
                ? "this channel"
                : `#${ch.name}`;
            await logCommand(`pub trigger ${mode}`, db);
            if (mode === "shortcut") {
              await respond(
                `📰 Trigger mode set to shortcut for ${label}. Messages are only published via the "Add to feed" message shortcut, never automatically.`,
              );
            } else {
              await respond(
                `📰 Trigger mode set to message for ${label}. Every message is handled per the auto/manual approval settings.`,
              );
            }
            return;
          }

          if (subcmd) {
            await respond(
              "Usage: \`/in pub\` | \`/in pub #channel\` | \`/in pub auto @user\` | \`/in pub manual [@user]\` | \`/in pub link\` | \`/in pub replies\` | \`/in pub trigger message|shortcut\` | \`/in pub off\`",
            );
            return;
          }
          if (!(await targetManager())) {
            await respond("Only the channel creator can pub indigest.");
            return;
          }
          ch.enabled = true;
          ch.autoApproveUsers = [];
          ch.manualUsers = [];
          await q.upsertChannel(db, ch);
          await logCommand("pub", db);
          const label =
            targetChannelId === sourceChannelId ? "" : ` in #${ch.name}`;
          await respond(
            `📰 indigest pub'd${label}. New messages will get a prompt to add to the feed.\nRSS: ${baseUrl}/feed/${targetChannelId}\nJSON: ${baseUrl}/feed/${targetChannelId}.json`,
          );
          return;
        }

        case "unpub": {
          if (subcmd === "auto") {
            if (!ch.enabled) {
              await respond(`indigest is not pub'd in that channel.`);
              return;
            }
            const target = arg.replace(/^<@(\w+)(\|[^>]*)?>$/, "$1").trim();
            if (!target) {
              ch.autoApproveUsers = [];
              await q.upsertChannel(db, ch);
              await logCommand("unpub auto *", db);
              await respond(
                `Auto-approve disabled for all users in #${ch.name}.`,
              );
              return;
            }
            ch.autoApproveUsers = ch.autoApproveUsers.filter(
              (id) => id !== target,
            );
            await q.upsertChannel(db, ch);
            await logCommand(`unpub auto <@${target}>`, db);
            await respond(
              `Auto-approve disabled for <@${target}> in #${ch.name}.`,
            );
            return;
          }

          if (subcmd) {
            await respond(
              "Usage: \`/in unpub\` | \`/in unpub #channel\` | \`/in unpub auto [@user]\` | \`/in pub off\`",
            );
            return;
          }
          await doUnpub("unpub");
          return;
        }

        case "sub": {
          if (!(await targetManager())) {
            await respond(
              "Only the channel creator or workspace admin can subscribe channels.",
            );
            return;
          }

          if (subcmd === "off") {
            await doUnsub(arg);
            return;
          }

          if (subcmd === "pfp" || subcmd === "name") {
            await handleSubOverride(db, slack, respond, logCommand, {
              subcmd,
              arg,
              subscriberChannelId: sourceChannelId,
            });
            return;
          }

          const subArg = [subcmd, arg].filter(Boolean).join(" ");
          if (!subArg) {
            await respond(
              "Usage: \`/in sub #channel\` | \`/in sub off #channel\` — subscribe/unsubscribe this channel to/from #channel.",
            );
            return;
          }

          const subChannelMatch = subArg.match(
            /^(<#(\w+)(\|[^>]*)?>|#(\S+))\s*$/,
          );
          if (!subChannelMatch) {
            await respond(
              "Usage: \`/in sub #channel\` | \`/in sub off #channel\` — subscribe/unsubscribe this channel to/from #channel.",
            );
            return;
          }

          const subIdFromRef = subChannelMatch[2];
          const subNameFromRef = subChannelMatch[4];
          let sourceId: string;
          let sourceName: string;

          if (subIdFromRef) {
            sourceId = subIdFromRef;
          } else {
            try {
              const list = await slack.conversations.list({
                types: "public_channel,private_channel",
                limit: 1000,
              });
              const channels = (list.channels as any[]) || [];
              const found = channels.find(
                (c: any) => c.name === subNameFromRef,
              );
              if (!found) {
                await respond(`Channel #${subNameFromRef} not found.`);
                return;
              }
              sourceId = found.id;
            } catch {
              await respond("Couldn't look up channels.");
              return;
            }
          }

          const sourceCh = await q.getChannel(db, sourceId);
          sourceName = sourceCh?.name || subNameFromRef || sourceId;

          if (sourceId === sourceChannelId) {
            await respond("Can't subscribe a channel to itself.");
            return;
          }

          if (!sourceCh || !sourceCh.enabled) {
            await respond(
              `#${sourceName} is not pub'd yet. It must be pub'd before other channels can subscribe to it.`,
            );
            return;
          }

          const existingSubs =
            await q.getSubscriptionsBySubscriber(db, sourceChannelId);
          if (existingSubs.some((s) => s.sourceChannelId === sourceId)) {
            await respond(`Already subscribed to #${sourceName}.`);
            return;
          }

          await q.addSubscription(db, sourceChannelId, sourceId);
          invalidateGraphCache();
          await logCommand(`sub #${sourceName}`, db);
          await respond(
            `📰 Subscribed to #${sourceName}. Messages pub'd there will be forwarded here.`,
          );
          return;
        }

        case "unsub": {
          if (!(await targetManager())) {
            await respond(
              "Only the channel creator or workspace admin can unsubscribe channels.",
            );
            return;
          }

          await doUnsub([subcmd, arg].filter(Boolean).join(" "));
          return;
        }

        case "status": {
          const chName =
            targetChannelId === sourceChannelId ? "" : `#${ch.name} `;

          const perms: string[] = [];
          try {
            const conv = await slack.conversations.info({
              channel: targetChannelId,
            });
            const creator = (conv.channel as any)?.creator;
            if (creator === userId) perms.push("channel creator");
          } catch { }
          if (lockdownUsers.includes(userId)) perms.push("lockdown override");
          const permStr =
            perms.length > 0
              ? `\nYour perms: ${perms.join(", ")}`
              : "\nYour perms: none (can view feeds only)";

          if (ch.enabled) {
            let msg = `📰 indigest pub'd for ${chName}\nRSS: ${baseUrl}/feed/${targetChannelId}\nJSON: ${baseUrl}/feed/${targetChannelId}.json`;
            if (ch.linkMode) msg += `\nMode: link`;
            if (ch.triggerMode === "shortcut") {
              msg += `\nTrigger: shortcut only (no auto/manual publishing from messages)`;
            }
            if (ch.webhookUrl) msg += `\nWebhook: ${ch.webhookUrl}`;
            if (ch.autoApproveUsers.length > 0) {
              const autoLabel = ch.autoApproveUsers.includes("*")
                ? "all users"
                : ch.autoApproveUsers.map((id) => `<@${id}>`).join(", ");
              msg += `\nAuto-approve: ${autoLabel}`;
            }
            if (ch.manualUsers.length > 0) {
              msg += `\nManual-only: ${ch.manualUsers.map((id) => `<@${id}>`).join(", ")}`;
            }
            if (ch.metadataSchema) {
              try {
                const s = JSON.parse(ch.metadataSchema);
                msg += `\nMetadata schema: ${s.fields?.length || 0} field(s)`;
              } catch (err: any) {
                console.error("view_submission error:", err.message);
              }
            }
            if (ch.metadataRequired) msg += "\nMetadata: required";
            if (ch.approvedPosters.length > 0) {
              if (ch.approvedPosters.includes("poster")) {
                const extraUsers = ch.approvedPosters.filter(
                  (id) => id !== "poster",
                );
                const extraLabel =
                  extraUsers.length > 0
                    ? ` + ${extraUsers.map((id) => `<@${id}>`).join(", ")}`
                    : "";
                msg += `\nApprovals: poster mode${extraLabel}`;
              } else {
                msg += `\nApprovals: ${ch.approvedPosters.map((id) => `<@${id}>`).join(", ")}`;
              }
            } else {
              msg += `\nApprovals: poster + managers (default)`;
            }
            msg += `\nThread replies: ${ch.trackReplies ? "tracked" : "off"}`;
            const subs =
              await q.getSubscriptionsBySubscriber(db, targetChannelId);
            if (subs.length > 0) {
              const subNames = await Promise.all(
                subs.map(async (s) => {
                  const sch = await q.getChannel(db, s.sourceChannelId);
                  return sch ? `#${sch.name}` : s.sourceChannelId;
                }),
              );
              msg += `\nSubscribed to: ${subNames.join(", ")}`;
            }
            const subscribers =
              await q.getSubscribersBySource(db, targetChannelId);
            if (subscribers.length > 0) {
              const subNames = await Promise.all(
                subscribers.map(async (s) => {
                  const sch = await q.getChannel(db, s.subscriberChannelId);
                  return sch ? `#${sch.name}` : s.subscriberChannelId;
                }),
              );
              msg += `\nSubscribers: ${subNames.join(", ")}`;
            }
            msg += permStr;
            await respond(msg);
            return;
          }
          await respond(
            `indigest is not pub'd for ${chName}Run \`/in pub\` to start.${permStr}`,
          );
          return;
        }

        default: {
          if (!cmd) {
            await respond(
              "Commands:\n• \`pub [#channel]\` — enable indigest\n• \`unpub [#channel]\` — disable indigest (alias: \`pub off\`)\n• \`pub auto [@user]\` — auto-approve mode\n• \`pub manual [@user]\` — manual approve mode\n• \`pub replies\` — track thread replies\n• \`sub #channel\` — subscribe to another channel's feed\n• \`sub off #channel\` — unsubscribe from another channel's feed\n• \`sub pfp #source <value>\` | \`sub name #source <value>\` — set per-source profile overrides\n• \`unsub #channel\` — unsubscribe from a channel\n• \`perms @user\` — set who can approve messages\n• \`status [#channel]\` — show status\n• \`webhook <url>\` — set webhook\n• \`schema set <json>\` | \`schema get\` | \`schema clear\` | \`schema required on|off\`\n• \`prop set <json>\` | \`prop get\` | \`prop clear\` — channel properties\n• \`static set <text>\` | \`static get\` | \`static clear\` — bold line above every forward",
            );
            return;
          }

          if (cmd === "webhook") {
            if (targetChannelId !== sourceChannelId) {
              await respond(
                "Webhook commands must be run from the target channel.",
              );
              return;
            }
            if (!(await targetManager())) {
              await respond("Only the channel creator can configure webhooks.");
              return;
            }
            if (subcmd === "clear") {
              ch.webhookUrl = "";
              await q.upsertChannel(db, ch);
              await logCommand("webhook clear", db);
              await respond("Webhook cleared.");
              return;
            }

            const url = parts.slice(1).join(" ");
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
              await respond("Invalid URL. Must start with http:// or https://");
              return;
            }
            ch.webhookUrl = url;
            await q.upsertChannel(db, ch);
            await logCommand(`webhook set`, db);
            await respond(`📰 Webhook set to ${url}`);
            return;
          }

          if (cmd === "auto" && subcmd === "list") {
            if (ch.autoApproveUsers.length === 0) {
              await respond(`No users have auto-approve in #${ch.name}.`);
              return;
            }
            if (ch.autoApproveUsers.includes("*")) {
              await respond(`Auto-approve in #${ch.name}: all users`);
              return;
            }
            const users = ch.autoApproveUsers
              .map((id) => `<@${id}>`)
              .join(", ");
            await respond(`Auto-approve in #${ch.name}: ${users}`);
            return;
          }

          if (cmd === "schema") {
            if (subcmd === "get") {
              if (!ch.metadataSchema) {
                await respond(
                  "No metadata schema configured for this channel.",
                );
                return;
              }
              try {
                const pretty = JSON.stringify(
                  JSON.parse(ch.metadataSchema),
                  null,
                  2,
                );
                await respond(`\`\`\`${pretty}\`\`\``);
              } catch {
                await respond(`Raw schema:\n${ch.metadataSchema}`);
              }
              return;
            }

            if (subcmd === "clear") {
              ch.metadataSchema = "";
              await q.upsertChannel(db, ch);
              await logCommand("schema clear", db);
              await respond("Metadata schema cleared.");
              return;
            }

            if (subcmd === "required") {
              if (!(await targetManager())) {
                await respond(
                  "Only the channel creator can change metadata requirements.",
                );
                return;
              }
              const wantsOff = [
                "off",
                "disable",
                "disabled",
                "0",
                "false",
              ].includes((arg || "").trim().toLowerCase());
              ch.metadataRequired = !wantsOff;
              await q.upsertChannel(db, ch);
              await logCommand(
                `schema required ${ch.metadataRequired ? "on" : "off"}`,
                db,
              );
              await respond(
                ch.metadataRequired
                  ? "📝 Metadata is now required before messages can be forwarded."
                  : "📝 Metadata is no longer required before forwarding.",
              );
              return;
            }

            if (subcmd === "set") {
              if (!arg) {
                await respond(
                  "Usage: \`/in schema set <json>\` — provide a valid metadata schema JSON.",
                );
                return;
              }
              try {
                const parsed = JSON.parse(arg);
                if (!parsed.fields || !Array.isArray(parsed.fields)) {
                  await respond(
                    'Schema must have a \`fields\` array. Example: \`{"title": "Metadata", "fields": [{"action_id": "title", "label": "Title", "type": "plain_text_input"}]}\`',
                  );
                  return;
                }
                ch.metadataSchema = JSON.stringify(parsed);
                await q.upsertChannel(db, ch);
                await logCommand("schema set", db);
                await respond(
                  `📰 Metadata schema set with ${parsed.fields.length} field(s).`,
                );
              } catch (e: any) {
                await respond(`Invalid JSON: ${e.message}`);
              }
              return;
            }

            await respond(
              "Usage: \`/in schema set <json>\` | \`/in schema get\` | \`/in schema clear\` | \`/in schema required on|off\`",
            );
            return;
          }

          if (cmd === "static") {
            if (subcmd === "get" || (!subcmd && !arg)) {
              await respond(
                ch.staticMetadata
                  ? `Static metadata shown above every forward:\n${formatStaticMetadata(ch.staticMetadata)}`
                  : "No static metadata configured for this channel.",
              );
              return;
            }

            if (subcmd === "clear") {
              ch.staticMetadata = "";
              await q.upsertChannel(db, ch);
              await logCommand("static clear", db);
              await respond("Static metadata cleared.");
              return;
            }

            if (subcmd === "set" && arg.trim()) {
              ch.staticMetadata = arg.trim().slice(0, 2000);
              await q.upsertChannel(db, ch);
              await logCommand("static set", db);
              await respond(
                `📰 Static metadata set. Forwards will now start with:\n${formatStaticMetadata(ch.staticMetadata)}`,
              );
              return;
            }

            await respond(
              "Usage: \`/in static set <text>\` | \`/in static get\` | \`/in static clear\`",
            );
            return;
          }

          if (cmd === "prop") {
            if (subcmd === "get") {
              if (!ch.properties || ch.properties === "{}") {
                await respond("No properties configured for this channel.");
                return;
              }
              try {
                const pretty = JSON.stringify(
                  JSON.parse(ch.properties),
                  null,
                  2,
                );
                await respond(`\`\`\`${pretty}\`\`\``);
              } catch {
                await respond(`Raw properties:\n${ch.properties}`);
              }
              return;
            }

            if (subcmd === "clear") {
              ch.properties = "{}";
              await q.upsertChannel(db, ch);
              await logCommand("prop clear", db);
              await respond("Channel properties cleared.");
              return;
            }

            if (subcmd === "set") {
              if (!arg) {
                await respond(
                  "Usage: \`/in prop set <json>\` — provide a valid properties JSON object.",
                );
                return;
              }
              try {
                const parsed = JSON.parse(arg);
                if (
                  !parsed ||
                  typeof parsed !== "object" ||
                  Array.isArray(parsed)
                ) {
                  await respond("Properties must be a JSON object.");
                  return;
                }
                ch.properties = JSON.stringify(parsed);
                await q.upsertChannel(db, ch);
                await logCommand("prop set", db);
                await respond(
                  `📰 Channel properties set: ${Object.keys(parsed).join(", ")}`,
                );
              } catch (e: any) {
                await respond(`Invalid JSON: ${e.message}`);
              }
              return;
            }

            await respond(
              "Usage: \`/in prop set <json>\` | \`/in prop get\` | \`/in prop clear\`",
            );
            return;
          }

          if (cmd === "perms") {
            if (subcmd === "get" || (!subcmd && !arg)) {
              if (ch.approvedPosters.length === 0) {
                await respond(
                  "Default mode: only the original poster and channel managers can approve messages.",
                );
              } else if (ch.approvedPosters.includes("poster")) {
                await respond(
                  `Poster mode: the original poster of each message can approve it, plus channel managers.`,
                );
              } else {
                const users = ch.approvedPosters
                  .map((id) => `<@${id}>`)
                  .join(", ");
                await respond(
                  `Approved posters for #${ch.name}: ${users}\nPlus channel managers.`,
                );
              }
              return;
            }

            if (subcmd === "clear") {
              ch.approvedPosters = [];
              await q.upsertChannel(db, ch);
              await logCommand("perms clear", db);
              await respond(
                "Poster permissions cleared. Back to default: only the original poster and channel managers can approve.",
              );
              return;
            }

            // Parse user mentions and "poster" keyword from the full text
            const allParts = rest.split(/\s+/);
            const userIds: string[] = [];
            let posterMode = false;
            for (const part of allParts) {
              if (part.toLowerCase() === "poster") {
                posterMode = true;
                continue;
              }
              const mentionMatch = part.match(/^<@(\w+)(?:\|[^>]*)?>$/);
              if (mentionMatch) userIds.push(mentionMatch[1]);
            }

            if (userIds.length === 0 && !posterMode) {
              await respond(
                "Usage: \`/in perms @user1 @user2\` — restrict to specific users\n\`/in perms poster\` — let each message's author approve their own\n\`/in perms get\` — view current permissions\n\`/in perms clear\` — restore defaults",
              );
              return;
            }

            ch.approvedPosters = posterMode ? ["poster", ...userIds] : userIds;
            await q.upsertChannel(db, ch);
            await logCommand(`perms ${posterMode ? "poster" : userIds.join(",")}`, db);
            if (posterMode && userIds.length > 0) {
              const users = userIds.map((id) => `<@${id}>`).join(", ");
              await respond(
                `📰 Poster permissions set for #${ch.name}: poster mode + ${users}`,
              );
            } else if (posterMode) {
              await respond(
                `📰 Poster mode enabled for #${ch.name}. Each message's author can approve their own message.`,
              );
            } else {
              const users = userIds.map((id) => `<@${id}>`).join(", ");
              await respond(
                `📰 Poster permissions set for #${ch.name}: ${users}`,
              );
            }
            return;
          }

          await respond(
            "Commands:\n• \`pub [#channel]\` — enable indigest\n• \`unpub [#channel]\` — disable indigest (alias: \`pub off\`)\n• \`pub auto [@user]\` — auto-approve mode\n• \`pub manual [@user]\` — manual approve mode\n• \`pub replies\` — track thread replies\n• \`sub #channel\` — subscribe to another channel's feed\n• \`sub off #channel\` — unsubscribe from another channel's feed\n• \`sub pfp #source <value>\` | \`sub name #source <value>\` — set per-source profile overrides\n• \`unsub #channel\` — unsubscribe from a channel\n• \`perms @user\` — set who can approve messages\n• \`status [#channel]\` — show status\n• \`webhook <url>\` — set webhook\n• \`schema set <json>\` | \`schema get\` | \`schema clear\`\n• \`prop set <json>\` | \`prop get\` | \`prop clear\` — channel properties\n• \`static set <text>\` | \`static get\` | \`static clear\` — bold line above every forward",
          );
        }
      }
    })(),
  );
};

app.post("/slack", slackSlashCommand);
app.post("/slack/", slackSlashCommand);

// === RSS Feed / JSON API ===
app.get("/feed/:channelId", async (c) => {
  try {
    const env = c.env;
    const rawId = c.req.param("channelId")!;
    const wantsJson =
      rawId.endsWith(".json") ||
      c.req.header("accept")?.includes("application/json");
    const channelId = wantsJson ? rawId.replace(/\.json$/, "") : rawId;
    const db = getDb(getDbUrl(env));
    const ch = await q.getChannel(db, channelId);
    if (!ch || !ch.enabled) {
      return c.json({ error: "not found", id: channelId }, 404);
    }

    const identity = await resolveFeedIdentity(c, env);
    if (!canAccessFeed(ch, identity)) {
      return c.json(
        { error: "forbidden", message: "You don't have access to this feed" },
        403,
      );
    }

    const limit = Math.min(parseInt(c.req.query("limit") || "50") || 50, 200);
    const offset = parseInt(c.req.query("offset") || "0") || 0;
    const msgs = await q.getMessages(db, channelId, { limit, offset });

    if (wantsJson) {
      return c.json(msgs);
    }

    const baseUrl = env.BASE_URL || "http://localhost:8787";
    const feed = new Feed({
      title: `#${ch.name} — indigest`,
      link: `${baseUrl}/feed/${channelId}`,
      description: `Recent messages from #${ch.name}`,
    });

    for (const m of msgs) {
      feed.addItem({
        title: m.userName || "unknown",
        description: m.text.substring(0, 500),
        date: new Date(m.timestamp),
        guid: `${channelId}:${m.slackTs}`,
        link: `${baseUrl}/feed/${channelId}`,
      });
    }

    return c.text(feed.rss2(), 200, {
      "Content-Type": "application/rss+xml; charset=utf-8",
    });
  } catch (err: any) {
    console.error("feed error:", err?.message || err);
    c.header("Retry-After", "2");
    return c.text("Service Unavailable", 503);
  }
});

// === REST API ===
app.get("/api/messages", async (c) => {
  const env = c.env;
  const db = getDb(getDbUrl(env));
  const channel = c.req.query("channel");
  if (!channel) {
    return c.json({ error: "channel is required" }, 400);
  }

  const ch = await q.getChannel(db, channel);
  if (!ch || !ch.enabled) {
    return c.json({ error: "channel not found or not enabled" }, 404);
  }

  const identity = await resolveFeedIdentity(c, env);
  if (!canAccessFeed(ch, identity)) {
    return c.json(
      { error: "forbidden", message: "You don't have access to this channel" },
      403,
    );
  }

  const after = c.req.query("after");
  const before = c.req.query("before");
  const userId = c.req.query("userId");
  const threadTs = c.req.query("threadTs");
  const limit = Math.min(parseInt(c.req.query("limit") || "50") || 50, 10000);
  const page = parseInt(c.req.query("page") || "1") || 1;
  const offset = (page - 1) * limit;

  const filterOpts = { after, before, userId, threadTs };

  const [total, items] = await Promise.all([
    q.getMessageCount(db, channel, filterOpts),
    q.getMessages(db, channel, { limit, offset, ...filterOpts }),
  ]);

  return c.json({
    data: items,
    pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
  });
});

app.get("/api/messages/:slackTs", async (c) => {
  const env = c.env;
  const db = getDb(getDbUrl(env));
  const slackTs = decodeURIComponent(c.req.param("slackTs"));
  const channel = c.req.query("channel") || "";

  if (!channel) {
    return c.json({ error: "channel is required" }, 400);
  }

  const ch = await q.getChannel(db, channel);
  if (!ch || !ch.enabled) {
    return c.json({ error: "channel not found or not enabled" }, 404);
  }

  const identity = await resolveFeedIdentity(c, env);
  if (!canAccessFeed(ch, identity)) {
    return c.json(
      { error: "forbidden", message: "You don't have access to this channel" },
      403,
    );
  }

  const msg = await q.getMessageBySlackTs(db, channel, slackTs);
  if (!msg) {
    return c.json({ error: "message not found" }, 404);
  }

  return c.json({ data: msg });
});

app.get("/api/channels", async (c) => {
  const env = c.env;
  const db = getDb(getDbUrl(env));
  const channels = await q.listChannels(db);
  return c.json({ data: channels });
});

app.get("/api/channels/:id", async (c) => {
  const env = c.env;
  const db = getDb(getDbUrl(env));
  const id = decodeURIComponent(c.req.param("id"));
  const ch = await q.getChannel(db, id);
  if (!ch) return c.json({ error: "channel not found" }, 404);
  return c.json({ data: ch });
});

// --- Graph API (for React Flow diagram) ---
const GRAPH_CACHE_TTL = 60_000; // 1 minute

app.get("/api/graph", async (c) => {
  const env = c.env;

  const cachedGraph = graphCache.value;
  if (cachedGraph && Date.now() - cachedGraph.at < GRAPH_CACHE_TTL) {
    return c.json(cachedGraph.data as any);
  }

  const db = getDb(getDbUrl(env));

  const { channels, subscriptions, subscriberChannels } =
    await q.getGraphData(db);

  // Index channels by ID for fast lookup
  const channelMap = new Map<string, StoreChannel>();
  for (const ch of channels) channelMap.set(ch.id, ch);
  for (const ch of subscriberChannels) channelMap.set(ch.id, ch);

  // Index subscriptions by source channel
  const subsBySource = new Map<string, StoreSubscription[]>();
  for (const sub of subscriptions) {
    const list = subsBySource.get(sub.sourceChannelId) || [];
    list.push(sub);
    subsBySource.set(sub.sourceChannelId, list);
  }

  const nodes: Array<{
    id: string;
    type: string;
    label: string;
    data: Record<string, any>;
  }> = [];
  const edges: Array<{
    id: string;
    source: string;
    target: string;
    label?: string;
    animated: boolean;
  }> = [];

  for (const ch of channels) {
    nodes.push({
      id: `ch:${ch.id}`,
      type: "channel",
      label: `#${ch.name || ch.id}`,
      data: {
        channelId: ch.id,
        name: ch.name,
        webhookUrl: ch.webhookUrl,
        metadataSchema: ch.metadataSchema,
        metadataRequired: ch.metadataRequired,
        trackReplies: ch.trackReplies,
        approvedPosters: ch.approvedPosters,
        autoApproveUsers: ch.autoApproveUsers?.join(", ") || "",
        enabled: ch.enabled,
        linkMode: ch.linkMode,
        triggerMode: ch.triggerMode,
        createdAt: ch.createdAt,
      },
    });
    nodes.push({
      id: `rss:${ch.id}`,
      type: "feed",
      label: "RSS Feed",
      data: { feedType: "rss", channelId: ch.id },
    });
    edges.push({
      id: `e-rss-${ch.id}`,
      source: `ch:${ch.id}`,
      target: `rss:${ch.id}`,
      animated: true,
    });
    nodes.push({
      id: `api:${ch.id}`,
      type: "feed",
      label: "API Feed",
      data: { feedType: "api", channelId: ch.id },
    });
    edges.push({
      id: `e-api-${ch.id}`,
      source: `ch:${ch.id}`,
      target: `api:${ch.id}`,
      animated: true,
    });
    if (ch.webhookUrl) {
      nodes.push({
        id: `wh:${ch.id}`,
        type: "feed",
        label: "Webhook",
        data: { feedType: "webhook", channelId: ch.id, url: ch.webhookUrl },
      });
      edges.push({
        id: `e-wh-${ch.id}`,
        source: `ch:${ch.id}`,
        target: `wh:${ch.id}`,
        animated: true,
      });
    }

    const subs = subsBySource.get(ch.id) || [];
    for (const sub of subs) {
      const subCh = channelMap.get(sub.subscriberChannelId);
      const subLabel = subCh
        ? `#${subCh.name || subCh.id}`
        : sub.subscriberChannelId;
      if (!nodes.find((n) => n.id === `sub:${sub.subscriberChannelId}`)) {
        nodes.push({
          id: `sub:${sub.subscriberChannelId}`,
          type: "subscriber",
          label: subLabel,
          data: {
            channelId: sub.subscriberChannelId,
            name: subCh?.name,
            webhookUrl: subCh?.webhookUrl,
            metadataSchema: subCh?.metadataSchema,
            metadataRequired: subCh?.metadataRequired,
            trackReplies: subCh?.trackReplies,
            approvedPosters: subCh?.approvedPosters,
            autoApproveUsers: subCh?.autoApproveUsers?.join(", ") || "",
            enabled: subCh?.enabled,
            linkMode: subCh?.linkMode,
            createdAt: subCh?.createdAt,
          },
        });
      }
      edges.push({
        id: `e-sub-${ch.id}-${sub.subscriberChannelId}`,
        source: `ch:${ch.id}`,
        target: `sub:${sub.subscriberChannelId}`,
        label: "[sub]",
        animated: true,
      });
    }
  }

  const result = { data: { nodes, edges } };
  graphCache.value = { data: result, at: Date.now() };
  return c.json(result);
});

export default app;
