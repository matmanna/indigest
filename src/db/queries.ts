import { eq, sql, and, inArray, isNull, or } from "drizzle-orm";
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
  manualUsers: string[];
  /** "message": react to every message per disposition. "shortcut": only publish via the message shortcut. */
  triggerMode: "message" | "shortcut";
  approvedPosters: string[];
  accessPermUsers: string[];
  trackReplies: boolean;
  metadataSchema: string;
  metadataRequired: boolean;
  properties: string;
  /** Static mrkdwn shown in bold above every forward. Empty means none. */
  staticMetadata: string;
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
  /** `text` as Slack mrkdwn, formatting kept. Absent on older messages. */
  formattedText?: string | null;
  /** Original Slack text, retained in memory for forwarding-policy checks. */
  rawText?: string;
  /** Original author when this Slack message is itself a forwarded message. */
  originalUserId?: string;
  originalUserName?: string;
  authorIds?: string[];
  authorNames?: string[];
  timestamp: string;
  metadata: any;
}

export interface Subscription {
  id?: number;
  subscriberChannelId: string;
  sourceChannelId: string;
  profileName?: string | null;
  profileImageUrl?: string | null;
  createdAt: string;
}

export interface BotAction {
  id?: number;
  type: string;
  sourceChannelId: string;
  sourceMessageTs: string;
  botChannelId: string;
  botMessageTs: string;
  userId?: string;
  command?: string;
  createdAt: string;
}

/**
 * What remains visible of a deleted message: enough to count it (a deleted
 * comment still uses up its author's allowance), and nothing of its content.
 * Keep this free of text, formattedText and metadata.
 */
export interface Tombstone {
  slackTs: string;
  channelId: string;
  threadTs?: string;
  userId: string;
  timestamp: string;
  deletedAt: Date;
}

// --- Helpers ---

/**
 * Every query that returns message content must include this condition. Deleted
 * rows keep their content in the database, so this filter is the only thing
 * keeping it from API consumers, feeds, webhooks and forwards.
 * tests/deleted-messages.test.ts fails if a read of the table lacks it.
 */
const notDeleted = isNull(schema.messages.deletedAt);

export function parseBool(v: unknown): boolean {
  return v === "1" || v === "true";
}

export const toBool = parseBool;

export function splitAuthorList(value: unknown): string[] {
  return typeof value === "string"
    ? value.split(",").map((item) => item.trim()).filter(Boolean)
    : [];
}

export function mergeAuthorLists(...values: unknown[]): string {
  const authors: string[] = [];
  for (const value of values) {
    for (const author of splitAuthorList(value)) {
      if (!authors.includes(author)) authors.push(author);
    }
  }
  return authors.join(",");
}

