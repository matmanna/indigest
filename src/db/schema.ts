import {
  pgTable,
  text,
  integer,
  jsonb,
  boolean,
  timestamp,
  uniqueIndex,
  index,
  type AnyPgColumn,
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
  manualUsers: text("manual_users").notNull().default(""),
  triggerMode: text("trigger_mode").notNull().default("message"),
  approvedPosters: text("approved_posters").notNull().default(""),
  trackReplies: text("track_replies").notNull().default("0"),
  metadataSchema: text("metadata_schema").notNull().default(""),
  metadataRequired: text("metadata_required").notNull().default("0"),
  properties: text("properties").notNull().default("{}"),
  // Static mrkdwn shown in bold above every forward, e.g. "New Edition of
  // Happenings!". Meant for auto-pub channels, which never see the metadata modal.
  staticMetadata: text("static_metadata").notNull().default(""),
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
    // The same text as Slack mrkdwn, formatting kept. Null for messages
    // stored before it existed.
    formattedText: text("formatted_text"),
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
    profileName: text("profile_name"),
    profileImageUrl: text("profile_image_url"),
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
    userId: text("user_id"),
    command: text("command"),
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
  revokedAt: timestamp("revoked_at"),
  // Delegation: a key with canDelegate may mint child keys whose channel scope
  // is a subset of its own. Children act with the parent's access, record the
  // end user they were issued to in subject, and die with the parent.
  canDelegate: boolean("can_delegate").default(false).notNull(),
  parentId: integer("parent_id").references((): AnyPgColumn => apiKeys.id),
  subject: text("subject"),
  // expiresAt: timestamp("expires_at", { mode: "date" }),
});

export const apiKeyChannels = pgTable("api_key_channels", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  keyId: integer("key_id").references(() => apiKeys.id),
  channelId: text("channel_id").references(() => channels.id),
});

// Append-only audit trail of config and auth changes. Each row's hash covers
// the previous row's hash, so editing or deleting a row breaks the chain.
export const auditLog = pgTable(
  "audit_log",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    action: text("action").notNull(),
    outcome: text("outcome").notNull(),
    severity: text("severity").notNull().default("low"),
    source: text("source").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    actorName: text("actor_name"),
    actorSlackId: text("actor_slack_id"),
    targetType: text("target_type"),
    targetId: text("target_id"),
    targetName: text("target_name"),
    reason: text("reason"),
    changes: jsonb("changes"),
    context: jsonb("context"),
    prevHash: text("prev_hash"),
    hash: text("hash").notNull(),
  },
  (t) => ({
    createdIdx: index("idx_audit_log_created").on(t.createdAt.desc()),
    targetIdx: index("idx_audit_log_target").on(t.targetType, t.targetId),
    actionIdx: index("idx_audit_log_action").on(t.action),
  }),
);

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
