import { Hono } from "hono";
import { WebClient } from "@slack/web-api";
import { Feed } from "feed";
import type { Store, StoreChannel, StoreMessage, StoreSubscription } from "./store/store";

// --- Helpers ---

function slackTsToTime(ts: string): Date {
  const parts = ts.split(".");
  const sec = parseInt(parts[0] || "0") || 0;
  const nsec = parseInt(parts[1] || "0") || 0;
  return new Date(sec * 1000 + nsec / 1e6);
}

async function isChannelManager(channelId: string, userId: string, slack: WebClient): Promise<boolean> {
  // Check if user is the channel creator
  try {
    const conv = await slack.conversations.info({ channel: channelId });
    if ((conv.channel as any)?.creator === userId) return true;
  } catch {}

  // Check if user is a workspace admin or owner (channel managers in Slack)
  try {
    const user = await slack.users.info({ user: userId });
    const u = user.user as any;
    if (u?.is_admin || u?.is_owner || u?.is_primary_owner) return true;
  } catch {}

  return false;
}

async function verifySignature(request: Request, body: string, signingSecret: string): Promise<boolean> {
  const ts = request.headers.get("X-Slack-Request-Timestamp") || "";
  const sig = request.headers.get("X-Slack-Signature") || "";
  const baseString = `v0:${ts}:${body}`;
  const encoder = new TextEncoder();
  try {
    const key = await crypto.subtle.importKey("raw", encoder.encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sigBytes = await crypto.subtle.sign("HMAC", key, encoder.encode(baseString));
    const computed = "v0=" + Array.from(new Uint8Array(sigBytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
    if (computed.length !== sig.length) return false;
    return crypto.subtle.timingSafeEqual(encoder.encode(computed), encoder.encode(sig));
  } catch {
    return false;
  }
}

async function slackResponse(responseUrl: string, text: string) {
  try {
    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, response_type: "ephemeral", replace_original: false }),
    });
  } catch {}
}

async function postPermalinkReply(slack: WebClient, channelId: string, messageTs: string): Promise<void> {
  try {
    const permalink = await slack.chat.getPermalink({ channel: channelId, message_ts: messageTs });
    const url = (permalink as any)?.permalink || "";
    if (!url) return;
    await slack.chat.postMessage({
      channel: channelId,
      thread_ts: messageTs,
      text: url,
      unfurl_links: true,
      unfurl_media: true,
    } as any);
  } catch {}
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
  } catch {}
}

async function uploadToCDN(slackUrl: string, botToken: string, cdnKey: string): Promise<string> {
  if (!cdnKey) return slackUrl;
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

// Dedup cache: keep track of recently forwarded messages to avoid duplicates
const forwardedCache = new Set<string>();
const FORWARD_CACHE_TTL = 60_000; // 1 minute

function markForwarded(channelId: string, slackTs: string): boolean {
  const key = `${channelId}:${slackTs}`;
  if (forwardedCache.has(key)) return false;
  forwardedCache.add(key);
  setTimeout(() => forwardedCache.delete(key), FORWARD_CACHE_TTL);
  return true;
}

function isLinkOnly(text: string): boolean {
  const trimmed = text.trim();
  return /^https?:\/\/\S+$/.test(trimmed);
}

function isMessageEmpty(text: string): boolean {
  return text.trim().length === 0;
}

function hasChannelPing(text: string): boolean {
  return /<!here|<!channel>/.test(text);
}

async function shouldForward(msg: StoreMessage, store: Store): Promise<boolean> {
  // Always forward Slack permalink cross-posts
  if (isSlackPermalink(msg.text)) return true;
  // Always forward empty messages (Slack forwarded messages often come as empty)
  if (isMessageEmpty(msg.text)) return true;
  if (isLinkOnly(msg.text)) {
    console.log(`shouldForward: skipping link-only message ${msg.slackTs}: ${msg.text.substring(0, 80)}`);
    return false;
  }
  if (hasChannelPing(msg.text)) {
    const since = new Date(Date.now() - 5 * 60 * 1000);
    const recent = await store.getRecentMessages(msg.channelId, since);
    const hasSubstantive = recent.some(
      (m) => m.slackTs !== msg.slackTs && !isLinkOnly(m.text) && !isMessageEmpty(m.text) && !hasChannelPing(m.text)
    );
    if (hasSubstantive) return false;
  }
  return true;
}

function isSlackPermalink(text: string): boolean {
  const trimmed = text.trim();
  return /^https:\/\/hackclub\.slack\.com\/archives\/[A-Z0-9]+\/p\d+$/.test(trimmed) ||
         /^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/[A-Z0-9]+\/p\d+$/.test(trimmed);
}

async function forwardToSubscribers(
  msg: StoreMessage,
  sourceChannel: StoreChannel,
  store: Store,
  slack: WebClient,
) {
  // Dedup: skip if we've already forwarded this message recently
  if (!markForwarded(msg.channelId, msg.slackTs)) {
    console.log(`forwardToSubscribers: duplicate ${msg.channelId}:${msg.slackTs}, skipping`);
    return;
  }

  const subs = await store.getSubscribersBySource(msg.channelId);
  if (subs.length === 0) {
    console.log(`forwardToSubscribers: no subscribers for channel ${msg.channelId}`);
    return;
  }
  if (!(await shouldForward(msg, store))) {
    console.log(`forwardToSubscribers: shouldForward returned false for ${msg.slackTs}`);
    return;
  }

  let permalink = "";
  try {
    const r = await slack.chat.getPermalink({ channel: msg.channelId, message_ts: msg.slackTs });
    permalink = (r as any)?.permalink || "";
  } catch {}
  if (!permalink) {
    const slackTsClean = msg.slackTs.replace(".", "");
    permalink = `https://slack.com/archives/${msg.channelId}/p${slackTsClean}`;
  }
  const msgDate = new Date(msg.timestamp);
  const dateStr = `${msgDate.getFullYear()}-${msgDate.getMonth() + 1}-${msgDate.getDate()}`;

  let displayName = msg.userName || "unknown";
  let avatarUrl = "";

  if (msg.userId) {
    try {
      const u = await slack.users.info({ user: msg.userId });
      const user = u.user as any;
      const profile = user?.profile;
      displayName = user?.real_name || user?.name || profile?.display_name || msg.userName || "unknown";
      avatarUrl = profile?.image_72 || profile?.image_original || profile?.image_48 || "";
    } catch (err) {
      console.error(`Failed to fetch user info for ${msg.userId}:`, err);
    }
  }

  for (const sub of subs) {
    const subCh = await store.getChannel(sub.subscriberChannelId);
    if (!subCh) {
      console.error(`Subscriber channel ${sub.subscriberChannelId} not found in DB`);
      continue;
    }

    // Get the link to forward — from text if permalink, from metadata, or fallback to computed permalink
    let forwardLink = "";
    let originalAuthorName = "";
    let originalAuthorAvatar = "";
    let originalText = "";

    // Check if text is a Slack permalink
    if (isSlackPermalink(msg.text)) {
      forwardLink = msg.text.trim();
    }
    // Check metadata for slack_permalink (set by auto-approve)
    if (!forwardLink) {
      try {
        const meta = typeof msg.metadata === "string" ? JSON.parse(msg.metadata) : msg.metadata;
        if (meta?.slack_permalink) forwardLink = meta.slack_permalink;
      } catch {}
    }
    if (!forwardLink) forwardLink = permalink;

    // Link mode: don't fetch/repost the original text
    if (sourceChannel.linkMode) {
      originalText = "";
    }
    // If we have a Slack permalink and we're not in link mode, try to fetch the original message details
    if (!sourceChannel.linkMode && forwardLink && forwardLink.includes("slack.com/archives/")) {
      const permalinkMatch = forwardLink.match(/\/archives\/([A-Z0-9]+)\/p(\d+)/);
      if (permalinkMatch) {
        const origChannel = permalinkMatch[1];
        const origTs = permalinkMatch[2].slice(0, 10) + "." + permalinkMatch[2].slice(10);
        try {
          const history = await slack.conversations.history({ channel: origChannel, latest: origTs, limit: 1, inclusive: true });
          const origMsg = history.messages?.[0] as any;
          if (origMsg) {
            originalText = origMsg.text || "";
            if (origMsg.user) {
              const u = await slack.users.info({ user: origMsg.user });
              const user = u.user as any;
              const profile = user?.profile;
              originalAuthorName = user?.real_name || user?.name || profile?.display_name || origMsg.user;
              originalAuthorAvatar = profile?.image_72 || profile?.image_original || profile?.image_48 || "";
            }
          }
        } catch {}
      }
    }

    // Use original author details if available, otherwise use the forwarder
    const postUsername = originalAuthorName || displayName;
    const postIcon = originalAuthorAvatar || avatarUrl || undefined;

    // Build the context footer
    // If this message has a forwardLink to another channel, show the full chain
    let footerText: string;
    if (forwardLink && !forwardLink.includes(msg.channelId)) {
      // This is a forward from another channel — extract the original source
      const fm = forwardLink.match(/\/archives\/([A-Z0-9]+)/);
      const origSourceChannel = fm ? fm[1] : "";
      let origSourceName = origSourceChannel;
      if (origSourceChannel) {
        const origCh = await store.getChannel(origSourceChannel);
        if (origCh?.name) origSourceName = origCh.name;
      }
      footerText = `📰 Forwarded from <#${msg.channelId}|${sourceChannel.name}> from <#${origSourceChannel}|${origSourceName}> — <${permalink}|view source from ${dateStr}>`;
    } else {
      footerText = `📰 Forwarded from <#${msg.channelId}|${sourceChannel.name}> — <${permalink}|view original from ${dateStr}>`;
    }
    const contextElements = [{ type: "mrkdwn", text: footerText }];

    // Suppress unfurl for direct messages and empty forwards (content shown inline), unless link mode
    const suppressUnfurl = sourceChannel.linkMode ? false : (!forwardLink || (Boolean(forwardLink) && isMessageEmpty(msg.text)));

    const parsedMetadata = (msg.metadata && msg.metadata != "") ? JSON.parse(msg.metadata) : null;
    const parsedSchema = sourceChannel.metadataSchema ? JSON.parse(sourceChannel.metadataSchema) : null;
    const metadataSection = (parsedMetadata && parsedSchema) ? Object.keys(parsedMetadata).map((metaProp) => {
      const field = parsedSchema.fields?.find((e: any) => e.action_id === metaProp);
      return `*${field?.label || metaProp}:* ${parsedMetadata[metaProp]}`;
    }).join("\n") + "\n" : "";

    console.log("metadata:", parsedMetadata, "schema:", sourceChannel.metadataSchema);

    try {
      if (sourceChannel.linkMode) {
        // Keep the raw permalink in the top-level text so Slack generates its unfurl.
        const linkBlocks: any[] = [];
        if (metadataSection) {
          linkBlocks.push({ type: "section", text: { type: "mrkdwn", text: metadataSection.trim() } });
        }
        linkBlocks.push({ type: "section", text: { type: "mrkdwn", text: footerText } });
        const res = await slack.chat.postMessage({
          channel: sub.subscriberChannelId,
          username: postUsername,
          icon_url: postIcon,
          unfurl_links: !metadataSection,
          unfurl_media: !metadataSection,
          text: metadataSection
            ? metadataSection.trim()
            : (forwardLink || footerText),
          blocks: linkBlocks,
        } as any);
        if (res?.ts) {
          await store.addBotAction({ type: "pub", sourceChannelId: msg.channelId, sourceMessageTs: msg.slackTs, botChannelId: sub.subscriberChannelId, botMessageTs: res.ts, createdAt: "" });
        }
        continue;
      }

      const blocks: any[] = [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: (originalText
                ? originalText
                : forwardLink
                  ? `<${forwardLink}|🔗 View forwarded message>`
                  : msg.text || "_[no text]_"
              ).slice(0, 3000),
            },
          },
        ];
        if (metadataSection) {
          blocks.push({ type: "section", text: { type: "mrkdwn", text: metadataSection.trim() } });
        }
        blocks.push({ type: "context", elements: contextElements });
        const res = await slack.chat.postMessage({
          channel: sub.subscriberChannelId,
          username: postUsername,
          icon_url: postIcon,
          unfurl_links: suppressUnfurl ? false : undefined,
          unfurl_media: suppressUnfurl ? false : undefined,
          text: (originalText
            ? `📰 *${postUsername}* in #${sourceChannel.name}:\n${originalText}`
            : forwardLink
              ? `📰 Forwarded from #${sourceChannel.name}\n${forwardLink}`
              : `📰 *${displayName}* in #${sourceChannel.name}:\n${msg.text}`
          ).slice(0, 3000),
          blocks,
        });
        if (res?.ts) {
          await store.addBotAction({ type: "pub", sourceChannelId: msg.channelId, sourceMessageTs: msg.slackTs, botChannelId: sub.subscriberChannelId, botMessageTs: res.ts, createdAt: "" });
        }
    } catch (err) {
      console.error(`Failed to forward to ${sub.subscriberChannelId}:`, err);
    }
  }
}

