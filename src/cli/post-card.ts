/**
 * Post an article card to a channel as indigest's own bot, and store it so its
 * replies are the article's comments. For testing comments without the
 * Slacker News bot.
 *
 * Usage:
 *   bun run card <channel id> <article url> [--setup] [--dry-run]
 *
 * The card's title, blurb and image come from the page's Open Graph tags.
 * --setup also turns reply tracking on for the channel (the same as
 * `/in pub trigger shortcut` and `/in pub replies`): ambient messages are not
 * published, replies are tracked. Needs SLACK_BOT_TOKEN and DATABASE_URL.
 * The channel also has to be listed in COMMENT_CHANNELS for only card replies
 * to be kept.
 */
import { WebClient } from "@slack/web-api";
import { getDb } from "../db";
import * as q from "../db/queries";
import { resolveSlackMrkdwn } from "../app";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const [channelId, articleUrl] = args;

if (!channelId || !articleUrl || !/^[CG][A-Z0-9]+$/.test(channelId)) {
  console.error("usage: bun run card <channel id> <article url> [--setup] [--dry-run]");
  process.exit(1);
}

const decode = (value: string) =>
  value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

function meta(html: string, property: string): string | undefined {
  const tag = html.match(
    new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]*>`, "i"),
  )?.[0];
  const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
  return content ? decode(content) : undefined;
}

const page = await fetch(articleUrl, { redirect: "follow" });
if (!page.ok) {
  console.error(`could not fetch ${articleUrl}: ${page.status}`);
  process.exit(1);
}
const html = await page.text();
const title =
  meta(html, "og:title") ?? decode(html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? "") ?? articleUrl;
const description = meta(html, "og:description") ?? "";
const image = meta(html, "og:image");

const link = new URL(articleUrl);
link.searchParams.set("ref", "slack-bot");
const cut = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit - 3).trimEnd()}...` : text;

const payload = {
  channel: channelId,
  // The article's link is in the text, so the card is found by it.
  text: `${title}\n> ${cut(description, 200)}\n<${articleUrl}>`,
  blocks: [
    { type: "section", text: { type: "mrkdwn", text: cut(title, 150) } },
    {
      type: "card",
      title: { type: "mrkdwn", text: `<${link.toString()}|${cut(title, 120)}>` },
      ...(image
        ? { hero_image: { type: "image", image_url: image, alt_text: `'${title}' social preview` } }
        : {}),
      body: { type: "plain_text", text: cut(description, 200) || title },
    },
  ],
  unfurl_links: false,
  unfurl_media: false,
};

if (flags.has("--dry-run")) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const db = getDb(process.env.DATABASE_URL!);

if (flags.has("--setup")) {
  const existing = await q.getChannel(db, channelId);
  await q.upsertChannel(db, {
    id: channelId,
    name: existing?.name ?? "",
    teamId: existing?.teamId ?? "",
    linkMode: false,
    webhookUrl: existing?.webhookUrl ?? "",
    autoApproveUsers: existing?.autoApproveUsers ?? [],
    manualUsers: existing?.manualUsers ?? [],
    approvedPosters: existing?.approvedPosters ?? [],
    accessPermUsers: existing?.accessPermUsers ?? ["*"],
    metadataSchema: existing?.metadataSchema ?? "",
    metadataRequired: existing?.metadataRequired ?? false,
    properties: existing?.properties ?? "",
    createdAt: existing?.createdAt ?? "",
    enabled: true,
    trackReplies: true,
    triggerMode: "shortcut",
  });
  console.log(`reply tracking on for ${channelId}`);
}

const posted = await slack.chat.postMessage(payload as any);
if (!posted.ok || !posted.ts) {
  console.error("post failed:", posted.error);
  process.exit(1);
}

const auth = await slack.auth.test();
await q.upsertMessage(db, {
  slackTs: posted.ts,
  channelId,
  userId: auth.user_id ?? "",
  userName: "indigest",
  text: resolveSlackMrkdwn(payload.text),
  formattedText: null,
  timestamp: new Date(Number(posted.ts.split(".")[0]) * 1000).toISOString(),
  metadata: {},
});
console.log(JSON.stringify({ ok: true, channel: channelId, ts: posted.ts, article: articleUrl }));
process.exit(0);
