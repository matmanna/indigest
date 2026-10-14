import { renderPage } from "./layout";
import { FeedMap } from "./flow";
import { authClient } from "../lib/auth-client";
import {
  Icon,
  Skeleton,
  channelPageUrl,
  useApi,
  type Channel,
  type IconName,
  type SubscriptionRow,
} from "./ui";

/** "Slack" with Slack's official icon (SLA-Slack-icon-RGB from Slack's media kit). */
function SlackWord() {
  return (
    <span className="slack-word">
      <img className="slack-icon" src="/slack-icon.svg" alt="" />
      Slack
    </span>
  );
}

function Stat({ label, value, icon }: { label: string; value: number | null; icon: IconName }) {
  return (
    <div className="card stat">
      <div className="stat-label">
        <Icon name={icon} size={15} />
        {label}
      </div>
      <div className="stat-value">{value == null ? <Skeleton w={48} h={28} /> : value}</div>
    </div>
  );
}

function ColumnList({
  title,
  href,
  count,
  rows,
  empty,
}: {
  title: string;
  href: string;
  count: number | null;
  rows: { key: string; icon: IconName; label: React.ReactNode; href: string }[] | null;
  empty: string;
}) {
  return (
    <div className="col-list">
      <a className="col-list-head" href={href}>
        {title}
        {count != null && <span className="count">{count}</span>}
        <Icon name="chevronRight" size={14} />
      </a>
      {rows === null &&
        [0, 1, 2, 3, 4].map((i) => (
          <div key={i} style={{ padding: "18px 4px", borderBottom: "1px solid var(--border)" }}>
            <Skeleton w={`${60 + ((i * 13) % 30)}%`} />
          </div>
        ))}
      {rows?.length === 0 && <p className="muted small" style={{ padding: "16px 4px" }}>{empty}</p>}
      {rows?.map((r) => (
        <a key={r.key} className="col-row" href={r.href}>
          <Icon name={r.icon} size={18} />
          <span className="col-row-name">{r.label}</span>
          <Icon name="chevronRight" size={14} />
        </a>
      ))}
    </div>
  );
}

function Home() {
  const { data: session } = authClient.useSession();
  const channels = useApi<Channel[]>("/channels");
  const subs = useApi<SubscriptionRow[]>("/subscriptions/all");
  const keys = useApi<{ revokedAt: string | null }[]>(session?.user ? "/api-keys" : null);

  const pubd = channels.data?.filter((c) => c.enabled) ?? null;
  const recent = pubd
    ? [...pubd].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).slice(0, 5)
    : null;
  const webhooks = pubd ? pubd.filter((c) => c.webhookUrl).length : null;
  const first = session?.user?.name?.split(" ")[0];

  return (
    <div className="stack" style={{ gap: 40 }}>
      <div className="hero">
        <a className="pill-announce" href="/usage.html">
          <Icon name="slack" /> Run <code>/in pub</code> in any channel to get started
          <Icon name="arrowRight" size={14} />
        </a>
        <h1>
          {first ? (
            `Welcome back, ${first}.`
          ) : (
            <>
              Pipe <SlackWord /> into anything.
            </>
          )}
        </h1>
        <p>Privacy-conscious bridge from Slack channels to RSS, JSON API, webhooks, and pub/sub.</p>
      </div>

      <div className="grid-4">
        <Stat label="Pub'd channels" value={pubd?.length ?? null} icon="hash" />
        <Stat label="Subscriptions" value={subs.data?.length ?? null} icon="radio" />
        <Stat label="Webhooks" value={webhooks} icon="webhook" />
        <Stat
          label="Your active keys"
          value={session?.user ? (keys.data?.filter((k) => !k.revokedAt).length ?? null) : 0}
          icon="key"
        />
      </div>

      <div className="grid-3">
        <ColumnList
          title="Channels"
          href="/channels.html"
          count={pubd?.length ?? null}
          empty="No channels pub'd yet."
          rows={
            recent?.map((c) => ({
              key: c.id,
              icon: "hash" as const,
              label: c.name || c.id,
              href: channelPageUrl(c.id),
            })) ?? null
          }
        />
        <ColumnList
          title="Pub/sub"
          href="/subscriptions.html"
          count={subs.data?.length ?? null}
          empty="No subscriptions yet."
          rows={
            subs.data?.slice(0, 5).map((s) => ({
              key: `${s.sourceChannelId}-${s.subscriberChannelId}`,
              icon: "radio" as const,
              label: (
                <>
                  <span className="col-row-muted">#{s.sourceName || s.sourceChannelId} → </span>#
                  {s.subscriberName || s.subscriberChannelId}
                </>
              ),
              href: channelPageUrl(s.subscriberChannelId),
            })) ?? null
          }
        />
        <ColumnList
          title="Get started"
          href="/usage.html"
          count={null}
          empty=""
          rows={[
            { key: "keys", icon: "key", label: "Create an API key", href: "/keys.html" },
            { key: "docs", icon: "code", label: "Browse the API reference", href: "/docs.html" },
            { key: "usage", icon: "terminal", label: "Slack command reference", href: "/usage.html" },
            { key: "map", icon: "map", label: "Explore the feed map", href: "/map.html" },
            {
              key: "settings",
              icon: "settings",
              label: session?.user ? "Account settings" : "Sign in",
              href: session?.user ? "/settings.html" : "/login.html",
            },
          ]}
        />
      </div>

      <section>
        <div className="row" style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-0.01em" }}>Feed map</h2>
          <span className="muted small">Channels, their feeds, and who they forward to.</span>
        </div>
        <FeedMap interactive={false} />
      </section>
    </div>
  );
}

renderPage("home", <Home />, { crumbs: [{ label: "Overview" }] });