// --- Hono App ---

const app = new Hono<{ Bindings: Env }>();

// Public site configuration used by the static frontend.
app.get("/site-config", async (c) => {
  const env = c.env;
  const ids = (env.LOCKDOWN_USERS || "").split(",").map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) return c.json({ lockdownUsers: [] });

  const slack = new WebClient(env.SLACK_BOT_TOKEN);
  const lockdownUsers = await Promise.all(ids.map(async (id) => {
    let name = id;
    try {
      const response = await slack.users.info({ user: id });
      const user = response.user as any;
      name = user?.profile?.display_name || user?.name || user?.real_name || id;
    } catch {}
    return {
      id,
      name,
      url: `https://hackclub.enterprise.slack.com/team/${id}`,
    };
  }));

  return c.json({ lockdownUsers });
});

// Middleware: Basic Auth for /api routes
app.use("/api/*", async (c, next) => {
  const env = c.env;
  const apiPassword = env.API_PASSWORD || "";
  if (!apiPassword) return next();
  const apiUsername = env.API_USERNAME || "admin";
  const header = c.req.header("Authorization") || "";
  const match = header.match(/^Basic\s+(.+)$/);
  if (!match) {
    return c.text("Unauthorized", 401, { "WWW-Authenticate": "Basic realm=indigest" });
  }
  const decoded = atob(match[1]!);
  const [user, pass] = decoded.split(":");
  if (user !== apiUsername || pass !== apiPassword) {
    return c.text("Unauthorized", 401, { "WWW-Authenticate": "Basic realm=indigest" });
  }
  return next();
});

