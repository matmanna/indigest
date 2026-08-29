<table border="0">
  <tr>
    <td rowspan="2"><img width="84" height="84" alt="image" src="https://github.com/user-attachments/assets/eaec6187-0389-4e87-814a-7820af5ad761" />
</td>
    <td>indigest</td>
  </tr>
  <tr>
    <td>a Slack bot that curates messages into digestible RSS feeds & APIs while enabling cross-channel message forwarding via pub-sub style commands
</td>
  </tr>
</table>

## how does this work?

1. the bot is added to any channel
2. a channel manager or bot admin runs `/in pub`
3. messages get approved manually by posters ('yep'/'nope' buttons) or automatically (auto-approve) for high-trust channels
4. approved messages are served via RSS/JSON/Webhooks
5. if configured, extra metadata can be set through a Slack form modal
6. managers of other channels can run `/in sub` to receive forwarded copies of approved messages

<details><summary>wait, but how does it do that?</summary>

<ul>
  <li>ts</li><li>bun</li><li>hono</li><li>cf workers</li><li>postgres (hosted on hc infra / orchard)</li><li>oRPC</li><li>drizzle orm</li><li>zod</li><li>better auth</li><li>various slack sdks</li><li>vite</li><li>react (planning to switch to svelte or preact at some point)</li><li>react flow</li>

  </ul>

</details>

## map of the network

see a node graph mapping the channels currently using indigest in Hack Club at <https://indigest.matmanna.dev>

<img width="2077" height="1484" alt="image" src="https://github.com/user-attachments/assets/a163a355-5095-4ba9-9031-b3001349abda" />

## how do i use this?

_tldr: if you forget what to do, run `/in`_

<img width="630" height="440" alt="image" src="https://github.com/user-attachments/assets/019ff40d-a2b9-4d00-9ddc-6ebf296e082f" />

> [!NOTE]
> auto-publish will soon only be available to whitelisted "trusted" channels

| command                  | description                                                          |
| ------------------------ | -------------------------------------------------------------------- |
| `/in`                    | Show help message with all commands                                  |
| `/in pub`                | Enable manual mode (buttons on every message)                        |
| `/in pub auto`           | Enable auto-approve for **all users**                                |
| `/in pub auto @user`     | Enable auto-approve for a specific user                              |
| `/in pub manual`         | Explicitly enable manual mode (clears auto-approve)                  |
| `/in unpub`              | Disable indigest for a channel                                       |
| `/in unpub auto [@user]` | Remove auto-approve for a user (or all users)                        |
| `/in sub #channel`       | Subscribe this channel to receive forwarded messages from `#channel` |
| `/in unsub #channel`     | Unsubscribe this channel from `#channel`                             |
| `/in status`             | Show pub status, feed URLs, subscriptions, and permissions           |
| `/in webhook <url>`      | Set webhook URL for approved messages                                |
| `/in webhook clear`      | Remove webhook                                                       |
| `/in auto list`          | List auto-approve users                                              |
| `/in schema set <json>`  | Set metadata schema (see below)                                      |
| `/in schema get`         | View current metadata schema                                         |
| `/in schema clear`       | Remove metadata schema                                               |
| `/in schema required on\|off` | Require metadata before forwarding messages                         |

## publishing

**manual, per-message, opt-in publishing:**

<img width="916" height="205" alt="image" src="https://github.com/user-attachments/assets/d36b3cd8-5329-464f-abe7-f0795c1c779f" />

**permission structure:**

- **channel manager** - can run all commands unless lockdown mode enabled
- **lockdown override** - listed in `LOCKDOWN_USERS`, can always run all commands
- **channel member** - can only view `status` and public feed URLs

<img width="712" height="329" alt="image" src="https://github.com/user-attachments/assets/d4c21942-2e7a-48ad-8044-1683f8841728" />

## subscriptions

if channel A subscrbies to channel B, when a message is approved in channel B, it is automatically forwarded to channel A as a new Slack message  (either posted as a forward or with the original author's name, message, and profile picture.

> [!NOTE]
> exceptions to publishing: messages that are empty, contain only a link, or are `@here`/`@channel` pings (when recent substantive content exists) are not forwarded.

## setting metadata

channel managers can define a metadata form that opens in a **modal** when someone clicks **Yep!** on a message in manual mode.

<img width="804" height="685" alt="image" src="https://github.com/user-attachments/assets/10c2d72f-85b7-43f2-b5bb-ed222c6e25c1" />

```
/in schema set {"title":"Message Metadata","fields":[
  {"action_id":"title","label":"Title","type":"plain_text_input","placeholder":"Enter a title"},
  {"action_id":"description","label":"Description","type":"plain_text_input","multiline":true},
  {"action_id":"priority","label":"Priority","type":"static_select","options":[{"label":"Low","value":"low"},{"label":"High","value":"high"}]},
  {"action_id":"due_date","label":"Due Date","type":"datepicker"}
]}
```

**metadata field types:**

| Type                  | Notes                                                                            |
| --------------------- | -------------------------------------------------------------------------------- |
| `plain_text_input`    | Supports `multiline`, `min_length`, `max_length`, `placeholder`, `initial_value` |
| `url_text_input`      | URL validation built in                                                          |
| `email_text_input`    | Email validation built in                                                        |
| `number_input`        | Integer only                                                                     |
| `static_select`       | Single select, requires `options` array with `{label, value}`                    |
| `multi_static_select` | Multi-select, requires `options` array                                           |
| `datepicker`          | Date picker                                                                      |
| `file_input`          | File upload (uploaded to Hack Club CDN if key is set)                            |

## webhooks

when a message is approved, fires `POST` to the webhook URL:

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
    "metadata": { "title": "My Title", "priority": "high" }
  }
}
```

## feeds

- **RSS**: `https://your-host/feed/{channel_id}`
- **JSON**: `https://your-host/feed/{channel_id}.json?limit=50&offset=0`

query parameters: `limit` (max 200, default 50), `offset` (default 0).

## REST API

interactive API docs can be found at [https://indigest.matmanna.dev/docs](https://indigest.matmanna.dev/docs).

## development

use either docker or wrangler dev

```bash
# Drizzle Studio (browse DB)
docker compose run app bun run db:studio

# Cloudflare Worker
npx wrangler dev        # local dev
npx wrangler deploy     # deploy to Cloudflare
```

## deploy

```bash
npx wrangler login
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put DATABASE_URL
npx wrangler deploy
```

## env vars

see .env.example

## horizons ai use

while blindly vibecoding was avoided, post-initial planning and feature abstraction, ai agents (eg opencode) were used significantly especially for prototyping features, implementing tests, performing database tasks.
