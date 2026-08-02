export interface StoreChannel {
  id: string;
  name: string;
  teamId: string;
  enabled: boolean;
  linkMode: boolean;
  webhookUrl: string;
  autoApproveUsers: string[];
  approvedPosters: string[];
  trackReplies: boolean;
  metadataSchema: string;
  createdAt: string;
}

export interface StoreMessage {
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

export interface StoreSubscription {
  id?: number;
  subscriberChannelId: string;
  sourceChannelId: string;
  createdAt: string;
}

export interface StoreBotAction {
  id?: number;
  type: string;
  sourceChannelId: string;
  sourceMessageTs: string;
  botChannelId: string;
  botMessageTs: string;
  createdAt: string;
}

export interface Store {
  getChannel(id: string): Promise<StoreChannel | null>;
  upsertChannel(ch: StoreChannel): Promise<void>;
  listChannels(): Promise<StoreChannel[]>;
  listEnabledChannels(): Promise<StoreChannel[]>;
  upsertMessage(msg: StoreMessage): Promise<void>;
  deleteMessage(channelId: string, slackTs: string): Promise<void>;
  getMessages(channelId: string, limit?: number, offset?: number): Promise<StoreMessage[]>;
  addSubscription(subscriberChannelId: string, sourceChannelId: string): Promise<void>;
  removeSubscription(subscriberChannelId: string, sourceChannelId: string): Promise<void>;
  getSubscribersBySource(sourceChannelId: string): Promise<StoreSubscription[]>;
  getSubscriptionsBySubscriber(subscriberChannelId: string): Promise<StoreSubscription[]>;
  getRecentMessages(channelId: string, since: Date): Promise<StoreMessage[]>;
  addBotAction(action: StoreBotAction): Promise<void>;
  getBotActionsBySource(sourceChannelId: string, sourceMessageTs: string): Promise<StoreBotAction[]>;
  close(): void;
}
