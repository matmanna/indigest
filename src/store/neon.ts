import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { Store, StoreChannel, StoreMessage, StoreSubscription } from "./store";

function rows(result: any): any[] {
  return Array.isArray(result) ? result : result?.rows || [];
}

export class NeonStore implements Store {
  private sql: NeonQueryFunction<false, false>;

  constructor(connectionString: string) {
    this.sql = neon(connectionString);
  }

  async getChannel(id: string): Promise<StoreChannel | null> {
    const r = rows(await this.sql`SELECT * FROM channels WHERE id = ${id} LIMIT 1`)[0];
    if (!r) return null;
    return {
      id: r.id,
      name: r.name,
      teamId: r.team_id,
      enabled: Boolean(r.enabled),
      linkMode: Boolean(r.link_mode),
      webhookUrl: r.webhook_url,
      autoApproveUsers: r.auto_approve_users ? r.auto_approve_users.split(",").filter(Boolean) : [],
      approvedPosters: r.approved_posters ? r.approved_posters.split(",").filter(Boolean) : [],
      trackReplies: Boolean(r.track_replies),
      metadataSchema: r.metadata_schema,
      createdAt: r.created_at,
    };
  }

  async upsertChannel(ch: StoreChannel): Promise<void> {
    await this.sql`INSERT INTO channels (id, name, team_id, enabled, link_mode, webhook_url, auto_approve_users, approved_posters, track_replies, metadata_schema, created_at)
      VALUES (${ch.id}, ${ch.name}, ${ch.teamId}, ${ch.enabled ? 1 : 0}, ${ch.linkMode ? 1 : 0}, ${ch.webhookUrl}, ${ch.autoApproveUsers.join(",")}, ${ch.approvedPosters.join(",")}, ${ch.trackReplies ? 1 : 0}, ${ch.metadataSchema}, ${new Date().toISOString()})
      ON CONFLICT (id) DO UPDATE SET name = ${ch.name}, team_id = ${ch.teamId}, enabled = ${ch.enabled ? 1 : 0}, link_mode = ${ch.linkMode ? 1 : 0}, webhook_url = ${ch.webhookUrl}, auto_approve_users = ${ch.autoApproveUsers.join(",")}, approved_posters = ${ch.approvedPosters.join(",")}, track_replies = ${ch.trackReplies ? 1 : 0}, metadata_schema = ${ch.metadataSchema}`;
  }

  async listChannels(): Promise<StoreChannel[]> {
    return rows(await this.sql`SELECT * FROM channels`).map((r) => ({
      id: r.id,
      name: r.name,
      teamId: r.team_id,
      enabled: Boolean(r.enabled),
      linkMode: Boolean(r.link_mode),
      webhookUrl: r.webhook_url,
      autoApproveUsers: r.auto_approve_users ? r.auto_approve_users.split(",").filter(Boolean) : [],
      approvedPosters: r.approved_posters ? r.approved_posters.split(",").filter(Boolean) : [],
      trackReplies: Boolean(r.track_replies),
      metadataSchema: r.metadata_schema,
      createdAt: r.created_at,
    }));
  }

  async listEnabledChannels(): Promise<StoreChannel[]> {
    return rows(await this.sql`SELECT * FROM channels WHERE enabled = 1`).map((r) => ({
      id: r.id,
      name: r.name,
      teamId: r.team_id,
      enabled: true,
      linkMode: Boolean(r.link_mode),
      webhookUrl: r.webhook_url,
      autoApproveUsers: r.auto_approve_users ? r.auto_approve_users.split(",").filter(Boolean) : [],
      approvedPosters: r.approved_posters ? r.approved_posters.split(",").filter(Boolean) : [],
      trackReplies: Boolean(r.track_replies),
      metadataSchema: r.metadata_schema,
      createdAt: r.created_at,
    }));
  }

