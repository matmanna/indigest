import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, sql, and } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Store, StoreChannel, StoreMessage, StoreSubscription } from "./store";

export class PostgresStore implements Store {
  private db: ReturnType<typeof drizzle>;
  private client: ReturnType<typeof postgres>;

  constructor(connectionString: string) {
    this.client = postgres(connectionString, { prepare: false });
    this.db = drizzle(this.client, { schema });
  }

  async getChannel(id: string): Promise<StoreChannel | null> {
    const rows = await this.db.select().from(schema.channels).where(eq(schema.channels.id, id)).limit(1);
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return { id: r.id, name: r.name, teamId: r.teamId, enabled: Boolean(r.enabled), linkMode: Boolean(r.linkMode), webhookUrl: r.webhookUrl, autoApproveUsers: r.autoApproveUsers ? r.autoApproveUsers.split(",").filter(Boolean) : [], approvedPosters: r.approvedPosters ? r.approvedPosters.split(",").filter(Boolean) : [], trackReplies: Boolean(r.trackReplies), metadataSchema: r.metadataSchema, createdAt: r.createdAt };
  }

  async upsertChannel(ch: StoreChannel): Promise<void> {
    await this.db
      .insert(schema.channels)
      .values({
        id: ch.id,
        name: ch.name,
        teamId: ch.teamId,
        enabled: ch.enabled ? 1 : 0,
        linkMode: ch.linkMode ? 1 : 0,
        webhookUrl: ch.webhookUrl,
        autoApproveUsers: ch.autoApproveUsers.join(","),
        approvedPosters: ch.approvedPosters.join(","),
        trackReplies: ch.trackReplies ? 1 : 0,
        metadataSchema: ch.metadataSchema,
        createdAt: sql`COALESCE((SELECT created_at FROM channels WHERE id = ${ch.id}), now()::text)`,
      })
      .onConflictDoUpdate({
        target: schema.channels.id,
        set: {
          name: ch.name,
          teamId: ch.teamId,
          enabled: ch.enabled ? 1 : 0,
          linkMode: ch.linkMode ? 1 : 0,
          webhookUrl: ch.webhookUrl,
          autoApproveUsers: ch.autoApproveUsers.join(","),
          approvedPosters: ch.approvedPosters.join(","),
          trackReplies: ch.trackReplies ? 1 : 0,
          metadataSchema: ch.metadataSchema,
        },
      });
  }

