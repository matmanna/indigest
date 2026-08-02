<table border="0">
  <tr>
    <td rowspan="2"><img width="84" height="84" alt="image" src="https://github.com/user-attachments/assets/eaec6187-0389-4e87-814a-7820af5ad761" />
</td>
    <td>indigest</td>
  </tr>
  <tr>
    <td>A Slack bot & bridge that lets channel members opt individual messages into RSS feeds, a REST API, and webhooks. Can also forward messages between channels via pub/sub-style commands.
</td>
  </tr>
</table>

## How it works

1. The bot is added to any channel
2. A channel manager or bot admin runs `/in pub`
3. Messages get approved manually ('yep'/'nope' buttons) or automatically (auto-approve)
5. Approved messages are stored in PostgreSQL and served via RSS/JSON/Webhooks
4. If configured, extra metadata can be set through a Slack form modal
7. Managers of other channels can run `/in sub` to receive forwarded copies of approved messages

## Map of the network

See a node graph mapping the channels currently using Indigest in Hack Club at https://indigest.matmanna.dev

## Commands

All commands use the prefix `/in` (or `/indigest`). An optional `#channel` prefix on any command targets a different channel.

| Command | Description |
|---------|-------------|
| `/in` | Show help message with all commands |
| `/in pub` | Enable manual mode (buttons on every message) |
| `/in pub auto` | Enable auto-approve for **all users** |
| `/in pub auto @user` | Enable auto-approve for a specific user |
| `/in pub manual` | Explicitly enable manual mode (clears auto-approve) |
| `/in unpub` | Disable indigest for a channel |
| `/in unpub auto [@user]` | Remove auto-approve for a user (or all users) |
| `/in sub #channel` | Subscribe this channel to receive forwarded messages from `#channel` |
| `/in unsub #channel` | Unsubscribe this channel from `#channel` |
| `/in status` | Show pub status, feed URLs, subscriptions, and permissions |
| `/in webhook <url>` | Set webhook URL for approved messages |
| `/in webhook clear` | Remove webhook |
| `/in auto list` | List auto-approve users |
| `/in schema set <json>` | Set metadata schema (see below) |
| `/in schema get` | View current metadata schema |
| `/in schema clear` | Remove metadata schema |

## Permissions

- **channel manager** — can run all commands on channels they created
- **lockdown override** — listed in `LOCKDOWN_USERS`, can run all commands everywhere
- **none** — can only view `status` and feed URLs

`/in` alone (no subcommand) shows the full help message.

## Subscriptions

A **subscription** means channel A subscribes to channel B. When a message is approved in channel B, it is automatically forwarded to channel A as a new Slack message posted as the original author (with their name and profile picture).

**Forwarded messages include:**
- The original author's display name and avatar
- The message text
- A context footer with a permalink to the original message

**Filtering:** Messages that are empty, contain only a link, or are `@here`/`@channel` pings (when recent substantive content exists) are not forwarded.

## Metadata Schema

Channel creators can define a metadata form that opens in a **modal** when someone clicks **Yep!** on a message in manual mode.

```
/in schema set {"title":"Message Metadata","fields":[
  {"action_id":"title","label":"Title","type":"plain_text_input","placeholder":"Enter a title"},
  {"action_id":"description","label":"Description","type":"plain_text_input","multiline":true},
  {"action_id":"priority","label":"Priority","type":"static_select","options":[{"label":"Low","value":"low"},{"label":"High","value":"high"}]},
  {"action_id":"due_date","label":"Due Date","type":"datepicker"}
]}
```

**Supported field types:**

| Type | Notes |
|------|-------|
| `plain_text_input` | Supports `multiline`, `min_length`, `max_length`, `placeholder`, `initial_value` |
| `url_text_input` | URL validation built in |
| `email_text_input` | Email validation built in |
| `number_input` | Integer only |
| `static_select` | Single select, requires `options` array with `{label, value}` |
| `multi_static_select` | Multi-select, requires `options` array |
| `datepicker` | Date picker |
| `file_input` | File upload (uploaded to Hack Club CDN if key is set) |

Submitted metadata is stored as JSON in the `metadata` column, included in webhook payloads, and returned in the JSON API.

## Webhooks

When a message is approved, fires `POST` to the webhook URL:

```json
{
  "event": "message.approved",
  "channel": { "id": "C123", "name": "general" },
  "message": {
    "ts": "1234567890.123456",
    "user_id": "U456",
    "user_name": "alice",
    "text": "the message text",
    "timestamp": "2025-01-01T00:00:00.000Z",
    "metadata": {"title":"My Title","priority":"high"}
  }
}
```

## Feeds

- **RSS**: `https://your-host/feed/{channel_id}`
- **JSON**: `https://your-host/feed/{channel_id}.json?limit=50&offset=0`

