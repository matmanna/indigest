import { z } from "zod";
import { WebClient } from "@slack/web-api";
import { authRequiredProcedure } from "../context";
import { listChannels as dbListChannels } from "../../db/queries";

export interface SlackUserSummary {
  id: string;
  name: string;
  image: string | null;
}

const CACHET_URL = "https://cachet.hackclub.com";

/** Look a user up in Cachet, Hack Club's Slack profile cache. */
async function fromCachet(id: string): Promise<SlackUserSummary | null> {
  try {
    const res = await fetch(`${CACHET_URL}/users/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const u = (await res.json()) as {
      displayName?: string;
      realName?: string;
      imageUrl?: string;
    };
    return {
      id,
      name: u.displayName || u.realName || id,
      image: u.imageUrl || null,
    };
  } catch {
    return null;
  }
}

async function fromSlack(slack: WebClient | null, id: string): Promise<SlackUserSummary> {
  if (!slack) return { id, name: id, image: null };
  try {
    const res = await slack.users.info({ user: id });
    const u = res.user as any;
    return {
      id,
      name: u?.profile?.display_name || u?.real_name || u?.name || id,
      image: u?.profile?.image_48 || null,
    };
  } catch {
    return { id, name: id, image: null };
  }
}

/**
 * Display names and avatars for Slack user IDs shown in the dashboard.
 * Cachet first (cached, no Slack rate limits), Slack's API as a fallback.
 */
export const resolveUsers = authRequiredProcedure
  .route({ method: "GET", path: "/slack/users" })
  .input(
    z.object({
      ids: z
        .string()
        .transform((s) => s.split(",").map((id) => id.trim()).filter(Boolean))
        .pipe(z.array(z.string().regex(/^[UW][A-Z0-9]+$/)).max(50)),
    }),
  )
  .handler(async ({ input, context }): Promise<SlackUserSummary[]> => {
    const slack = context.slackToken ? new WebClient(context.slackToken) : null;
    return Promise.all(
      [...new Set(input.ids)].map(
        async (id) => (await fromCachet(id)) ?? fromSlack(slack, id),
      ),
    );
  });

/** Channels the bot is in that indigest hasn't pub'd yet. */
export const listJoinableChannels = authRequiredProcedure
  .route({ method: "GET", path: "/slack/channels" })
  .handler(async ({ context }) => {
    if (!context.slackToken) return [];
    const slack = new WebClient(context.slackToken);
    const known = new Map(
      (await dbListChannels(context.db)).map((ch) => [ch.id, ch.enabled]),
    );
    const found: { id: string; name: string; isPrivate: boolean }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await slack.users.conversations({
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      for (const c of (res.channels as any[]) || []) {
        if (known.get(c.id)) continue;
        found.push({ id: c.id, name: c.name, isPrivate: !!c.is_private });
      }
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    return found.sort((a, b) => a.name.localeCompare(b.name));
  });

export const slackRouter = {
  users: resolveUsers,
  channels: listJoinableChannels,
};