  async listChannels(): Promise<StoreChannel[]> {
    const rows = await this.db.select().from(schema.channels);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      teamId: r.teamId,
      enabled: Boolean(r.enabled),
      linkMode: Boolean(r.linkMode),
      webhookUrl: r.webhookUrl,
      autoApproveUsers: r.autoApproveUsers ? r.autoApproveUsers.split(",").filter(Boolean) : [],
      approvedPosters: r.approvedPosters ? r.approvedPosters.split(",").filter(Boolean) : [],
      trackReplies: Boolean(r.trackReplies),
      metadataSchema: r.metadataSchema,
      createdAt: r.createdAt,
    }));
  }

  async listEnabledChannels(): Promise<StoreChannel[]> {
    const rows = await this.db.select().from(schema.channels).where(eq(schema.channels.enabled, 1));
    return rows.map((r) => ({ id: r.id, name: r.name, teamId: r.teamId, enabled: true, linkMode: Boolean(r.linkMode), webhookUrl: r.webhookUrl, autoApproveUsers: r.autoApproveUsers ? r.autoApproveUsers.split(",").filter(Boolean) : [], approvedPosters: r.approvedPosters ? r.approvedPosters.split(",").filter(Boolean) : [], trackReplies: Boolean(r.trackReplies), metadataSchema: r.metadataSchema, createdAt: r.createdAt }));
  }

  async upsertMessage(msg: StoreMessage): Promise<void> {
    await this.db
      .insert(schema.messages)
      .values({
        slackTs: msg.slackTs,
        channelId: msg.channelId,
        userId: msg.userId,
        userName: msg.userName,
        text: msg.text,
        threadTs: msg.threadTs || null,
        timestamp: msg.timestamp,
        metadata: typeof msg.metadata === "string" ? msg.metadata : JSON.stringify(msg.metadata || {}),
      })
      .onConflictDoUpdate({
        target: [schema.messages.channelId, schema.messages.slackTs],
        set: {
          userId: msg.userId,
          userName: msg.userName,
          text: msg.text,
          threadTs: msg.threadTs || null,
          timestamp: msg.timestamp,
          metadata: typeof msg.metadata === "string" ? msg.metadata : JSON.stringify(msg.metadata || {}),
        },
      });
  }

  async deleteMessage(channelId: string, slackTs: string): Promise<void> {
    await this.db.delete(schema.messages).where(and(eq(schema.messages.channelId, channelId), eq(schema.messages.slackTs, slackTs)));
  }

  async getMessages(channelId: string, limit = 50, offset = 0): Promise<StoreMessage[]> {
    if (limit > 200) limit = 200;
    const rows = await this.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.channelId, channelId))
      .orderBy(sql`timestamp DESC`)
      .limit(limit)
      .offset(offset);
    return rows.map((r) => ({
      id: r.id,
      slackTs: r.slackTs,
      channelId: r.channelId,
      threadTs: r.threadTs || undefined,
      userId: r.userId,
      userName: r.userName,
      text: r.text,
      timestamp: r.timestamp,
      metadata: typeof r.metadata === "string" ? r.metadata : JSON.stringify(r.metadata || {}),
    }));
  }

  close(): void {
    this.client.end();
  }

  async addSubscription(subscriberChannelId: string, sourceChannelId: string): Promise<void> {
    await this.db
      .insert(schema.subscriptions)
      .values({ subscriberChannelId, sourceChannelId, createdAt: new Date().toISOString() })
      .onConflictDoNothing();
  }

  async removeSubscription(subscriberChannelId: string, sourceChannelId: string): Promise<void> {
    await this.db
      .delete(schema.subscriptions)
      .where(
        and(
          eq(schema.subscriptions.subscriberChannelId, subscriberChannelId),
          eq(schema.subscriptions.sourceChannelId, sourceChannelId)
        )
      );
  }

  async getSubscribersBySource(sourceChannelId: string): Promise<StoreSubscription[]> {
    const rows = await this.db
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.sourceChannelId, sourceChannelId));
    return rows.map((r) => ({
      id: r.id,
      subscriberChannelId: r.subscriberChannelId,
      sourceChannelId: r.sourceChannelId,
      createdAt: r.createdAt,
    }));
  }

  async getSubscriptionsBySubscriber(subscriberChannelId: string): Promise<StoreSubscription[]> {
    const rows = await this.db
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.subscriberChannelId, subscriberChannelId));
    return rows.map((r) => ({
      id: r.id,
      subscriberChannelId: r.subscriberChannelId,
      sourceChannelId: r.sourceChannelId,
      createdAt: r.createdAt,
    }));
  }

  async getRecentMessages(channelId: string, since: Date): Promise<StoreMessage[]> {
    const sinceStr = since.toISOString();
    const rows = await this.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.channelId, channelId) && sql`${schema.messages.timestamp} >= ${sinceStr}`)
      .orderBy(sql`${schema.messages.timestamp} DESC`);
    return rows.map((r) => ({
      id: r.id,
      slackTs: r.slackTs,
      channelId: r.channelId,
      threadTs: r.threadTs || undefined,
      userId: r.userId,
      userName: r.userName,
      text: r.text,
      timestamp: r.timestamp,
      metadata: typeof r.metadata === "string" ? r.metadata : JSON.stringify(r.metadata || {}),
    }));
  }
}
