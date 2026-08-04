import Markdown from "react-markdown";
import { createRoot } from "react-dom/client";
import remarkGfm from "remark-gfm";
import "./lockdown";
import { renderNavbar } from "./navbar";

renderNavbar("usage");

const markdown = `# Slack Bot Usage

Slash commands for managing indigest channels. Run these in Slack like:

\`\`\`
/in <command>
\`\`\`

## Channel Management

- \`/in pub\` — Enable indigest for this channel. New messages get a Yep!/No prompt.
- \`/in pub #channel\` — Enable for a specific channel.
- \`/in pub link\` — Toggle link mode: approved messages get an unfurlable permalink reply, and subscriber channels get a “Forwarded from …” footer with an unfurlable link. (\`/in pub link off\` disables.)
- \`/in unpub\` — Disable indigest for this channel.
- \`/in unpub #channel\` — Disable for a specific channel.

## Auto-Approve

- \`/in pub auto\` — Auto-approve all users' messages in this channel.
- \`/in pub auto @user\` — Auto-approve for a specific user.
- \`/in unpub auto\` — Disable auto-approve for all users.
- \`/in unpub auto @user\` — Disable auto-approve for a specific user.
- \`/in auto list\` — List users with auto-approve.

## Manual Mode

- \`/in pub manual\` — Every message gets a manual Yep!/No prompt.

## Thread Replies

- \`/in pub replies\` — Track thread replies and store reply relationships.

## Subscriptions

- \`/in sub #channel\` — Subscribe this channel to receive messages from #channel.
- \`/in unsub #channel\` — Unsubscribe from a channel.

## Webhooks

- \`/in webhook <url>\` — Set a webhook URL for new messages.
- \`/in webhook clear\` — Remove the webhook.

## Poster Permissions

- \`/in perms @user1 @user2\` — Restrict approvals to these specific users.
- \`/in perms poster\` — Let each message's author approve their own.
- \`/in perms @user1 poster\` — Combine specific users + poster mode.
- \`/in perms get\` — View current poster permissions.
- \`/in perms clear\` — Restore defaults (poster + managers only).

## Metadata Schema

- \`/in schema set <json>\` — Set a metadata schema for the channel.
- \`/in schema get\` — View the current schema.
- \`/in schema clear\` — Remove the schema.

## Backfill Shortcut

If you want to add an older message to the feed without waiting for the Yep!/No prompt:

- In Slack, open the message “More actions” menu (\`...\`) and run the indigest **message shortcut** (a “message action”).
- The bot posts a thread reply: “✅ Message backfilled and added to the feed!”

## Status

- \`/in status\` — Show channel status, feeds, and permissions.`;

createRoot(document.getElementById("app")!).render(
  <div className="markdown-body">
    <Markdown remarkPlugins={[remarkGfm]}>{markdown}</Markdown>
  </div>,
);
