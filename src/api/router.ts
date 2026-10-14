import { channelRouter } from "./routers/channels";
import { messageRouter } from "./routers/messages";
import { subscriptionRouter } from "./routers/subscriptions";
import { apiKeyRouter } from "./routers/apiKeys";
import { slackRouter } from "./routers/slack";
import { adminRouter } from "./routers/admin";

export const router = {
  channels: channelRouter,
  messages: messageRouter,
  subscriptions: subscriptionRouter,
  apiKeys: apiKeyRouter,
  slack: slackRouter,
  admin: adminRouter,
};

export type AppRouter = typeof router;