  async upsertMessage(msg: StoreMessage): Promise<void> {
    const metadataStr = typeof msg.metadata === "string" ? msg.metadata : JSON.stringify(msg.metadata || {});
    await this.sql`INSERT INTO messages (slack_ts, channel_id, user_id, user_name, text, thread_ts, timestamp, metadata)
      VALUES (${msg.slackTs}, ${msg.channelId}, ${msg.userId}, ${msg.userName}, ${msg.text}, ${msg.threadTs || null}, ${msg.timestamp}, ${metadataStr}::jsonb)
      ON CONFLICT (channel_id, slack_ts) DO UPDATE SET user_id = ${msg.userId}, user_name = ${msg.userName}, text = ${msg.text}, thread_ts = ${msg.threadTs || null}, timestamp = ${msg.timestamp}, metadata = ${metadataStr}::jsonb`;
  }

  async deleteMessage(channelId: string, slackTs: string): Promise<void> {
    await this.sql`DELETE FROM messages WHERE channel_id = ${channelId} AND slack_ts = ${slackTs}`;
  }

  async getMessages(channelId: string, limit = 50, offset = 0): Promise<StoreMessage[]> {
    if (limit > 200) limit = 200;
    return rows(await this.sql`SELECT * FROM messages WHERE channel_id = ${channelId} ORDER BY timestamp DESC LIMIT ${limit} OFFSET ${offset}`).map((r) => ({
      id: r.id,
      slackTs: r.slack_ts,
      channelId: r.channel_id,
      threadTs: r.thread_ts || undefined,
      userId: r.user_id,
      userName: r.user_name,
      text: r.text,
      timestamp: r.timestamp,
      metadata: typeof r.metadata === "string" ? r.metadata : JSON.stringify(r.metadata || {}),
    }));
  }

  close(): void {}

  async addSubscription(subscriberChannelId: string, sourceChannelId: string): Promise<void> {
    await this.sql`INSERT INTO subscriptions (subscriber_channel_id, source_channel_id, created_at)
      VALUES (${subscriberChannelId}, ${sourceChannelId}, ${new Date().toISOString()})
      ON CONFLICT (subscriber_channel_id, source_channel_id) DO NOTHING`;
  }

  async removeSubscription(subscriberChannelId: string, sourceChannelId: string): Promise<void> {
    await this.sql`DELETE FROM subscriptions WHERE subscriber_channel_id = ${subscriberChannelId} AND source_channel_id = ${sourceChannelId}`;
  }

  async getSubscribersBySource(sourceChannelId: string): Promise<StoreSubscription[]> {
    return rows(await this.sql`SELECT * FROM subscriptions WHERE source_channel_id = ${sourceChannelId}`).map((r) => ({
      id: r.id,
      subscriberChannelId: r.subscriber_channel_id,
      sourceChannelId: r.source_channel_id,
      createdAt: r.created_at,
    }));
  }

  async getSubscriptionsBySubscriber(subscriberChannelId: string): Promise<StoreSubscription[]> {
    return rows(await this.sql`SELECT * FROM subscriptions WHERE subscriber_channel_id = ${subscriberChannelId}`).map((r) => ({
      id: r.id,
      subscriberChannelId: r.subscriber_channel_id,
      sourceChannelId: r.source_channel_id,
      createdAt: r.created_at,
    }));
  }

  async getRecentMessages(channelId: string, since: Date): Promise<StoreMessage[]> {
    const sinceStr = since.toISOString();
    return rows(await this.sql`SELECT * FROM messages WHERE channel_id = ${channelId} AND timestamp >= ${sinceStr} ORDER BY timestamp DESC`).map((r) => ({
      id: r.id,
      slackTs: r.slack_ts,
      channelId: r.channel_id,
      threadTs: r.thread_ts || undefined,
      userId: r.user_id,
      userName: r.user_name,
      text: r.text,
      timestamp: r.timestamp,
      metadata: typeof r.metadata === "string" ? r.metadata : JSON.stringify(r.metadata || {}),
    }));
  }
}
