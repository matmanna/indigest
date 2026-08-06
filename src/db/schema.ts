import {
  pgTable,
  text,
  integer,
  jsonb,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const channels = pgTable("channels", {
  id: text("id").primaryKey(),
  name: text("name").notNull().default(""),
  teamId: text("team_id").notNull().default(""),
  enabled: text("enabled").notNull().default("0"),
  linkMode: text("link_mode").notNull().default("0"),
  webhookUrl: text("webhook_url").notNull().default(""),
  autoApproveUsers: text("auto_approve_users").notNull().default(""),
  approvedPosters: text("approved_posters").notNull().default(""),
  trackReplies: text("track_replies").notNull().default("0"),
  metadataSchema: text("metadata_schema").notNull().default(""),
  createdAt: text("created_at").notNull().default(""),
  accessPermUsers: text("access_perm_users").notNull().default("*"),
});

export const messages = pgTable(
  "messages",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    slackTs: text("slack_ts").notNull(),
    channelId: text("channel_id").notNull(),
    userId: text("user_id").notNull().default(""),
    userName: text("user_name").notNull().default(""),
    text: text("text").notNull().default(""),
    threadTs: text("thread_ts"),
    timestamp: text("timestamp").notNull(),
    metadata: text("metadata").notNull().default("{}"),
  },
  (t) => ({
    uniqueMsg: uniqueIndex("uq_messages_channel_ts").on(t.channelId, t.slackTs),
    channelTsIdx: index("idx_messages_channel_ts").on(
      t.channelId,
      t.timestamp.desc(),
    ),
  }),
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    subscriberChannelId: text("subscriber_channel_id").notNull(),
    sourceChannelId: text("source_channel_id").notNull(),
    createdAt: text("created_at").notNull().default("now()"),
  },
  (t) => ({
    uniqueSub: uniqueIndex("uq_subscriptions").on(
      t.subscriberChannelId,
      t.sourceChannelId,
    ),
    sourceIdx: index("idx_subscriptions_source").on(t.sourceChannelId),
  }),
);

export const botActions = pgTable(
  "bot_actions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    type: text("type").notNull(),
    sourceChannelId: text("source_channel_id").notNull(),
    sourceMessageTs: text("source_message_ts").notNull(),
    botChannelId: text("bot_channel_id").notNull(),
    botMessageTs: text("bot_message_ts").notNull(),
    createdAt: text("created_at").notNull().default("now()"),
  },
  (t) => ({
    sourceIdx: index("idx_bot_actions_source").on(
      t.sourceChannelId,
      t.sourceMessageTs,
    ),
  }),
);

export const apiKeys = pgTable("api_keys", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  owner: text("created_by_slack_id").references(() => authUser.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  revokedBy: text("revoked_by_slack_id").references(() => authUser.id),
  keyPrefix: text("key_prefix").notNull().unique(),
  secretHash: text("secret_hash").notNull(),
  lastUsedAt: timestamp("last_used_at"),
  // expiresAt: timestamp("expires_at", { mode: "date" }),
});

export const apiKeyChannels = pgTable("api_key_channels", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  keyId: integer("key_id").references(() => apiKeys.id),
  channelId: text("channel_id").references(() => channels.id),
});

// --- Better Auth tables ---

export const authUser = pgTable("auth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  slackId: text("slack_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const authSession = pgTable(
  "auth_session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
  },
  (t) => [index("auth_session_userId_idx").on(t.userId)],
);

export const authAccount = pgTable(
  "auth_account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index("auth_account_userId_idx").on(t.userId)],
);

export const authVerification = pgTable(
  "auth_verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index("auth_verification_identifier_idx").on(t.identifier)],
);

export const authUserRelations = relations(authUser, ({ many }) => ({
  sessions: many(authSession),
  accounts: many(authAccount),
}));

export const authSessionRelations = relations(authSession, ({ one }) => ({
  user: one(authUser, {
    fields: [authSession.userId],
    references: [authUser.id],
  }),
}));

export const authAccountRelations = relations(authAccount, ({ one }) => ({
  user: one(authUser, {
    fields: [authAccount.userId],
    references: [authUser.id],
  }),
}));
