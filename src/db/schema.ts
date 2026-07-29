import { pgTable, text, integer, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";

export const channels = pgTable("channels", {
  id: text("id").primaryKey(),
  name: text("name").notNull().default(""),
  teamId: text("team_id").notNull().default(""),
  enabled: integer("enabled").notNull().default(0),
  webhookUrl: text("webhook_url").notNull().default(""),
  autoApproveUsers: text("auto_approve_users").notNull().default(""),
  approvedPosters: text("approved_posters").notNull().default(""),
  trackReplies: integer("track_replies").notNull().default(0),
  metadataSchema: text("metadata_schema").notNull().default(""),
  createdAt: text("created_at").notNull().default("now()"),
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
    metadata: jsonb("metadata").notNull().default("{}"),
  },
  (t) => ({
    uniqueMsg: uniqueIndex("uq_messages_channel_ts").on(t.channelId, t.slackTs),
    channelTsIdx: index("idx_messages_channel_ts").on(t.channelId, t.timestamp.desc()),
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
    uniqueSub: uniqueIndex("uq_subscriptions").on(t.subscriberChannelId, t.sourceChannelId),
    sourceIdx: index("idx_subscriptions_source").on(t.sourceChannelId),
  }),
);
