import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { publicProcedure, authOrApiKeyProcedure, authRequiredProcedure } from "../context";

export const listSubscriptions = publicProcedure
  .route({ method: "GET", path: "/subscriptions" })
  .input(z.object({ sourceChannelId: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    return context.store.getSubscribersBySource(input.sourceChannelId);
  });

export const listSubscriptionsBySubscriber = publicProcedure
  .route({ method: "GET", path: "/subscriptions/by-subscriber" })
  .input(z.object({ subscriberChannelId: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    return context.store.getSubscriptionsBySubscriber(input.subscriberChannelId);
  });

export const addSubscription = authRequiredProcedure
  .route({ method: "POST", path: "/subscriptions" })
  .input(
    z.object({
      subscriberChannelId: z.string().min(1),
      sourceChannelId: z.string().min(1),
    }),
  )
  .handler(async ({ input, context }) => {
    const source = await context.store.getChannel(input.sourceChannelId);
    if (!source) throw new ORPCError("NOT_FOUND", { message: `Source channel ${input.sourceChannelId} not found` });
    const sub = await context.store.getChannel(input.subscriberChannelId);
    if (!sub) throw new ORPCError("NOT_FOUND", { message: `Subscriber channel ${input.subscriberChannelId} not found` });
    await context.store.addSubscription(input.subscriberChannelId, input.sourceChannelId);
  });

export const removeSubscription = authRequiredProcedure
  .route({ method: "DELETE", path: "/subscriptions" })
  .input(
    z.object({
      subscriberChannelId: z.string().min(1),
      sourceChannelId: z.string().min(1),
    }),
  )
  .handler(async ({ input, context }) => {
    await context.store.removeSubscription(input.subscriberChannelId, input.sourceChannelId);
  });

export const subscriptionRouter = {
  list: listSubscriptions,
  listBySubscriber: listSubscriptionsBySubscriber,
  add: addSubscription,
  remove: removeSubscription,
};
