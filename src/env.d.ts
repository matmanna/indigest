// Generated via wrangler types, then manually maintained.
// Keep in sync with wrangler.jsonc bindings.

interface Env {
  // Bindings (vars)
  BASE_URL: string;
  API_USERNAME: string;
  LOCKDOWN_USERS: string;
  HACK_CLUB_CDN_KEY: string;
  SLACK_CLIENT_ID: string;
  // Channels where only replies under an article card are tracked, and who
  // may post a card ("self" is indigest's own bot). See src/lib/threads.ts.
  COMMENT_CHANNELS?: string;
  COMMENT_CARD_BOTS?: string;

  // Hyperdrive binding
  HYPERDRIVE_BINDING: { connectionString: string };

  // Secrets
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  DATABASE_URL: string;
  API_PASSWORD: string;
  HACKCLUB_CLIENT_ID: string;
  HACKCLUB_CLIENT_SECRET: string;
}
