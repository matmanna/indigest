import { eq, sql, and, inArray } from "drizzle-orm";
import * as schema from "./schema";
import type { DB } from "./index";

// --- Types ---

export interface Channel {
  id: string;
  name: string;
  teamId: string;
  enabled: boolean;
  linkMode: boolean;
  webhookUrl: string;
  autoApproveUsers: string[];
  approvedPosters: string[];
  accessPermUsers: string[];
  trackReplies: boolean;
  metadataSchema: string;
  createdAt: string;
}

export interface Message {
  id?: number;
  slackTs: string;
  channelId: string;
  threadTs?: string;
  userId: string;
  userName: string;
  text: string;
  timestamp: string;
  metadata: any;
}

export interface Subscription {
  id?: number;
  subscriberChannelId: string;
  sourceChannelId: string;
  createdAt: string;
}

export interface BotAction {
  id?: number;
  type: string;
  sourceChannelId: string;
  sourceMessageTs: string;
  botChannelId: string;
  botMessageTs: string;
  createdAt: string;
}

// --- Helpers ---

function toBool(v: unknown): boolean {
  return v === "1" || v === "true";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToChannel(r: any): Channel {
  return {
    id: r.id,
    name: r.name,
    teamId: r.teamId,
    enabled: toBool(r.enabled),
    linkMode: toBool(r.linkMode),
    webhookUrl: r.webhookUrl,
    autoApproveUsers: r.autoApproveUsers
      ? r.autoApproveUsers.split(",").filter(Boolean)
      : [],
    approvedPosters: r.approvedPosters
      ? r.approvedPosters.split(",").filter(Boolean)
      : [],
    accessPermUsers: r.accessPermUsers
      ? r.accessPermUsers.split(",").filter(Boolean)
      : ["*"],
    trackReplies: toBool(r.trackReplies),
    metadataSchema: r.metadataSchema,
    createdAt: r.createdAt,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToMessage(r: any): Message {
  return {
    id: r.id,
    slackTs: r.slackTs,
    channelId: r.channelId,
    threadTs: r.threadTs || undefined,
    userId: r.userId,
    userName: r.userName,
    text: r.text,
    timestamp: r.timestamp,
    metadata:
      typeof r.metadata === "string"
        ? r.metadata
        : JSON.stringify(r.metadata || {}),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToSubscription(r: any): Subscription {
  return {
    id: r.id,
    subscriberChannelId: r.subscriberChannelId,
    sourceChannelId: r.sourceChannelId,
    createdAt: r.createdAt,
  };
}

// --- Channel queries ---

export async function getChannel(
  db: DB,
  id: string,
): Promise<Channel | null> {
  const rows = await db
    .select()
    .from(schema.channels)
    .where(eq(schema.channels.id, id))
    .limit(1);
  if (rows.length === 0) return null;
  return rowToChannel(rows[0]!);
}

export async function upsertChannel(db: DB, ch: Channel): Promise<void> {
  await db
    .insert(schema.channels)
    .values({
      id: ch.id,
      name: ch.name,
      teamId: ch.teamId,
      enabled: ch.enabled ? "1" : "0",
      linkMode: ch.linkMode ? "1" : "0",
      webhookUrl: ch.webhookUrl,
      autoApproveUsers: ch.autoApproveUsers.join(","),
      approvedPosters: ch.approvedPosters.join(","),
      accessPermUsers: ch.accessPermUsers.join(","),
      trackReplies: ch.trackReplies ? "1" : "0",
      metadataSchema: ch.metadataSchema,
      createdAt: sql`COALESCE(NULLIF((SELECT created_at FROM channels WHERE id = ${ch.id}), ''), to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`,
    })
    .onConflictDoUpdate({
      target: schema.channels.id,
      set: {
        name: ch.name,
        teamId: ch.teamId,
        enabled: ch.enabled ? "1" : "0",
        linkMode: ch.linkMode ? "1" : "0",
        webhookUrl: ch.webhookUrl,
        autoApproveUsers: ch.autoApproveUsers.join(","),
        approvedPosters: ch.approvedPosters.join(","),
        accessPermUsers: ch.accessPermUsers.join(","),
        trackReplies: ch.trackReplies ? "1" : "0",
        metadataSchema: ch.metadataSchema,
      },
    });
}

export async function listChannels(db: DB): Promise<Channel[]> {
  const rows = await db.select().from(schema.channels);
  return rows.map(rowToChannel);
}

export async function listEnabledChannels(db: DB): Promise<Channel[]> {
  const rows = await db
    .select()
    .from(schema.channels)
    .where(eq(schema.channels.enabled, "1"));
  return rows.map(rowToChannel);
}

// --- Message queries ---

export async function upsertMessage(db: DB, msg: Message): Promise<void> {
  await db
    .insert(schema.messages)
    .values({
      slackTs: msg.slackTs,
      channelId: msg.channelId,
      userId: msg.userId,
      userName: msg.userName,
      text: msg.text,
      threadTs: msg.threadTs || null,
      timestamp: msg.timestamp,
      metadata:
        typeof msg.metadata === "string"
          ? msg.metadata
          : JSON.stringify(msg.metadata || {}),
    })
    .onConflictDoUpdate({
      target: [schema.messages.channelId, schema.messages.slackTs],
      set: {
        userId: msg.userId,
        userName: msg.userName,
        text: msg.text,
        threadTs: msg.threadTs || null,
        timestamp: msg.timestamp,
        metadata:
          typeof msg.metadata === "string"
            ? msg.metadata
            : JSON.stringify(msg.metadata || {}),
      },
    });
}

export async function deleteMessage(
  db: DB,
  channelId: string,
  slackTs: string,
): Promise<void> {
  await db
    .delete(schema.messages)
    .where(
      and(
        eq(schema.messages.channelId, channelId),
        eq(schema.messages.slackTs, slackTs),
      ),
    );
}

export async function getMessages(
  db: DB,
  channelId: string,
  opts: {
    limit?: number;
    offset?: number;
    after?: string;
    before?: string;
    userId?: string;
    threadTs?: string;
  } = {},
): Promise<Message[]> {
  const { limit: rawLimit = 50, offset = 0, after, before, userId, threadTs } = opts;
  const limit = Math.min(rawLimit, 200);

  const conditions = [eq(schema.messages.channelId, channelId)];
  if (after) conditions.push(sql`${schema.messages.timestamp} >= ${after}`);
  if (before) conditions.push(sql`${schema.messages.timestamp} <= ${before}`);
  if (userId) conditions.push(eq(schema.messages.userId, userId));
  if (threadTs) conditions.push(eq(schema.messages.threadTs, threadTs));

  const rows = await db
    .select()
    .from(schema.messages)
    .where(and(...conditions))
    .orderBy(sql`timestamp DESC`)
    .limit(limit)
    .offset(offset);
  return rows.map(rowToMessage);
}

export async function getMessageCount(
  db: DB,
  channelId: string,
  opts: {
    after?: string;
    before?: string;
    userId?: string;
    threadTs?: string;
  } = {},
): Promise<number> {
  const { after, before, userId, threadTs } = opts;

  const conditions = [eq(schema.messages.channelId, channelId)];
  if (after) conditions.push(sql`${schema.messages.timestamp} >= ${after}`);
  if (before) conditions.push(sql`${schema.messages.timestamp} <= ${before}`);
  if (userId) conditions.push(eq(schema.messages.userId, userId));
  if (threadTs) conditions.push(eq(schema.messages.threadTs, threadTs));

  const [result] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.messages)
    .where(and(...conditions));
  return Number(result?.count ?? 0);
}

export async function getMessageBySlackTs(
  db: DB,
  channelId: string,
  slackTs: string,
): Promise<Message | null> {
  const rows = await db
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.channelId, channelId),
        eq(schema.messages.slackTs, slackTs),
      ),
    )
    .limit(1);
  if (rows.length === 0) return null;
  return rowToMessage(rows[0]!);
}

export async function getRecentMessages(
  db: DB,
  channelId: string,
  since: Date,
): Promise<Message[]> {
  const sinceStr = since.toISOString();
  const rows = await db
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.channelId, channelId),
        sql`${schema.messages.timestamp} >= ${sinceStr}`,
      ),
    )
    .orderBy(sql`${schema.messages.timestamp} DESC`);
  return rows.map(rowToMessage);
}