function authorFilter(column: any, userId: string) {
  return or(
    eq(column, userId),
    sql`(',' || ${column} || ',') LIKE ${`%,${userId},%`}`,
  )!;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToChannel(r: any): Channel {
  return {
    id: r.id,
    name: r.name,
    teamId: r.teamId,
    enabled: parseBool(r.enabled),
    linkMode: parseBool(r.linkMode),
    webhookUrl: r.webhookUrl,
    autoApproveUsers: r.autoApproveUsers
      ? r.autoApproveUsers.split(",").filter(Boolean)
      : [],
    manualUsers: r.manualUsers ? r.manualUsers.split(",").filter(Boolean) : [],
    triggerMode: r.triggerMode === "shortcut" ? "shortcut" : "message",
    approvedPosters: r.approvedPosters
      ? r.approvedPosters.split(",").filter(Boolean)
      : [],
    // An explicitly empty value means restricted, not public. Only a null
    // value (for legacy rows predating the column) gets the public default.
    accessPermUsers:
      r.accessPermUsers == null
        ? ["*"]
        : r.accessPermUsers.split(",").filter(Boolean),
    trackReplies: parseBool(r.trackReplies),
    metadataSchema: r.metadataSchema,
    metadataRequired: parseBool(r.metadataRequired),
    properties: r.properties || "{}",
    staticMetadata: r.staticMetadata || "",
    createdAt: r.createdAt,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToMessage(r: any): Message {
  // Fail closed: a query that forgot the notDeleted filter must not leak.
  if (r.deletedAt) {
    throw new Error("refusing to map a deleted message");
  }
  return {
    id: r.id,
    slackTs: r.slackTs,
    channelId: r.channelId,
    threadTs: r.threadTs || undefined,
    userId: r.userId,
    userName: r.userName,
    authorIds: splitAuthorList(r.userId),
    authorNames: splitAuthorList(r.userName),
    text: r.text,
    formattedText: r.formattedText ?? null,
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
    profileName: r.profileName ?? null,
    profileImageUrl: r.profileImageUrl ?? null,
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
      manualUsers: ch.manualUsers.join(","),
      triggerMode: ch.triggerMode,
      approvedPosters: ch.approvedPosters.join(","),
      accessPermUsers: ch.accessPermUsers.join(","),
      trackReplies: ch.trackReplies ? "1" : "0",
      metadataSchema: ch.metadataSchema,
      metadataRequired: ch.metadataRequired ? "1" : "0",
      properties: ch.properties,
      staticMetadata: ch.staticMetadata,
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
        manualUsers: ch.manualUsers.join(","),
        triggerMode: ch.triggerMode,
        approvedPosters: ch.approvedPosters.join(","),
        accessPermUsers: ch.accessPermUsers.join(","),
        trackReplies: ch.trackReplies ? "1" : "0",
        metadataSchema: ch.metadataSchema,
        metadataRequired: ch.metadataRequired ? "1" : "0",
        properties: ch.properties,
        staticMetadata: ch.staticMetadata,
      },
    });
}

export async function listChannels(db: DB): Promise<Channel[]> {
  const rows = await db.select().from(schema.channels);
  return rows.map(rowToChannel);
}

export async function updateChannelName(
  db: DB,
  channelId: string,
  name: string,
): Promise<void> {
  await db
    .update(schema.channels)
    .set({ name })
    .where(eq(schema.channels.id, channelId));
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
      userId: mergeAuthorLists(msg.userId, msg.originalUserId),
      userName: mergeAuthorLists(msg.userName, msg.originalUserName),
      text: msg.text,
      formattedText: msg.formattedText ?? null,
      threadTs: msg.threadTs || null,
      timestamp: msg.timestamp,
      metadata:
        typeof msg.metadata === "string"
          ? msg.metadata
          : JSON.stringify(msg.metadata || {}),
    })
    .onConflictDoUpdate({
      target: [schema.messages.channelId, schema.messages.slackTs],
      // A late event must not revive or rewrite a deleted message.
      setWhere: notDeleted,
      set: {
        userId: mergeAuthorLists(msg.userId, msg.originalUserId),
        userName: mergeAuthorLists(msg.userName, msg.originalUserName),
        text: msg.text,
        // Left alone when a caller has no formatted text to give.
        ...(msg.formattedText !== undefined
          ? { formattedText: msg.formattedText }
          : {}),
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

/**
 * Marks a stored message deleted, keeping its content. Returns whether it was
 * newly marked: false for an unknown message or one already deleted.
 */
export async function markMessageDeleted(
  db: DB,
  channelId: string,
  slackTs: string,
): Promise<boolean> {
  const rows = await db
    .update(schema.messages)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(schema.messages.channelId, channelId),
        eq(schema.messages.slackTs, slackTs),
        notDeleted,
      ),
    )
    .returning({ id: schema.messages.id });
  return rows.length > 0;
}

/**
 * Slack timestamps of the stored, not deleted messages in a thread: its
 * replies and its root.
 */
export async function getLiveThreadTimestamps(
  db: DB,
  channelId: string,
  threadTs: string,
): Promise<string[]> {
  const rows = await db
    .select({ slackTs: schema.messages.slackTs })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.channelId, channelId),
        or(
          eq(schema.messages.threadTs, threadTs),
          eq(schema.messages.slackTs, threadTs),
        ),
        notDeleted,
      ),
    );
  return rows.map((r) => r.slackTs);
}

/**
 * Deleted messages, without their content. Internal: for counting what a user
 * has posted. Never expose these through an API, feed or forward.
 */
