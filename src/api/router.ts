import { channelRouter } from "./routers/channels";
import { messageRouter } from "./routers/messages";
import { subscriptionRouter } from "./routers/subscriptions";
import { apiKeyRouter } from "./routers/apiKeys";

export const router = {
  channels: channelRouter,
  messages: messageRouter,
  subscriptions: subscriptionRouter,
  apiKeys: apiKeyRouter,
};

export type AppRouter = typeof router;
