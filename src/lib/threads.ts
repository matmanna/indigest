// Article threads: a bot posts a card for each article, and replies in the
// card's thread are the article's comments. The card is linked to its article
// by the article's URL in the card text; only the URL's path counts, so a card
// linking to a preview deploy or carrying ?ref=slack-bot maps to the same
// article as one linking to production.

/** "/news/some-slug/" from a URL or a path, or undefined if it is neither. */
export function normalizeArticleKey(value: string): string | undefined {
  let path = value.trim();
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      return undefined;
    }
  }
  path = path.split(/[?#]/)[0] ?? "";
  const segments = path.split("/").filter(Boolean);
  // An article is /<column>/<slug>/.
  if (segments.length !== 2) return undefined;
  return `/${segments.map((s) => s.toLowerCase()).join("/")}/`;
}

/** The article a card is about: the first link in its text with an article's shape. */
export function articleKeyFromCardText(
  ...texts: Array<string | null | undefined>
): string | undefined {
  for (const text of texts) {
    for (const match of text?.matchAll(/https?:\/\/[^\s<>|)]+/g) ?? []) {
      const key = normalizeArticleKey(match[0]);
      if (key) return key;
    }
  }
  return undefined;
}

export interface CommentLimits {
  /** Comments one user may post per calendar day in `timeZone`. */
  perDay: number;
  /** Comments one user may post, ever. */
  total: number;
  /** IANA zone whose midnight ends a day. */
  timeZone: string;
}

/** A reply, deleted or not, with nothing of what it said. */
export interface ReplyRecord {
  slackTs: string;
  userId: string;
}

function dayIn(timeZone: string, slackTs: string): string {
  const date = new Date(Number(slackTs.split(".")[0]) * 1000);
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(date);
}

/**
 * Which replies count as comments. Replies are walked oldest first for each
 * user, and one counts while the user is within both limits. A deleted reply
 * still uses up allowance, so deleting and reposting gains nothing, while a
 * reply over a limit does not use any, so it cannot lock the user out later.
 */
export function validCommentTimestamps(
  records: ReplyRecord[],
  limits: CommentLimits,
): Set<string> {
  const byUser = new Map<string, ReplyRecord[]>();
  for (const record of records) {
    // A reply's first author is its poster.
    const user = record.userId.split(",")[0] ?? record.userId;
    byUser.set(user, [...(byUser.get(user) ?? []), record]);
  }

  const valid = new Set<string>();
  for (const replies of byUser.values()) {
    replies.sort((a, b) => Number(a.slackTs) - Number(b.slackTs));
    let total = 0;
    const perDay = new Map<string, number>();
    for (const reply of replies) {
      const day = dayIn(limits.timeZone, reply.slackTs);
      const today = perDay.get(day) ?? 0;
      if (total >= limits.total || today >= limits.perDay) continue;
      total += 1;
      perDay.set(day, today + 1);
      valid.add(reply.slackTs);
    }
  }
  return valid;
}

export interface CommentUsage {
  used: number;
  total: number;
  usedToday: number;
  perDay: number;
}

/** What a user has used of their allowance, counting deleted comments. */
export function commentUsage(
  records: ReplyRecord[],
  userId: string,
  limits: CommentLimits,
  now: Date = new Date(),
): CommentUsage {
  const valid = validCommentTimestamps(records, limits);
  const today = dayIn(limits.timeZone, String(now.getTime() / 1000));
  const mine = records.filter(
    (r) => (r.userId.split(",")[0] ?? r.userId) === userId && valid.has(r.slackTs),
  );
  return {
    used: mine.length,
    total: limits.total,
    usedToday: mine.filter((r) => dayIn(limits.timeZone, r.slackTs) === today).length,
    perDay: limits.perDay,
  };
}

// --- Which replies are comments ---

export interface CommentConfig {
  /** Channels where only replies under an article card are tracked. */
  channels: Set<string>;
  /**
   * Who may post an article card: Slack user or bot IDs, and "self" for
   * indigest's own bot.
   */
  cardBots: string[];
}

export function parseCommentConfig(env: {
  COMMENT_CHANNELS?: string;
  COMMENT_CARD_BOTS?: string;
}): CommentConfig {
  const list = (value?: string) =>
    (value ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const cardBots = list(env.COMMENT_CARD_BOTS);
  return {
    channels: new Set(list(env.COMMENT_CHANNELS)),
    cardBots: cardBots.length > 0 ? cardBots : ["self"],
  };
}

/** Whether a message was posted by one of the allowed card authors. */
export function isCardAuthor(
  author: { user?: string; bot_id?: string },
  cardBots: string[],
  self: { userId?: string; botId?: string },
): boolean {
  const ids = [author.user, author.bot_id].filter((id): id is string => !!id);
  return ids.some(
    (id) =>
      cardBots.includes(id) ||
      (cardBots.includes("self") && (id === self.userId || id === self.botId)),
  );
}

/**
 * A card's text with the links from its blocks added. A card's link often
 * lives only in its blocks, not in its text, and the article is found by it.
 */
export function cardText(message: { text?: string; blocks?: unknown }): string {
  const text = message.text ?? "";
  const found = JSON.stringify(message.blocks ?? []).match(/https?:\/\/[^\s"<>|\\)]+/g) ?? [];
  const extra = [...new Set(found)].filter((link) => !text.includes(link));
  return extra.length > 0 ? `${text}\n${extra.join("\n")}` : text;
}

/** When a reply was last edited, from its stored metadata. */
export function editedAtFromMetadata(metadata: unknown): string | undefined {
  try {
    const parsed = typeof metadata === "string" ? JSON.parse(metadata) : metadata;
    const value = (parsed as { editedAt?: unknown } | null)?.editedAt;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}