export async function listTombstones(
  db: DB,
  channelId: string,
  opts: { userId?: string; threadTs?: string } = {},
): Promise<Tombstone[]> {
  const conditions = [
    eq(schema.messages.channelId, channelId),
    sql`${schema.messages.deletedAt} IS NOT NULL`,
  ];
  if (opts.userId) {
    conditions.push(authorFilter(schema.messages.userId, opts.userId));
  }
  if (opts.threadTs) {
    conditions.push(eq(schema.messages.threadTs, opts.threadTs));
  }

  const rows = await db
    .select({
      slackTs: schema.messages.slackTs,
      channelId: schema.messages.channelId,
      threadTs: schema.messages.threadTs,
      userId: schema.messages.userId,
      timestamp: schema.messages.timestamp,
      deletedAt: schema.messages.deletedAt,
    })
    .from(schema.messages)
    .where(and(...conditions))
    .orderBy(sql`timestamp ASC`);
  return rows.map((r) => ({
    slackTs: r.slackTs,
    channelId: r.channelId,
    threadTs: r.threadTs || undefined,
    userId: r.userId,
    timestamp: r.timestamp,
    deletedAt: r.deletedAt!,
  }));
}

/**
 * Top-level, not deleted messages in a channel whose text mentions `needle`,
 * newest first. The caller still has to check the match is exact: this is a
 * substring search.
 */
export async function findTopLevelMessagesContaining(
  db: DB,
  channelId: string,
  needle: string,
): Promise<Message[]> {
  const pattern = `%${needle.replace(/[\\%_]/g, "\\$&")}%`;
  const rows = await db
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.channelId, channelId),
        isNull(schema.messages.threadTs),
        notDeleted,
        or(
          sql`${schema.messages.text} LIKE ${pattern}`,
          sql`${schema.messages.formattedText} LIKE ${pattern}`,
        ),
      ),
    )
    .orderBy(sql`timestamp ASC`)
    .limit(50);
  return rows.map(rowToMessage);
}

/**
 * Every thread reply in a channel, deleted or not, without its content: just
 * who posted it and when. Internal, for working out comment allowances.
 */
export async function listReplyRecords(
  db: DB,
  channelId: string,
): Promise<{ slackTs: string; userId: string }[]> {
  const rows = await db
    .select({
      slackTs: schema.messages.slackTs,
      userId: schema.messages.userId,
    })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.channelId, channelId),
        sql`${schema.messages.threadTs} IS NOT NULL`,
      ),
    );
  return rows;
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

  const conditions = [eq(schema.messages.channelId, channelId), notDeleted];
  if (after) conditions.push(sql`${schema.messages.timestamp} >= ${after}`);
  if (before) conditions.push(sql`${schema.messages.timestamp} <= ${before}`);
  if (userId) conditions.push(authorFilter(schema.messages.userId, userId));
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

  const conditions = [eq(schema.messages.channelId, channelId), notDeleted];
  if (after) conditions.push(sql`${schema.messages.timestamp} >= ${after}`);
  if (before) conditions.push(sql`${schema.messages.timestamp} <= ${before}`);
  if (userId) conditions.push(authorFilter(schema.messages.userId, userId));
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
        notDeleted,
      ),
    )
    .limit(1);
  if (rows.length === 0) return null;
  return rowToMessage(rows[0]!);
}

/** Oldest stored message for a channel, by timestamp - the resume point for backfilling further back in history. */
export async function getOldestMessage(
  db: DB,
  channelId: string,
): Promise<Message | null> {
  const rows = await db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.channelId, channelId), notDeleted))
    .orderBy(sql`timestamp ASC`)
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
        notDeleted,
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

export async function updateSubscriptionOverrides(
  db: DB,
  subscriberChannelId: string,
  sourceChannelId: string,
  overrides: { profileName?: string | null; profileImageUrl?: string | null },
): Promise<void> {
  const set: Record<string, string | null> = {};
  if (overrides.profileName !== undefined) set.profileName = overrides.profileName;
  if (overrides.profileImageUrl !== undefined)
    set.profileImageUrl = overrides.profileImageUrl;
  if (Object.keys(set).length === 0) return;
  await db
    .update(schema.subscriptions)
    .set(set)
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

export async function listAllSubscriptions(db: DB): Promise<Subscription[]> {
  const rows = await db.select().from(schema.subscriptions);
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
    userId: action.userId,
    command: action.command,
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
    userId: r.userId || undefined,
    command: r.command || undefined,
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