// --- Subscription queries ---

export async function addSubscription(
  db: DB,
  subscriberChannelId: string,
  sourceChannelId: string,
): Promise<void> {
  await db
    .insert(schema.subscriptions)
    .values({
      subscriberChannelId,
      sourceChannelId,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing();
}

export async function removeSubscription(
  db: DB,
  subscriberChannelId: string,
  sourceChannelId: string,
): Promise<void> {
  await db
    .delete(schema.subscriptions)
    .where(
      and(
        eq(schema.subscriptions.subscriberChannelId, subscriberChannelId),
        eq(schema.subscriptions.sourceChannelId, sourceChannelId),
      ),
    );
}

export async function getSubscribersBySource(
  db: DB,
  sourceChannelId: string,
): Promise<Subscription[]> {
  const rows = await db
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.sourceChannelId, sourceChannelId));
  return rows.map(rowToSubscription);
}

export async function getSubscriptionsBySubscriber(
  db: DB,
  subscriberChannelId: string,
): Promise<Subscription[]> {
  const rows = await db
    .select()
    .from(schema.subscriptions)
    .where(
      eq(schema.subscriptions.subscriberChannelId, subscriberChannelId),
    );
  return rows.map(rowToSubscription);
}

// --- Bot action queries ---

export async function addBotAction(
  db: DB,
  action: BotAction,
): Promise<void> {
  await db.insert(schema.botActions).values({
    type: action.type,
    sourceChannelId: action.sourceChannelId,
    sourceMessageTs: action.sourceMessageTs,
    botChannelId: action.botChannelId,
    botMessageTs: action.botMessageTs,
    createdAt: new Date().toISOString(),
  });
}

