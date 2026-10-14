import { z } from "zod";
import { ORPCError } from "@orpc/server";
import {
  publicProcedure,
  authRequiredProcedure,
  assertCanManageChannel,
  auditAction,
} from "../context";
import {
  getChannel as dbGetChannel,
  listChannels as dbListChannels,
  getSubscribersBySource as dbGetSubscribersBySource,
  getSubscriptionsBySubscriber as dbGetSubscriptionsBySubscriber,
  listAllSubscriptions as dbListAllSubscriptions,
  addSubscription as dbAddSubscription,
  removeSubscription as dbRemoveSubscription,
  updateSubscriptionOverrides as dbUpdateSubscriptionOverrides,
} from "../../db/queries";
import { invalidateGraphCache } from "../../lib/graph-cache";
import { auditActions, diff } from "../../lib/audit";

const pairSchema = z.object({
  subscriberChannelId: z.string().min(1),
  sourceChannelId: z.string().min(1),
});

// A static value, or a `[property]` resolved against the source channel.
const overrideSchema = z.string().trim().max(512).nullable();

export const listSubscriptions = publicProcedure
  .route({ method: "GET", path: "/subscriptions" })
  .input(z.object({ sourceChannelId: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    return dbGetSubscribersBySource(context.db, input.sourceChannelId);
  });

export const listSubscriptionsBySubscriber = publicProcedure
  .route({ method: "GET", path: "/subscriptions/by-subscriber" })
  .input(z.object({ subscriberChannelId: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    return dbGetSubscriptionsBySubscriber(
      context.db,
      input.subscriberChannelId,
    );
  });

/** Every subscription, with both channels' names for display. */
export const listAllSubscriptions = publicProcedure
  .route({ method: "GET", path: "/subscriptions/all" })
  .handler(async ({ context }) => {
    const [subs, channels] = await Promise.all([
      dbListAllSubscriptions(context.db),
      dbListChannels(context.db),
    ]);
    const names = new Map(channels.map((ch) => [ch.id, ch.name]));
    return subs.map((s) => ({
      ...s,
      sourceName: names.get(s.sourceChannelId) || "",
      subscriberName: names.get(s.subscriberChannelId) || "",
    }));
  });

export const addSubscription = authRequiredProcedure
  .route({ method: "POST", path: "/subscriptions" })
  .input(pairSchema)
  .handler(async ({ input, context }) => {
    if (input.subscriberChannelId === input.sourceChannelId)
      throw new ORPCError("BAD_REQUEST", {
        message: "A channel can't subscribe to itself",
      });
    const source = await dbGetChannel(context.db, input.sourceChannelId);
    if (!source)
      throw new ORPCError("NOT_FOUND", {
        message: `Source channel ${input.sourceChannelId} not found`,
      });
    if (!source.enabled)
      throw new ORPCError("PRECONDITION_FAILED", {
        message: `#${source.name || source.id} must be pub'd before other channels can subscribe to it`,
      });
    const sub = await dbGetChannel(context.db, input.subscriberChannelId);
    if (!sub)
      throw new ORPCError("NOT_FOUND", {
        message: `Subscriber channel ${input.subscriberChannelId} not found`,
      });

    await assertCanManageChannel(
      context,
      input.subscriberChannelId,
      context.session.user.slackId,
      auditActions.subscriptionAdd,
    );

    await dbAddSubscription(
      context.db,
      input.subscriberChannelId,
      input.sourceChannelId,
    );
    invalidateGraphCache();
    await auditAction(
      context,
      auditActions.subscriptionAdd,
      {
        target: { id: input.subscriberChannelId, sourceChannelId: source.id },
      },
      { targetName: sub.name, sourceName: source.name },
    );
  });

export const updateSubscription = authRequiredProcedure
  .route({ method: "PATCH", path: "/subscriptions" })
  .input(
    pairSchema.extend({
      profileName: overrideSchema.optional(),
      profileImageUrl: overrideSchema.optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    await assertCanManageChannel(
      context,
      input.subscriberChannelId,
      context.session.user.slackId,
      auditActions.subscriptionUpdate,
    );
    const existing = await dbGetSubscriptionsBySubscriber(
      context.db,
      input.subscriberChannelId,
    );
    const current = existing.find(
      (s) => s.sourceChannelId === input.sourceChannelId,
    );
    if (!current)
      throw new ORPCError("NOT_FOUND", { message: "Subscription not found" });
    // Blank clears the override, same as `/in sub name #src clear`.
    const blankToNull = (v: string | null | undefined) =>
      v === undefined ? undefined : v ? v : null;
    const overrides = {
      profileName: blankToNull(input.profileName),
      profileImageUrl: blankToNull(input.profileImageUrl),
    };
    await dbUpdateSubscriptionOverrides(
      context.db,
      input.subscriberChannelId,
      input.sourceChannelId,
      overrides,
    );
    await auditAction(context, auditActions.subscriptionUpdate, {
      target: {
        id: input.subscriberChannelId,
        sourceChannelId: input.sourceChannelId,
      },
      changes: diff(
        {
          profileName: current.profileName ?? null,
          profileImageUrl: current.profileImageUrl ?? null,
        },
        // Only fields left out of the request keep their old value; a
        // cleared field (null) must show up as cleared.
        {
          profileName:
            overrides.profileName === undefined
              ? (current.profileName ?? null)
              : overrides.profileName,
          profileImageUrl:
            overrides.profileImageUrl === undefined
              ? (current.profileImageUrl ?? null)
              : overrides.profileImageUrl,
        },
      ),
    });
    return { ok: true };
  });

export const removeSubscription = authRequiredProcedure
  .route({ method: "DELETE", path: "/subscriptions" })
  .input(pairSchema)
  .handler(async ({ input, context }) => {
    await assertCanManageChannel(
      context,
      input.subscriberChannelId,
      context.session.user.slackId,
      auditActions.subscriptionRemove,
    );

    await dbRemoveSubscription(
      context.db,
      input.subscriberChannelId,
      input.sourceChannelId,
    );
    invalidateGraphCache();
    await auditAction(context, auditActions.subscriptionRemove, {
      target: {
        id: input.subscriberChannelId,
        sourceChannelId: input.sourceChannelId,
      },
    });
  });

export const subscriptionRouter = {
  list: listSubscriptions,
  listBySubscriber: listSubscriptionsBySubscriber,
  listAll: listAllSubscriptions,
  add: addSubscription,
  update: updateSubscription,
  remove: removeSubscription,
};