Query parameters: `limit` (max 200, default 50), `offset` (default 0).

## REST API

All endpoints require Basic Auth using `API_USERNAME` / `API_PASSWORD`. If `API_PASSWORD` is empty, auth is disabled.

### List Messages

```
GET /api/messages?channel=<channel_id>&limit=50&page=1&after=2025-01-01T00:00:00Z&before=2026-01-01T00:00:00Z&userId=U12345
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `channel` | string | yes | Slack channel ID |
| `limit` | number | no | Results per page (1-10000, default 50) |
| `page` | number | no | Page number (default 1) |
| `after` | string | no | ISO 8601 timestamp — only messages after this time |
| `before` | string | no | ISO 8601 timestamp — only messages before this time |
| `userId` | string | no | Filter by Slack user ID |

**Response:**
```json
{
  "data": [
    {
      "id": 3,
      "slackTs": "1783464404.108959",
      "channelId": "C0ACWHCA16F",
      "userId": "U07VA44DNBA",
      "userName": "mat",
      "text": "hello world",
      "timestamp": "2026-07-07T22:46:44.000Z",
      "metadata": "{}"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 1,
    "total_pages": 1
  }
}
```

### Get Single Message

```
GET /api/messages/{slackTs}?channel=<channel_id>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `slackTs` | string | yes | Slack message timestamp (in path) |
| `channel` | string | yes | Slack channel ID (query param) |

**Response:**
```json
{
  "data": {
    "id": 3,
    "slackTs": "1783464404.108959",
    "channelId": "C0ACWHCA16F",
    "userId": "U07VA44DNBA",
    "userName": "mat",
    "text": "hello world",
    "timestamp": "2026-07-07T22:46:44.000Z",
    "metadata": "{}"
  }
}
```

### cURL Examples

```bash
# List messages with auth
curl -u admin:password 'https://your-host/api/messages?channel=C0ACWHCA16F&limit=10'

# Filter by time range
curl -u admin:password 'https://your-host/api/messages?channel=C0ACWHCA16F&after=2025-06-01T00:00:00Z'

# Get a specific message
curl -u admin:password 'https://your-host/api/messages/1783464404.108959?channel=C0ACWHCA16F'
```

## Architecture

### Store Backends

The app auto-detects which database backend to use based on `DATABASE_URL`:

- **Neon HTTP** (`DATABASE_URL` contains `neon.tech`) — stateless, no TCP connections. Used by the Cloudflare Worker.
- **Postgres TCP** (any other `DATABASE_URL`) — persistent connection pool. Used by Docker Compose.

Both implement the same `Store` interface and are fully interchangeable.

### Database Schema

**`channels`** — pub'd channel configuration (id, name, team_id, enabled, webhook_url, auto_approve_users, metadata_schema, created_at)

**`messages`** — approved messages (id, slack_ts, channel_id, user_id, user_name, text, timestamp, metadata)

**`subscriptions`** — channel-to-channel forwarding rules (subscriber_channel_id, source_channel_id, created_at)

Schema is bootstrapped automatically on first request.

## Development

```bash
# Local dev with Docker
docker compose up -d

# Drizzle Studio (browse DB)
docker compose run app bun run db:studio

# Cloudflare Worker
npx wrangler dev        # local dev
npx wrangler deploy     # deploy to Cloudflare
```


## Deploy

### Cloudflare Worker (production)

```bash
npx wrangler login
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put DATABASE_URL
npx wrangler deploy
```

The Worker auto-detects Neon Postgres from the `DATABASE_URL` and uses the HTTP-based store. Schema is bootstrapped on first request.

Update your Slack app's Event Subscriptions and Interactions URLs to point to the deployed Worker.

### Docker Compose (local dev)

```bash
docker compose up -d
```

Runs the app on `localhost:8080` with a local Postgres 17 instance. The store auto-detects a non-Neon `DATABASE_URL` and uses the TCP-based driver.

## Environment

### Secrets (set via `wrangler secret put` or `.env`)

| Variable | Description |
|---|---|
| `SLACK_BOT_TOKEN` | Slack bot user OAuth token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Slack request signing secret |
| `DATABASE_URL` | PostgreSQL connection string (Neon for Worker, local for Docker) |
| `API_PASSWORD` | Password for Basic Auth on `/api/*` routes (empty = auth disabled) |

### Vars (set in `wrangler.jsonc` or `.env`)

| Variable | Description | Default |
|---|---|---|
| `BASE_URL` | Public base URL for feed links in Slack responses | `http://localhost:8080` |
| `API_USERNAME` | Username for Basic Auth on `/api/*` routes | `admin` |
| `LOCKDOWN_USERS` | Comma-separated Slack user IDs that bypass permission checks | (empty) |
| `HACK_CLUB_CDN_KEY` | Hack Club CDN API key for `file_input` uploads | (empty) |