// === Scalar API Docs ===
app.get("/spec.json", (c) => {
  const spec = {
    openapi: "3.1.0",
    info: {
      title: "indigest",
      version: "1.0.0",
      description: "A Slack bot that curates messages into digestible feeds",
    },
    servers: [{ url: "/" }],
    paths: {
      "/feed/{channelId}": {
        get: {
          operationId: "getFeed",
          summary: "Get channel feed",
          description: "Returns an RSS feed or JSON feed of messages for a channel",
          tags: ["Feed"],
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
          ],
          responses: {
            "200": {
              description: "RSS feed (application/rss+xml) or JSON array depending on Accept header or .json suffix",
            },
          },
        },
      },
      "/api/messages": {
        get: {
          operationId: "listMessages",
          summary: "List messages",
          description: "List messages for a channel with filtering and pagination",
          tags: ["Messages"],
          security: [{ basicAuth: [] }],
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
          description: "Get a single message by its Slack timestamp",
          tags: ["API"],
          security: [{ basicAuth: [] }],
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
          description: "List all channels known to indigest (enabled and disabled).",
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
    },
    components: {
      securitySchemes: {
        basicAuth: {
          type: "http",
          scheme: "basic",
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
            approvedPosters: { type: "array", items: { type: "string" } },
            trackReplies: { type: "boolean" },
            metadataSchema: { type: "string" },
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

  if (!await verifySignature(c.req.raw, body, env.SLACK_SIGNING_SECRET)) {
    return c.json({ error: "invalid signature" }, 401);
  }

  // Respond immediately to prevent Slack retries
  c.res = new Response("ok", { status: 200, headers: { "Content-Type": "text/plain" } });

  c.executionCtx.waitUntil((async () => {
    console.log("Received Slack event:", payload.event?.type, "thread_ts:", payload.event?.thread_ts, "channel:", payload.event?.channel);
    const ev = payload.event;
    const store = await getStore(env.DATABASE_URL);
    const slack = new WebClient(env.SLACK_BOT_TOKEN);

    if (ev.type === "member_joined_channel") {
      const auth = await slack.auth.test();
      if (ev.user !== auth.user_id) return;
      const ch: StoreChannel = {
        id: ev.channel,
        name: "",
        teamId: auth.team_id || "",
        enabled: false,
        linkMode: false,
        webhookUrl: "",
        autoApproveUsers: [],
        approvedPosters: [],
        trackReplies: false,
        metadataSchema: "",
        createdAt: "",
      };
      await store.upsertChannel(ch);
      try {
        const conv = await slack.conversations.info({ channel: ev.channel });
        ch.name = (conv.channel as any)?.name || "";
        await store.upsertChannel(ch);
      } catch {}
    }

    if (ev.type === "message" && !ev.subtype && !ev.thread_ts) {
      const ch = await store.getChannel(ev.channel);
      if (!ch || !ch.enabled) return;

      // Log full event for debugging empty forward messages
      if (!ev.text && !ev.subtype) {
        console.log("Empty message event:", JSON.stringify({ text: ev.text, subtype: ev.subtype, attachments: ev.attachments, files: ev.files, x_files: ev.x_files, user: ev.user }));
      }

      if (ch.autoApproveUsers.length > 0) {
        console.log(`Auto-approving message from ${ev.user} in #${ch.name}`);
        if (!ch.autoApproveUsers.includes("*") && !ch.autoApproveUsers.includes(ev.user)) {
          return;
        }
        let userName = ev.user;
        try {
          const u = await slack.users.info({ user: ev.user });
          userName = (u.user as any)?.name || ev.user;
        } catch {}
        // Extract the original message permalink from the event
        // Check text first, then attachments (Slack forwards), then fallback
        let msgPermalink = "";
        if (isSlackPermalink(ev.text)) {
          msgPermalink = ev.text.trim();
        } else if (ev.attachments && ev.attachments.length > 0) {
          const att = ev.attachments[0];
          msgPermalink = att.from_url || att.original_url || att.permalink || "";
          if (!msgPermalink && att.text && att.text.includes("slack.com/archives/")) {
            const match = att.text.match(/https:\/\/\S+?slack\.com\/archives\/[A-Z0-9]+\/p\d+/);
            if (match) msgPermalink = match[0];
          }
        }
        const metadata = msgPermalink ? { slack_permalink: msgPermalink } : {};

        await store.upsertMessage({
          slackTs: ev.ts,
          channelId: ev.channel,
          userId: ev.user,
          userName,
          text: ev.text,
          timestamp: slackTsToTime(ev.ts).toISOString(),
          metadata,
        });
        await fireWebhook(ch, {
          slackTs: ev.ts,
          channelId: ev.channel,
          userId: ev.user,
          userName,
          text: ev.text,
          timestamp: slackTsToTime(ev.ts).toISOString(),
          metadata,
        });
        await forwardToSubscribers({ slackTs: ev.ts, channelId: ev.channel, userId: ev.user, userName, text: ev.text, timestamp: slackTsToTime(ev.ts).toISOString(), metadata }, ch, store, slack);
        // if (ch.linkMode) await postPermalinkReply(slack, ev.channel, ev.ts);

        // If channel has a metadata schema, prompt the user to add metadata
        if (ch.metadataSchema) {
          let schema: any = null;
          try { schema = JSON.parse(ch.metadataSchema); } catch {}
          if (schema && schema.fields?.length > 0) {
            try {
              await slack.chat.postMessage({
                channel: ev.channel,
                thread_ts: ev.ts,
                text: "Your message has been posted to the feed!",
                blocks: [
                  {
                    type: "section",
                    text: { type: "mrkdwn", text: "📰 Your message has been posted to the feed! Would you like to add some extra data?" },
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
            } catch {}
          }
        }

      } else {
        // Non-auto-approve: prompt for manual approval
        const section = {
          type: "section",
          text: { type: "mrkdwn", text: `Expose this message to indigest via RSS and API?\n>${ev.text}\n` },
          accessory: {
            type: "button",
            action_id: "indigest_yes",
            text: { type: "plain_text", text: "Yep!" },
            value: ev.ts,
          },
        };
        const actions = {
          type: "actions",
          elements: [
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
            blocks: [section, actions],
          });
        } catch {}
      }
    }

    // Thread reply tracking (separate from the top-level message handler above)
    if (ev.type === "message" && !ev.subtype && !ev.bot_id && ev.thread_ts) {
      console.log(`Thread reply: channel=${ev.channel} thread_ts=${ev.thread_ts} ts=${ev.ts}`);
      const ch = await store.getChannel(ev.channel);
      console.log(`Channel lookup: ch=${!!ch} enabled=${ch?.enabled} trackReplies=${ch?.trackReplies}`);
      if (!ch || !ch.enabled || !ch.trackReplies) return;

      // Store the parent message if not already stored
      const existingParent = (await store.getMessages(ev.channel, 200, 0)).find((m) => m.slackTs === ev.thread_ts);
      if (!existingParent) {
        try {
          const parentHistory = await slack.conversations.history({ channel: ev.channel, latest: ev.thread_ts!, limit: 1, inclusive: true });
          const parentMsg = parentHistory.messages?.[0] as any;
          if (parentMsg && !parentMsg.subtype && !parentMsg.bot_id) {
            let parentUserName = parentMsg.user || "";
            try { const u = await slack.users.info({ user: parentMsg.user }); parentUserName = (u.user as any)?.name || parentMsg.user; } catch {}
            await store.upsertMessage({
              slackTs: ev.thread_ts!,
              channelId: ev.channel,
              userId: parentMsg.user || "",
              userName: parentUserName,
              text: parentMsg.text || "",
              timestamp: slackTsToTime(ev.thread_ts!).toISOString(),
              metadata: {},
            });
          }
        } catch {}
      }

      // Store the reply
      let userName = ev.user;
      try { const u = await slack.users.info({ user: ev.user }); userName = (u.user as any)?.name || ev.user; } catch {}
      await store.upsertMessage({
        slackTs: ev.ts,
        channelId: ev.channel,
        threadTs: ev.thread_ts,
        userId: ev.user,
        userName,
        text: ev.text,
        timestamp: slackTsToTime(ev.ts).toISOString(),
        metadata: {},
      });
      console.log(`Thread reply stored: ts=${ev.ts} threadTs=${ev.thread_ts}`);
    }
  })());
});

// === Interactive Components ===
app.post("/interactions", async (c) => {
  const env = c.env;
  const body = await c.req.text();
  const formData = new URLSearchParams(body);
  const payloadStr = formData.get("payload");
  if (!payloadStr) return c.json({ error: "missing payload" }, 400);

  const cb = JSON.parse(payloadStr);

  // Metadata modal must open BEFORE responding — trigger_id expires in 3 seconds
  if (cb.type === "block_actions") {
    const action = cb.actions?.[0];
    if (action?.action_id === "indigest_metadata") {
      const store = await getStore(env.DATABASE_URL);
      const slack = new WebClient(env.SLACK_BOT_TOKEN);
      const channelId = cb.channel?.id;
      const messageTs = action.value;
      const triggerId = cb.trigger_id;
      const responseUrl = cb.response_url;

      const ch = await store.getChannel(channelId);
      if (!ch || !ch.enabled || !ch.metadataSchema) {
        return c.json({ response_action: "update", view: { type: "modal", title: { type: "plain_text", text: "Error" }, blocks: [{ type: "section", text: { type: "mrkdwn", text: "No metadata schema configured for this channel." } }] } });
      }
      let schema: any = null;
      try { schema = JSON.parse(ch.metadataSchema); } catch {}
      if (!schema || schema.fields?.length === 0) {
        return c.json({ response_action: "update", view: { type: "modal", title: { type: "plain_text", text: "Error" }, blocks: [{ type: "section", text: { type: "mrkdwn", text: "No metadata schema configured for this channel." } }] } });
      }
      const { openMetadataModal } = await import("./api/modal");
      try {
        await openMetadataModal(slack, triggerId, channelId, messageTs, schema, cb.container?.message_ts);
      } catch (err: any) {
        return c.json({ response_action: "update", view: { type: "modal", title: { type: "plain_text", text: "Error" }, blocks: [{ type: "section", text: { type: "mrkdwn", text: `Error opening form: ${err.message}` } }] } });
      }

      // Permission check after modal opens
      c.executionCtx.waitUntil((async () => {
        const clickingUser = cb.user?.id || "";
        const lockdownUsers = (env.LOCKDOWN_USERS || "").split(",").map((s: string) => s.trim()).filter(Boolean);
        const isManager = lockdownUsers.includes(clickingUser) || await isChannelManager(channelId, clickingUser, slack);
        if (isManager) return;
        const msgs = await store.getMessages(channelId, 100, 0);
        const originalMsg = msgs.find((m) => m.slackTs === messageTs);
        if (originalMsg?.userId !== clickingUser) {
          await slackResponse(responseUrl, "Only the original author or channel managers can edit metadata.");
        }
      })());
      return c.json({});
    }
  }

  // Respond immediately for everything else to prevent Slack timeout
  c.res = new Response(JSON.stringify({}), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  c.executionCtx.waitUntil((async () => {
  const store = await getStore(env.DATABASE_URL);
  const slack = new WebClient(env.SLACK_BOT_TOKEN);

  if (cb.type === "view_submission" && cb.view?.callback_id === "metadata_modal") {
    const privateMeta = JSON.parse(cb.view.private_metadata || "{}");
    const { channelId, messageTs, botMessageTs } = privateMeta;
    const channel = await store.getChannel(channelId);
    if (!channel || !channel.enabled) return;

    let schema: any = null;
    try { schema = JSON.parse(channel.metadataSchema); } catch {}

    const metadata = schema ? await (async () => {
      const m: Record<string, any> = {};
      for (const field of schema.fields || []) {
        const values = cb.view.state?.values?.[`field_${field.action_id}`]?.[field.action_id];
        if (!values) continue;
        if (field.type === "multi_static_select") m[field.action_id] = values.selected_options?.map((o: any) => o.value) || [];
        else if (field.type === "datepicker") m[field.action_id] = values.selected_date || "";
        else if (field.type === "file_input") {
          const files = values.files || [];
          m[field.action_id] = await Promise.all(
            files.map(async (f: any) => {
              if (!f.url_private) return { ...f, cdn_url: null };
              const cdnUrl = await uploadToCDN(f.url_private, env.SLACK_BOT_TOKEN, env.HACK_CLUB_CDN_KEY || "");
              return { ...f, cdn_url: cdnUrl };
            }),
          );
        }
        else m[field.action_id] = values.value || "";
      }
      return JSON.stringify(m);
    })() : "";

    const client = new WebClient(env.SLACK_BOT_TOKEN);
    try {
      const history = await client.conversations.history({ channel: channelId, latest: messageTs, limit: 1, inclusive: true });
      const msg = history.messages?.[0] as any;
      if (!msg) return;

      let userName = msg.user || "";
      try { const u = await client.users.info({ user: msg.user }); userName = (u.user as any)?.name || userName; } catch {}

      await store.upsertMessage({
        slackTs: messageTs,
        channelId,
        userId: msg.user || "",
        userName,
        text: msg.text || "",
        timestamp: slackTsToTime(messageTs).toISOString(),
        metadata,
      });

      await fireWebhook(channel, {
        slackTs: messageTs,
        channelId,
        userId: msg.user || "",
        userName,
        text: msg.text || "",
        timestamp: slackTsToTime(messageTs).toISOString(),
        metadata,
      });

      // Build metadata section for editing subscriber messages
      const parsedMetadata = metadata ? JSON.parse(metadata) : null;
      const parsedSchema = channel.metadataSchema ? JSON.parse(channel.metadataSchema) : null;
      const metadataSection = (parsedMetadata && parsedSchema) ? Object.keys(parsedMetadata).map((metaProp) => {
        const field = parsedSchema.fields?.find((e: any) => e.action_id === metaProp);
        return `*${field?.label || metaProp}:* ${parsedMetadata[metaProp]}`;
      }).join("\n") : "";

      // Find existing bot actions for this source message and edit them with metadata
      const botActions = await store.getBotActionsBySource(channelId, messageTs);
      for (const action of botActions) {
        if (action.type === "pub" && metadataSection) {
          try {
            // Fetch the current bot message to get its blocks
            const botMsg = await client.conversations.history({ channel: action.botChannelId, latest: action.botMessageTs, limit: 1, inclusive: true });
            const existingMsg = botMsg.messages?.[0] as any;
            if (existingMsg?.blocks) {
              // Insert metadata section before the context block (last block)
              const blocks = [...existingMsg.blocks];
              const contextIdx = blocks.findIndex((b: any) => b.type === "context");
              const metaBlock = { type: "section", text: { type: "mrkdwn", text: metadataSection } };
              if (contextIdx >= 0) {
                blocks.splice(contextIdx, 0, metaBlock);
              } else {
                blocks.push(metaBlock);
              }
              await client.chat.update({
                channel: action.botChannelId,
                ts: action.botMessageTs,
                text: existingMsg.text || "",
                blocks,
              } as any);
            }
          } catch (err: any) {
            console.error(`Failed to update bot message ${action.botChannelId}:${action.botMessageTs}:`, err.message);
          }
        }
      }

      // Also forward to any new subscribers that weren't captured in the initial forward
      await forwardToSubscribers({ slackTs: messageTs, channelId, userId: msg.user || "", userName, text: msg.text || "", timestamp: slackTsToTime(messageTs).toISOString(), metadata }, channel, store, slack);
      if (channel.linkMode) await postPermalinkReply(client, channelId, messageTs);

      // Update the bot's prompt to show approved state
      if (botMessageTs) {
        try {
          await client.chat.update({
            channel: channelId,
            ts: botMessageTs,
            text: "✅ Message approved and added to the feed!",
            blocks: [
              {
                type: "section",
                text: { type: "mrkdwn", text: "✅ *Message approved and added to the feed!*" },
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
                ],
              },
            ],
          } as any);
        } catch (err: any) { console.error("chat.update (view_submission) failed:", err.message); }
      }
    } catch (err: any) { console.error("view_submission error:", err.message); }
    return;
  }

  // Backfill shortcut: manually pub a message
  if (cb.type === "message_action") {
    const channelId = cb.channel?.id;
    const messageTs = cb.message?.ts;
    const triggerId = cb.trigger_id;
    const clickingUser = cb.user?.id || "";

    if (!channelId || !messageTs) {
      await slackResponse(cb.response_url || "", "Could not identify the message to backfill.");
      return c.json({});
    }

    c.executionCtx.waitUntil((async () => {
      const store = await getStore(env.DATABASE_URL);
      const slack = new WebClient(env.SLACK_BOT_TOKEN);

      const lockdownUsers = (env.LOCKDOWN_USERS || "").split(",").map((s: string) => s.trim()).filter(Boolean);
      const isLockdown = lockdownUsers.includes(clickingUser);
      const isManager = isLockdown || await isChannelManager(channelId, clickingUser, slack);

      if (!isManager) {
        const ch = await store.getChannel(channelId);
        if (!ch || !ch.enabled) {
          await slack.chat.postMessage({ channel: channelId, text: "❌ This channel isn't enabled for indigest. Run `/in pub` first." });
          return;
        }
      }

      try {
        const history = await slack.conversations.history({ channel: channelId, latest: messageTs, limit: 1, inclusive: true });
        const msg = history.messages?.[0] as any;
        if (!msg || msg.subtype || msg.bot_id) {
          await slack.chat.postMessage({ channel: channelId, text: "❌ That message can't be added to the feed (bot message or system message)." });
          return;
        }

        let userName = msg.user || "";
        try { const u = await slack.users.info({ user: msg.user }); userName = (u.user as any)?.name || msg.user; } catch {}

        let msgPermalink = "";
        if (isSlackPermalink(msg.text)) {
          msgPermalink = msg.text.trim();
        } else if (msg.attachments && msg.attachments.length > 0) {
          const att = msg.attachments[0];
          msgPermalink = att.from_url || att.original_url || att.permalink || "";
          if (!msgPermalink && att.text && att.text.includes("slack.com/archives/")) {
            const match = att.text.match(/https:\/\/\S+?slack\.com\/archives\/[A-Z0-9]+\/p\d+/);
            if (match) msgPermalink = match[0];
          }
        }
        const metadata = msgPermalink ? { slack_permalink: msgPermalink } : {};

        const ch = await store.getChannel(channelId);
        await store.upsertMessage({
          slackTs: messageTs,
          channelId,
          userId: msg.user || "",
          userName,
          text: msg.text || "",
          timestamp: slackTsToTime(messageTs).toISOString(),
          metadata,
        });

        const savedMsg = { slackTs: messageTs, channelId, userId: msg.user || "", userName, text: msg.text || "", timestamp: slackTsToTime(messageTs).toISOString(), metadata };
        if (ch) await fireWebhook(ch, savedMsg);
        if (ch) await forwardToSubscribers(savedMsg, ch, store, slack);
      } catch (err: any) {
        console.error("backfill shortcut error:", err.message);
        await slack.chat.postMessage({ channel: channelId, text: `❌ Error backfilling message: ${err.message}` });
      }
    })());
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

  const ch = await store.getChannel(channelId);
  if (!ch || !ch.enabled) {
    await slackResponse(responseUrl, "This channel is not enabled.");
    return;
  }

  if (action.action_id === "indigest_yes") {
    const clickingUser = cb.user?.id || "";

    // Open modal IMMEDIATELY — trigger_id expires in 3s, can't afford slow checks first
    if (ch.metadataSchema) {
      let schema: any = null;
      try { schema = JSON.parse(ch.metadataSchema); } catch {}
      if (schema && schema.fields?.length > 0) {
        const { openMetadataModal } = await import("./api/modal");
        try {
          await openMetadataModal(slack, triggerId, channelId, messageTs, schema, cb.container?.message_ts);
        } catch (err: any) {
          console.error("openMetadataModal failed:", err.message);
          if (err.message?.includes("expired_trigger_id")) {
            await slack.chat.postEphemeral({ channel: channelId, user: clickingUser, text: "⏱️ Form expired — please click Approve again." });
          } else {
            await slack.chat.postEphemeral({ channel: channelId, user: clickingUser, text: `❌ Error opening form: ${err.message}` });
          }
          return;
        }

        // Permission check AFTER modal is open
        const lockdownUsers = (env.LOCKDOWN_USERS || "").split(",").map((s: string) => s.trim()).filter(Boolean);
        const isLockdown = lockdownUsers.includes(clickingUser);
        const isManager = isLockdown || await isChannelManager(channelId, clickingUser, slack);
        if (!isManager) {
          const msgs = await store.getMessages(channelId, 100, 0);
          const originalMsg = msgs.find((m) => m.slackTs === messageTs);
          if (originalMsg) {
            let allowed = true;
            if (ch.approvedPosters.length === 0) {
              allowed = originalMsg.userId === clickingUser;
            } else if (ch.approvedPosters.includes("poster")) {
              allowed = originalMsg.userId === clickingUser || ch.approvedPosters.includes(clickingUser);
            } else {
              allowed = ch.approvedPosters.includes(clickingUser);
            }
            if (!allowed) {
              await slack.chat.postEphemeral({ channel: channelId, user: clickingUser, text: "❌ You don't have permission to approve this message." });
              return;
            }
          }
        }
        return;
      }
    }

    // No metadata schema — do permission checks first, then approve directly
    const lockdownUsers = (env.LOCKDOWN_USERS || "").split(",").map((s: string) => s.trim()).filter(Boolean);
    const isLockdown = lockdownUsers.includes(clickingUser);
    const isManager = isLockdown || await isChannelManager(channelId, clickingUser, slack);

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

      let userName = msg.user || "";
      try { const u = await slack.users.info({ user: msg.user }); userName = (u.user as any)?.name || userName; } catch {}

      await store.upsertMessage({
        slackTs: messageTs,
        channelId,
        userId: msg.user || "",
        userName,
        text: msg.text || "",
        timestamp: slackTsToTime(messageTs).toISOString(),
        metadata: {},
      });

      const savedMsg = { slackTs: messageTs, channelId, userId: msg.user || "", userName, text: msg.text || "", timestamp: slackTsToTime(messageTs).toISOString(), metadata: {} };
      await fireWebhook(ch, savedMsg);
      await forwardToSubscribers(savedMsg, ch, store, slack);
      if (ch.linkMode) await postPermalinkReply(slack, channelId, messageTs);

      // Update the bot's prompt to show approved state
      if (botMessageTs) {
        try {
          await slack.chat.update({
            channel: channelId,
            ts: botMessageTs,
            text: "✅ Message approved and added to the feed!",
            blocks: [
              {
                type: "section",
                text: { type: "mrkdwn", text: "✅ *Message approved and added to the feed!*" },
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
                ],
              },
            ],
          } as any);
        } catch (err: any) { console.error("chat.update (yes) failed:", err.message, "botMessageTs:", botMessageTs, "channel:", channelId); }
      } else {
        console.warn("indigest_yes: botMessageTs is empty, skipping chat.update. container:", JSON.stringify(cb.container));
      }

      await slackResponse(responseUrl, "");
    } catch (err: any) {
      await slackResponse(responseUrl, `Error: ${err.message}`);
    }
  } else if (action.action_id === "indigest_no") {
    // Remove the message from the DB if it was previously approved
    try {
      await store.deleteMessage(channelId, messageTs);
    } catch (err: any) { console.error("deleteMessage failed:", err.message); }

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
      } catch (err: any) { console.error("chat.update (no) failed:", err.message, "botMessageTs:", botMessageTs, "channel:", channelId); }
    } else {
      console.warn("indigest_no: botMessageTs is empty, skipping chat.update. container:", JSON.stringify(cb.container));
    }

    await slackResponse(responseUrl, "");
  }

  return;
  })());
});

// === Slash Commands ===
const slackSlashCommand = async (c: any) => {
  const env = c.env;
  const body = await c.req.text();
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

  c.header("Content-Type", "application/json");
  c.header("X-Slack-Response-Accepted", "1");
  c.res = new Response(JSON.stringify({ response_type: "ephemeral", text: "⏳ Processing..." }), { status: 200, headers: c.res.headers });

  c.executionCtx.waitUntil((async () => {
  const store = await getStore(env.DATABASE_URL);
  const slack = new WebClient(env.SLACK_BOT_TOKEN);
  const baseUrl = env.BASE_URL || "http://localhost:8080";
  const lockdownUsers = (env.LOCKDOWN_USERS || "").split(",").map((s: string) => s.trim()).filter(Boolean);

  const channelRefMatch = text.match(/^(<#(\w+)(\|[^>]*)?>|#(\S+))\s*(.*)$/);
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
        const list = await slack.conversations.list({ types: "public_channel,private_channel", limit: 1000 });
        const channels = list.channels as any[] || [];
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

  let ch = await store.getChannel(targetChannelId);
  if (!ch) {
    let name = targetChannelId;
    try {
      const conv = await slack.conversations.info({ channel: targetChannelId });
      name = (conv.channel as any)?.name || targetChannelId;
    } catch {}
    const auth = await slack.auth.test();
    ch = { id: targetChannelId, name, teamId: auth.team_id || "", enabled: false, linkMode: false, webhookUrl: "", autoApproveUsers: [], approvedPosters: [], trackReplies: false, metadataSchema: "", createdAt: "" };
    await store.upsertChannel(ch);
  }

  const parts = rest.split(/\s+/);
  const cmd = parts[0];
  const subcmd = parts[1];
  const arg = parts.slice(2).join(" ");
console.log(`Slash command: user=${userId} channel=${targetChannelId} cmd=${cmd} subcmd=${subcmd} arg=${arg}`);
  const targetManager = () => lockdownUsers.includes(userId) || isChannelManager(targetChannelId, userId, slack);

  if (lockdownUsers.length > 0 && !lockdownUsers.includes(userId) && cmd !== "status" && cmd !== "") {
    await respond("🔒 indigest is in lockdown mode. Only authorized users can run commands.");
    return;
  }

  switch (cmd) {
    case "pub": {
      if (subcmd === "auto") {
        const target = arg.replace(/^<@(\w+)(\|[^>]*)?>$/, "$1").trim();

        ch.enabled = true;

        if (!target) {
          ch.autoApproveUsers = ["*"];
          await store.upsertChannel(ch);
          await respond(`📰 Auto-approve enabled for all users in #${ch.name}.\nRSS: ${baseUrl}/feed/${targetChannelId}\nJSON: ${baseUrl}/feed/${targetChannelId}.json`);
          return;
        }

        if (target !== userId) {
          try {
            const u = await slack.users.info({ user: target });
            const isBot = (u.user as any)?.is_bot;
            if (!isBot) {
              if (!(await targetManager())) {
                await respond("Only the channel creator can enable auto-approve for another non-bot user.");
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
        await store.upsertChannel(ch);
        await respond(`📰 Auto-approve enabled for <@${target}> in #${ch.name}.\nRSS: ${baseUrl}/feed/${targetChannelId}\nJSON: ${baseUrl}/feed/${targetChannelId}.json`);
        return;
      }

      if (subcmd === "link") {
        if (!(await targetManager())) {
          await respond("Only the channel creator can enable link mode.");
          return;
        }
        ch.enabled = true;
        const wantsOff = ["off", "disable", "disabled", "0", "false"].includes((arg || "").trim().toLowerCase());
        ch.linkMode = !wantsOff;
        await store.upsertChannel(ch);
        const label = targetChannelId === sourceChannelId ? "this channel" : `#${ch.name}`;
        if (ch.linkMode) {
          await respond(`🔗 Link mode enabled for ${label}. Approved messages will get an unfurlable permalink reply.\nRSS: ${baseUrl}/feed/${targetChannelId}\nJSON: ${baseUrl}/feed/${targetChannelId}.json`);
        } else {
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
        ch.autoApproveUsers = [];
        await store.upsertChannel(ch);
        const label = targetChannelId === sourceChannelId ? "this channel" : `#${ch.name}`;
        await respond(`📰 Manual mode enabled for ${label}. Every message will get a Yep!/No prompt.\nRSS: ${baseUrl}/feed/${targetChannelId}\nJSON: ${baseUrl}/feed/${targetChannelId}.json`);
        return;
      }

      if (subcmd === "replies") {
        if (!(await targetManager())) {
          await respond("Only the channel creator can toggle reply tracking.");
          return;
        }
        ch.trackReplies = !ch.trackReplies;
        ch.enabled = true;
        await store.upsertChannel(ch);
        const label = targetChannelId === sourceChannelId ? "this channel" : `#${ch.name}`;
        if (ch.trackReplies) {
          await respond(`📰 Reply tracking enabled for ${label}. Thread replies will now be backed up with their reply relationship.`);
        } else {
          await respond(`📰 Reply tracking disabled for ${label}.`);
        }
        return;
      }

      if (subcmd) {
        await respond("Usage: \`/in pub\` | \`/in pub #channel\` | \`/in pub auto @user\` | \`/in pub manual\` | \`/in pub link\` | \`/in pub replies\`");
        return;
      }
      if (!(await targetManager())) {
        await respond("Only the channel creator can pub indigest.");
        return;
      }
      ch.enabled = true;
      ch.autoApproveUsers = [];
      await store.upsertChannel(ch);
      const label = targetChannelId === sourceChannelId ? "" : ` in #${ch.name}`;
      await respond(`📰 indigest pub'd${label}. New messages will get a prompt to add to the feed.\nRSS: ${baseUrl}/feed/${targetChannelId}\nJSON: ${baseUrl}/feed/${targetChannelId}.json`);
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
          await store.upsertChannel(ch);
          await respond(`Auto-approve disabled for all users in #${ch.name}.`);
          return;
        }
        ch.autoApproveUsers = ch.autoApproveUsers.filter((id) => id !== target);
        await store.upsertChannel(ch);
        await respond(`Auto-approve disabled for <@${target}> in #${ch.name}.`);
        return;
      }

      if (subcmd) {
        await respond("Usage: \`/in unpub\` | \`/in unpub #channel\` | \`/in unpub auto [@user]\`");
        return;
      }
      if (!(await targetManager())) {
        await respond("Only the channel creator can unpub indigest.");
        return;
      }
      ch.enabled = false;
      await store.upsertChannel(ch);
      const label = targetChannelId === sourceChannelId ? "" : ` in #${ch.name}`;
      await respond(`indigest unpub'd${label}.`);
      return;
    }

    case "sub": {
      if (!(await targetManager())) {
        await respond("Only the channel creator or workspace admin can subscribe channels.");
        return;
      }

      const subArg = [subcmd, arg].filter(Boolean).join(" ");
      if (!subArg) {
        await respond("Usage: \`/indigest sub #channel\` — subscribe this channel to receive messages from #channel.");
        return;
      }

      const subChannelMatch = subArg.match(/^(<#(\w+)(\|[^>]*)?>|#(\S+))\s*$/);
      if (!subChannelMatch) {
        await respond("Usage: \`/indigest sub #channel\` — subscribe this channel to receive messages from #channel.");
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
          const list = await slack.conversations.list({ types: "public_channel,private_channel", limit: 1000 });
          const channels = list.channels as any[] || [];
          const found = channels.find((c: any) => c.name === subNameFromRef);
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

      const sourceCh = await store.getChannel(sourceId);
      sourceName = sourceCh?.name || subNameFromRef || sourceId;

      if (sourceId === sourceChannelId) {
        await respond("Can't subscribe a channel to itself.");
        return;
      }

      if (!sourceCh || !sourceCh.enabled) {
        await respond(`#${sourceName} is not pub'd yet. It must be pub'd before other channels can subscribe to it.`);
        return;
      }

      const existingSubs = await store.getSubscriptionsBySubscriber(sourceChannelId);
      if (existingSubs.some((s) => s.sourceChannelId === sourceId)) {
        await respond(`Already subscribed to #${sourceName}.`);
        return;
      }

      await store.addSubscription(sourceChannelId, sourceId);
      await respond(`📰 Subscribed to #${sourceName}. Messages pub'd there will be forwarded here.`);
      return;
    }

    case "unsub": {
      if (!(await targetManager())) {
        await respond("Only the channel creator or workspace admin can unsubscribe channels.");
        return;
      }

      const unsubArg = [subcmd, arg].filter(Boolean).join(" ");
      if (!unsubArg) {
        await respond("Usage: \`/indigest unsub #channel\` — unsubscribe this channel from #channel.");
        return;
      }

      const unsubChannelMatch = unsubArg.match(/^(<#(\w+)(\|[^>]*)?>|#(\S+))\s*$/);
      if (!unsubChannelMatch) {
        await respond("Usage: \`/indigest unsub #channel\` — unsubscribe this channel from #channel.");
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
          const list = await slack.conversations.list({ types: "public_channel,private_channel", limit: 1000 });
          const channels = list.channels as any[] || [];
          const found = channels.find((c: any) => c.name === unsubNameFromRef);
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

      const sourceCh = await store.getChannel(sourceId);
      sourceName = sourceCh?.name || unsubNameFromRef || sourceId;

      const existingSubs = await store.getSubscriptionsBySubscriber(sourceChannelId);
      if (!existingSubs.some((s) => s.sourceChannelId === sourceId)) {
        await respond(`Not subscribed to #${sourceName}.`);
        return;
      }

      await store.removeSubscription(sourceChannelId, sourceId);
      await respond(`📰 Unsubscribed from #${sourceName}.`);
      return;
    }

    case "status": {
      const chName = targetChannelId === sourceChannelId ? "" : `#${ch.name} `;

      const perms: string[] = [];
      try {
        const conv = await slack.conversations.info({ channel: targetChannelId });
        const creator = (conv.channel as any)?.creator;
        if (creator === userId) perms.push("channel creator");
      } catch {}
      if (lockdownUsers.includes(userId)) perms.push("lockdown override");
      const permStr = perms.length > 0 ? `\nYour perms: ${perms.join(", ")}` : "\nYour perms: none (can view feeds only)";

      if (ch.enabled) {
        let msg = `📰 indigest pub'd for ${chName}\nRSS: ${baseUrl}/feed/${targetChannelId}\nJSON: ${baseUrl}/feed/${targetChannelId}.json`;
        if (ch.linkMode) msg += `\nMode: link`;
        if (ch.webhookUrl) msg += `\nWebhook: ${ch.webhookUrl}`;
        if (ch.autoApproveUsers.length > 0) {
          const autoLabel = ch.autoApproveUsers.includes("*") ? "all users" : ch.autoApproveUsers.map((id) => `<@${id}>`).join(", ");
          msg += `\nAuto-approve: ${autoLabel}`;
        }
        if (ch.metadataSchema) {
          try {
            const s = JSON.parse(ch.metadataSchema);
            msg += `\nMetadata schema: ${s.fields?.length || 0} field(s)`;
    } catch (err: any) { console.error("view_submission error:", err.message); }
        }
        if (ch.approvedPosters.length > 0) {
          if (ch.approvedPosters.includes("poster")) {
            const extraUsers = ch.approvedPosters.filter((id) => id !== "poster");
            const extraLabel = extraUsers.length > 0 ? ` + ${extraUsers.map((id) => `<@${id}>`).join(", ")}` : "";
            msg += `\nApprovals: poster mode${extraLabel}`;
          } else {
            msg += `\nApprovals: ${ch.approvedPosters.map((id) => `<@${id}>`).join(", ")}`;
          }
        } else {
          msg += `\nApprovals: poster + managers (default)`;
        }
        msg += `\nThread replies: ${ch.trackReplies ? "tracked" : "off"}`;
        const subs = await store.getSubscriptionsBySubscriber(targetChannelId);
        if (subs.length > 0) {
          const subNames = await Promise.all(subs.map(async (s) => {
            const sch = await store.getChannel(s.sourceChannelId);
            return sch ? `#${sch.name}` : s.sourceChannelId;
          }));
          msg += `\nSubscribed to: ${subNames.join(", ")}`;
        }
        const subscribers = await store.getSubscribersBySource(targetChannelId);
        if (subscribers.length > 0) {
          const subNames = await Promise.all(subscribers.map(async (s) => {
            const sch = await store.getChannel(s.subscriberChannelId);
            return sch ? `#${sch.name}` : s.subscriberChannelId;
          }));
          msg += `\nSubscribers: ${subNames.join(", ")}`;
        }
        msg += permStr;
        await respond(msg);
        return;
      }
      await respond(`indigest is not pub'd for ${chName}Run \`/in pub\` to start.${permStr}`);
      return;
    }

    default: {
      if (!cmd) {
        await respond("Commands:\n• \`pub [#channel]\` — enable indigest\n• \`unpub [#channel]\` — disable indigest\n• \`pub auto [@user]\` — auto-approve mode\n• \`pub manual\` — manual approve mode\n• \`pub replies\` — track thread replies\n• \`sub #channel\` — subscribe to another channel's feed\n• \`unsub #channel\` — unsubscribe from a channel\n• \`perms @user\` — set who can approve messages\n• \`status [#channel]\` — show status\n• \`webhook <url>\` — set webhook\n• \`schema set <json>\` | \`schema get\` | \`schema clear\`");
        return;
      }

      if (cmd === "webhook") {
        if (targetChannelId !== sourceChannelId) {
          await respond("Webhook commands must be run from the target channel.");
          return;
        }
        if (!(await targetManager())) {
          await respond("Only the channel creator can configure webhooks.");
          return;
        }
        if (subcmd === "clear") {
          ch.webhookUrl = "";
          await store.upsertChannel(ch);
          await respond("Webhook cleared.");
          return;
        }
        const url = parts.slice(1).join(" ");
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
          await respond("Invalid URL. Must start with http:// or https://");
          return;
        }
        ch.webhookUrl = url;
        await store.upsertChannel(ch);
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
        const users = ch.autoApproveUsers.map((id) => `<@${id}>`).join(", ");
        await respond(`Auto-approve in #${ch.name}: ${users}`);
        return;
      }

      if (cmd === "schema") {
        if (subcmd === "get") {
          if (!ch.metadataSchema) {
            await respond("No metadata schema configured for this channel.");
            return;
          }
          try {
            const pretty = JSON.stringify(JSON.parse(ch.metadataSchema), null, 2);
            await respond(`\`\`\`${pretty}\`\`\``);
          } catch {
            await respond(`Raw schema:\n${ch.metadataSchema}`);
          }
          return;
        }

        if (subcmd === "clear") {
          ch.metadataSchema = "";
          await store.upsertChannel(ch);
          await respond("Metadata schema cleared.");
          return;
        }

        if (subcmd === "set") {
          if (!arg) {
            await respond("Usage: \`/in schema set <json>\` — provide a valid metadata schema JSON.");
            return;
          }
          try {
            const parsed = JSON.parse(arg);
            if (!parsed.fields || !Array.isArray(parsed.fields)) {
              await respond("Schema must have a \`fields\` array. Example: \`{\"title\": \"Metadata\", \"fields\": [{\"action_id\": \"title\", \"label\": \"Title\", \"type\": \"plain_text_input\"}]}\`");
              return;
            }
            ch.metadataSchema = JSON.stringify(parsed);
            await store.upsertChannel(ch);
            await respond(`📰 Metadata schema set with ${parsed.fields.length} field(s).`);
          } catch (e: any) {
            await respond(`Invalid JSON: ${e.message}`);
          }
          return;
        }

        await respond("Usage: \`/in schema set <json>\` | \`/in schema get\` | \`/in schema clear\`");
        return;
      }

      if (cmd === "perms") {
        if (subcmd === "get" || (!subcmd && !arg)) {
          if (ch.approvedPosters.length === 0) {
            await respond("Default mode: only the original poster and channel managers can approve messages.");
          } else if (ch.approvedPosters.includes("poster")) {
            await respond(`Poster mode: the original poster of each message can approve it, plus channel managers.`);
          } else {
            const users = ch.approvedPosters.map((id) => `<@${id}>`).join(", ");
            await respond(`Approved posters for #${ch.name}: ${users}\nPlus channel managers.`);
          }
          return;
        }

        if (subcmd === "clear") {
          ch.approvedPosters = [];
          await store.upsertChannel(ch);
          await respond("Poster permissions cleared. Back to default: only the original poster and channel managers can approve.");
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
          await respond("Usage: \`/in perms @user1 @user2\` — restrict to specific users\n\`/in perms poster\` — let each message's author approve their own\n\`/in perms get\` — view current permissions\n\`/in perms clear\` — restore defaults");
          return;
        }

        ch.approvedPosters = posterMode ? ["poster", ...userIds] : userIds;
        await store.upsertChannel(ch);
        if (posterMode && userIds.length > 0) {
          const users = userIds.map((id) => `<@${id}>`).join(", ");
          await respond(`📰 Poster permissions set for #${ch.name}: poster mode + ${users}`);
        } else if (posterMode) {
          await respond(`📰 Poster mode enabled for #${ch.name}. Each message's author can approve their own message.`);
        } else {
          const users = userIds.map((id) => `<@${id}>`).join(", ");
          await respond(`📰 Poster permissions set for #${ch.name}: ${users}`);
        }
        return;
      }

      await respond("Commands:\n• \`pub [#channel]\` — enable indigest\n• \`unpub [#channel]\` — disable indigest\n• \`pub auto [@user]\` — auto-approve mode\n• \`pub manual\` — manual approve mode\n• \`pub replies\` — track thread replies\n• \`sub #channel\` — subscribe to another channel's feed\n• \`unsub #channel\` — unsubscribe from a channel\n• \`perms @user\` — set who can approve messages\n• \`status [#channel]\` — show status\n• \`webhook <url>\` — set webhook\n• \`schema set <json>\` | \`schema get\` | \`schema clear\`");
    }
  }
  })());
};

app.post("/slack", slackSlashCommand);
app.post("/slack/", slackSlashCommand);

// === RSS Feed / JSON API ===
app.get("/feed/:channelId", async (c) => {
  try {
    const env = c.env;
    const rawId = c.req.param("channelId")!;
    const wantsJson = rawId.endsWith(".json") || c.req.header("accept")?.includes("application/json");
    const channelId = wantsJson ? rawId.replace(/\.json$/, "") : rawId;
    const store = await getStore(env.DATABASE_URL);
    const ch = await store.getChannel(channelId);
    if (!ch || !ch.enabled) {
      return c.json({ error: "not found", id: channelId }, 404);
    }

    const limit = Math.min(parseInt(c.req.query("limit") || "50") || 50, 200);
    const offset = parseInt(c.req.query("offset") || "0") || 0;
    const msgs = await store.getMessages(channelId, limit, offset);

    if (wantsJson) {
      return c.json(msgs);
    }

    const baseUrl = env.BASE_URL || "http://localhost:8080";
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

    return c.text(feed.rss2(), 200, { "Content-Type": "application/rss+xml; charset=utf-8" });
  } catch (err: any) {
    console.error("feed error:", err?.message || err);
    c.header("Retry-After", "2");
    return c.text("Service Unavailable", 503);
  }
});

// === REST API ===
app.get("/api/messages", async (c) => {
  const env = c.env;
  const store = await getStore(env.DATABASE_URL);
  const channel = c.req.query("channel");
  if (!channel) {
    return c.json({ error: "channel is required" }, 400);
  }

  const ch = await store.getChannel(channel);
  if (!ch || !ch.enabled) {
    return c.json({ error: "channel not found or not enabled" }, 404);
  }

  const after = c.req.query("after");
  const before = c.req.query("before");
  const userId = c.req.query("userId");
  const limit = Math.min(parseInt(c.req.query("limit") || "50") || 50, 10000);
  const page = parseInt(c.req.query("page") || "1") || 1;

  const all = await store.getMessages(channel, 100000, 0);

  let filtered = all;
  if (after) filtered = filtered.filter((m) => m.timestamp >= after);
  if (before) filtered = filtered.filter((m) => m.timestamp <= before);
  if (userId) filtered = filtered.filter((m) => m.userId === userId);

  const total = filtered.length;
  const offset = (page - 1) * limit;
  const items = filtered.slice(offset, offset + limit);

  return c.json({
    data: items,
    pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
  });
});

app.get("/api/messages/:slackTs", async (c) => {
  const env = c.env;
  const store = await getStore(env.DATABASE_URL);
  const slackTs = decodeURIComponent(c.req.param("slackTs"));
  const channel = c.req.query("channel") || "";

  if (!channel) {
    return c.json({ error: "channel is required" }, 400);
  }

  const all = await store.getMessages(channel, 100000, 0);
  const msg = all.find((m) => m.slackTs === slackTs);
  if (!msg) {
    return c.json({ error: "message not found" }, 404);
  }

  return c.json({ data: msg });
});

app.get("/api/channels", async (c) => {
  const env = c.env;
  const store = await getStore(env.DATABASE_URL);
  const channels = await store.listChannels();
  return c.json({ data: channels });
});

app.get("/api/channels/:id", async (c) => {
  const env = c.env;
  const store = await getStore(env.DATABASE_URL);
  const id = decodeURIComponent(c.req.param("id"));
  const ch = await store.getChannel(id);
  if (!ch) return c.json({ error: "channel not found" }, 404);
  return c.json({ data: ch });
});

// --- Graph API (for React Flow diagram) ---
app.get("/api/graph", async (c) => {
  const env = c.env;
  const store = await getStore(env.DATABASE_URL);

  const channels = await store.listEnabledChannels();
  const nodes: Array<{ id: string; type: string; label: string; data: Record<string, any> }> = [];
  const edges: Array<{ id: string; source: string; target: string; label?: string; animated: boolean }> = [];

  for (const ch of channels) {
    nodes.push({ id: `ch:${ch.id}`, type: "channel", label: `#${ch.name || ch.id}`, data: { channelId: ch.id, name: ch.name, webhookUrl: ch.webhookUrl, metadataSchema: ch.metadataSchema, trackReplies: ch.trackReplies, approvedPosters: ch.approvedPosters, autoApproveUsers: ch.autoApproveUsers?.join(", ") || "", enabled: ch.enabled, linkMode: ch.linkMode, createdAt: ch.createdAt } });
    nodes.push({ id: `rss:${ch.id}`, type: "feed", label: "RSS Feed", data: { feedType: "rss", channelId: ch.id } });
    edges.push({ id: `e-rss-${ch.id}`, source: `ch:${ch.id}`, target: `rss:${ch.id}`, animated: true });
    nodes.push({ id: `api:${ch.id}`, type: "feed", label: "API Feed", data: { feedType: "api", channelId: ch.id } });
    edges.push({ id: `e-api-${ch.id}`, source: `ch:${ch.id}`, target: `api:${ch.id}`, animated: true });
    if (ch.webhookUrl) {
      nodes.push({ id: `wh:${ch.id}`, type: "feed", label: "Webhook", data: { feedType: "webhook", channelId: ch.id, url: ch.webhookUrl } });
      edges.push({ id: `e-wh-${ch.id}`, source: `ch:${ch.id}`, target: `wh:${ch.id}`, animated: true });
    }
    const subscribers = await store.getSubscribersBySource(ch.id);
    for (const sub of subscribers) {
      const subCh = await store.getChannel(sub.subscriberChannelId);
      const subLabel = subCh ? `#${subCh.name || subCh.id}` : sub.subscriberChannelId;
      if (!nodes.find((n) => n.id === `sub:${sub.subscriberChannelId}`)) {
        nodes.push({ id: `sub:${sub.subscriberChannelId}`, type: "subscriber", label: subLabel, data: { channelId: sub.subscriberChannelId, name: subCh?.name, webhookUrl: subCh?.webhookUrl, metadataSchema: subCh?.metadataSchema, trackReplies: subCh?.trackReplies, approvedPosters: subCh?.approvedPosters, autoApproveUsers: subCh?.autoApproveUsers?.join(", ") || "", enabled: subCh?.enabled, linkMode: subCh?.linkMode, createdAt: subCh?.createdAt } });
      }
      edges.push({ id: `e-sub-${ch.id}-${sub.subscriberChannelId}`, source: `ch:${ch.id}`, target: `sub:${sub.subscriberChannelId}`, label: "[sub]", animated: true });
    }
  }

  return c.json({ data: { nodes, edges } });
});

// --- Store (lazy singleton per DB URL) ---

const storeCache = new Map<string, Store>();
const ddlRan = new Set<string>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientDbError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("timeout") ||
    msg.includes("network") ||
    msg.includes("fetch failed") ||
    msg.includes("dns") ||
    msg.includes("getaddrinfo") ||
    msg.includes("connection terminated") ||
    msg.includes("failed query")
  );
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientDbError(err) || i === attempts - 1) throw err;
      await sleep(50 * Math.pow(2, i));
    }
  }
  throw lastErr;
}

function retryingStore(store: Store): Store {
  return {
    getChannel: (id) => withRetry(() => store.getChannel(id)),
    upsertChannel: (ch) => withRetry(() => store.upsertChannel(ch)),
    listChannels: () => withRetry(() => store.listChannels()),
    listEnabledChannels: () => withRetry(() => store.listEnabledChannels()),
    upsertMessage: (msg) => withRetry(() => store.upsertMessage(msg)),
    deleteMessage: (channelId, slackTs) => withRetry(() => store.deleteMessage(channelId, slackTs)),
    getMessages: (channelId, limit, offset) => withRetry(() => store.getMessages(channelId, limit, offset)),
    addSubscription: (subscriberChannelId, sourceChannelId) => withRetry(() => store.addSubscription(subscriberChannelId, sourceChannelId)),
    removeSubscription: (subscriberChannelId, sourceChannelId) => withRetry(() => store.removeSubscription(subscriberChannelId, sourceChannelId)),
    getSubscribersBySource: (sourceChannelId) => withRetry(() => store.getSubscribersBySource(sourceChannelId)),
    getSubscriptionsBySubscriber: (subscriberChannelId) => withRetry(() => store.getSubscriptionsBySubscriber(subscriberChannelId)),
    getRecentMessages: (channelId, since) => withRetry(() => store.getRecentMessages(channelId, since)),
    addBotAction: (action) => withRetry(() => store.addBotAction(action)),
    getBotActionsBySource: (sourceChannelId, sourceMessageTs) => withRetry(() => store.getBotActionsBySource(sourceChannelId, sourceMessageTs)),
    close: () => store.close(),
  };
}

async function runDdlOnce(databaseUrl: string) {
  if (ddlRan.has(databaseUrl)) return;
  ddlRan.add(databaseUrl);
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(databaseUrl);
  const stmts = [
    sql`CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', team_id TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 0, link_mode INTEGER NOT NULL DEFAULT 0, webhook_url TEXT NOT NULL DEFAULT '', auto_approve_users TEXT NOT NULL DEFAULT '', approved_posters TEXT NOT NULL DEFAULT '', track_replies INTEGER NOT NULL DEFAULT 0, metadata_schema TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (now() at time zone 'utc'))`,
    sql`CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, slack_ts TEXT NOT NULL, channel_id TEXT NOT NULL, user_id TEXT NOT NULL DEFAULT '', user_name TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', thread_ts TEXT, timestamp TEXT NOT NULL, metadata JSONB NOT NULL DEFAULT '{}')`,
    sql`CREATE TABLE IF NOT EXISTS subscriptions (id SERIAL PRIMARY KEY, subscriber_channel_id TEXT NOT NULL, source_channel_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (now() at time zone 'utc'))`,
    sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_channel_ts ON messages(channel_id, slack_ts)`,
    sql`CREATE INDEX IF NOT EXISTS idx_messages_channel_ts ON messages(channel_id, timestamp DESC)`,
    sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_subscriptions ON subscriptions(subscriber_channel_id, source_channel_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_subscriptions_source ON subscriptions(source_channel_id)`,
    sql`ALTER TABLE channels ADD COLUMN IF NOT EXISTS link_mode INTEGER NOT NULL DEFAULT 0`,
    sql`ALTER TABLE channels ADD COLUMN IF NOT EXISTS auto_approve_users TEXT NOT NULL DEFAULT ''`,
    sql`ALTER TABLE channels ADD COLUMN IF NOT EXISTS approved_posters TEXT NOT NULL DEFAULT ''`,
    sql`ALTER TABLE channels ADD COLUMN IF NOT EXISTS track_replies INTEGER NOT NULL DEFAULT 0`,
    sql`ALTER TABLE channels ADD COLUMN IF NOT EXISTS metadata_schema TEXT NOT NULL DEFAULT ''`,
    sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_ts TEXT`,
  ];
  for (const stmt of stmts) { try { await stmt; } catch {} }
}

async function getStore(databaseUrl: string): Promise<Store> {
  const cached = storeCache.get(databaseUrl);
  if (cached) return cached;

  const isNeon = databaseUrl.includes("neon.tech") || databaseUrl.includes("neondb");

  if (!isNeon) {
    const { pushSchema } = await import("./db/migrate");
    await pushSchema(databaseUrl);
  }

  let store: Store;
  if (isNeon) {
    const { NeonStore } = await import("./store/neon");
    store = new NeonStore(databaseUrl);
  } else {
    const { PostgresStore } = await import("./store/pg");
    store = new PostgresStore(databaseUrl);
  }
  store = retryingStore(store);
  storeCache.set(databaseUrl, store);
  if (isNeon) runDdlOnce(databaseUrl).catch(() => {});
  return store;
}

export default app;