export async function getBotActionsBySource(
  db: DB,
  sourceChannelId: string,
  sourceMessageTs: string,
): Promise<BotAction[]> {
  const rows = await db
    .select()
    .from(schema.botActions)
    .where(
      and(
        eq(schema.botActions.sourceChannelId, sourceChannelId),
        eq(schema.botActions.sourceMessageTs, sourceMessageTs),
      ),
    );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return rows.map((r: any) => ({
    id: r.id,
    type: r.type,
    sourceChannelId: r.sourceChannelId,
    sourceMessageTs: r.sourceMessageTs,
    botChannelId: r.botChannelId,
    botMessageTs: r.botMessageTs,
    createdAt: r.createdAt,
  }));
}

// --- Graph data ---

export async function getGraphData(db: DB): Promise<{
  channels: Channel[];
  subscriptions: Subscription[];
  subscriberChannels: Channel[];
}> {
  const [channelRows, subscriptionRows] = await Promise.all([
    db
      .select()
      .from(schema.channels)
      .where(eq(schema.channels.enabled, "1")),
    db.select().from(schema.subscriptions),
  ]);

  const channels = channelRows.map(rowToChannel);
  const channelIds = new Set(channels.map((c: Channel) => c.id));
  const subscriberChannelIds = [
    ...new Set(
      subscriptionRows
        .map((r: any) => r.subscriberChannelId as string)
        .filter((id: string) => !channelIds.has(id)),
    ),
  ];

  let subscriberChannels: Channel[] = [];
  if (subscriberChannelIds.length > 0) {
    const subRows = await db
      .select()
      .from(schema.channels)
      .where(inArray(schema.channels.id, subscriberChannelIds as string[]));
    subscriberChannels = subRows.map(rowToChannel);
  }

  const subscriptions = subscriptionRows.map(rowToSubscription);
  return { channels, subscriptions, subscriberChannels };
}
