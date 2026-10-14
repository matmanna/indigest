import { useEffect, useMemo, useState } from "react";
import { renderPage } from "./layout";
import { authClient } from "../lib/auth-client";
import { signIn } from "./shell";
import {
  Empty,
  Icon,
  Modal,
  Notice,
  PageHeader,
  Skeleton,
  Spinner,
  StatusBadge,
  accessLabel,
  api,
  approvalMode,
  channelPageUrl,
  fmtDate,
  useApi,
  useToast,
  type Channel,
  type ManageableResponse,
  type SubscriptionRow,
} from "./ui";

type Filter = "pubd" | "managed" | "all";

function PublishModal({
  open,
  onClose,
  isAdmin,
}: {
  open: boolean;
  onClose: () => void;
  isAdmin: boolean;
}) {
  const toast = useToast();
  const [options, setOptions] = useState<{ id: string; name: string; isPrivate: boolean }[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [manualId, setManualId] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || options) return;
    api<typeof options>("/slack/channels")
      .then((o) => setOptions(o ?? []))
      .catch((e) => {
        setOptions([]);
        setLoadErr(e.message);
      });
  }, [open]);

  const filtered = (options ?? []).filter((o) =>
    o.name.toLowerCase().includes(query.trim().toLowerCase().replace(/^#/, "")),
  );
  const target = selected || manualId.trim();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const ch = await api<Channel>(`/channels/${encodeURIComponent(target)}/publish`, {
        method: "POST",
        body: {},
      });
      toast(`#${ch.name || ch.id} is now pub'd`);
      window.location.href = channelPageUrl(ch.id);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Pub a channel"
      description="Start collecting approved messages from a Slack channel into feeds."
      width={560}
    >
      <form className="stack" style={{ gap: 20 }} onSubmit={submit}>
        {!isAdmin && (
          <Notice icon="info">
            You need to be the channel's creator or a workspace admin (or an authorized user while
            lockdown is on) to pub it.
          </Notice>
        )}
        <div className="field">
          <label className="field-label">Channels indigest is in</label>
          <div className="search-input" style={{ maxWidth: "none" }}>
            <Icon name="search" />
            <input
              className="input"
              placeholder="Filter channels…"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
            />
          </div>
          <div className="picker" style={{ marginTop: 6 }}>
            {options === null && <Spinner />}
            {options !== null && filtered.length === 0 && (
              <span className="muted small">
                {loadErr ? `Couldn't list channels: ${loadErr}` : "No unpub'd channels found. Invite @indigest to a channel first."}
              </span>
            )}
            {filtered.map((o) => (
              <button
                type="button"
                key={o.id}
                className={"pick" + (selected === o.id ? " selected" : "")}
                onClick={() => {
                  setSelected(selected === o.id ? null : o.id);
                  setManualId("");
                }}
              >
                {o.isPrivate ? <Icon name="lock" size={12} /> : "#"}
                {o.name}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="manual-id">
            Or enter a channel ID <span className="optional">(optional)</span>
          </label>
          <input
            id="manual-id"
            className="input mono"
            placeholder="C0123456789"
            value={manualId}
            onChange={(e) => {
              setManualId(e.currentTarget.value);
              setSelected(null);
            }}
          />
        </div>
        {error && <Notice tone="danger" icon="alert">{error}</Notice>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!target || busy}>
            {busy ? <Spinner /> : <Icon name="radio" />} Pub channel
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ChannelsPage() {
  const { data: session, isPending } = authClient.useSession();
  const publicList = useApi<Channel[]>(session?.user || isPending ? null : "/channels");
  const managed = useApi<ManageableResponse>(session?.user ? "/channels/manageable" : null);
  const subs = useApi<SubscriptionRow[]>("/subscriptions/all");
  const [filter, setFilter] = useState<Filter>("pubd");
  const [query, setQuery] = useState("");
  const [modal, setModal] = useState(() => new URLSearchParams(location.search).has("new"));

  const all: Channel[] | null = managed.data?.channels ?? publicList.data ?? null;
  const error = managed.error || publicList.error;

  const subCounts = useMemo(() => {
    const m = new Map<string, { in: number; out: number }>();
    for (const s of subs.data ?? []) {
      const src = m.get(s.sourceChannelId) ?? { in: 0, out: 0 };
      src.out++;
      m.set(s.sourceChannelId, src);
      const dst = m.get(s.subscriberChannelId) ?? { in: 0, out: 0 };
      dst.in++;
      m.set(s.subscriberChannelId, dst);
    }
    return m;
  }, [subs.data]);

  const rows = useMemo(() => {
    if (!all) return null;
    const q = query.trim().toLowerCase().replace(/^#/, "");
    return all
      .filter((c) =>
        filter === "pubd" ? c.enabled : filter === "managed" ? c.canManage : true,
      )
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
  }, [all, filter, query]);

  const counts = {
    pubd: all?.filter((c) => c.enabled).length ?? 0,
    managed: all?.filter((c) => c.canManage).length ?? 0,
    all: all?.length ?? 0,
  };

  return (
    <>
      <PageHeader
        title="Channels"
        description="Slack channels indigest knows about. Pub a channel to turn its approved messages into RSS, JSON, API, and webhook feeds."
        actions={
          session?.user ? (
            <button className="btn btn-primary" onClick={() => setModal(true)}>
              <Icon name="plus" /> Pub channel
            </button>
          ) : (
            <button className="btn" onClick={() => signIn()}>
              Sign in to manage
            </button>
          )
        }
      />

      <div className="toolbar">
        <div className="search-input">
          <Icon name="search" />
          <input
            className="input"
            placeholder="Search by name or ID…"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
        <div className="spacer" />
        <div className="segmented" role="tablist">
          <button className={filter === "pubd" ? "active" : ""} onClick={() => setFilter("pubd")}>
            Pub'd <span className="count">{counts.pubd}</span>
          </button>
          {session?.user && (
            <button className={filter === "managed" ? "active" : ""} onClick={() => setFilter("managed")}>
              Managed by you <span className="count">{counts.managed}</span>
            </button>
          )}
          <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>
            All <span className="count">{counts.all}</span>
          </button>
        </div>
      </div>

      <div className="card">
        {error && (
          <div className="card-body">
            <Notice tone="danger" icon="alert">{error}</Notice>
          </div>
        )}
        {!error && rows === null && (
          <div className="card-body stack-sm">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} h={36} />
            ))}
          </div>
        )}
        {rows && rows.length === 0 && (
          <Empty
            icon="hash"
            title={query ? "No matching channels" : filter === "managed" ? "You don't manage any channels" : "No channels yet"}
            action={
              session?.user && !query ? (
                <button className="btn btn-primary" onClick={() => setModal(true)}>
                  <Icon name="plus" /> Pub channel
                </button>
              ) : undefined
            }
          >
            {query ? "Try a different search." : "Pub a channel here or run /in pub in Slack."}
          </Empty>
        )}
        {rows && rows.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>Status</th>
                  <th className="hide-md">Approval</th>
                  <th className="hide-md">Feed access</th>
                  <th className="hide-md">Pub/sub</th>
                  <th className="hide-md">Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const sc = subCounts.get(c.id);
                  return (
                    <tr key={c.id} className="clickable" onClick={() => (location.href = channelPageUrl(c.id))}>
                      <td>
                        <div className="cell-title">
                          <span className="channel-glyph">#</span>
                          <div>
                            <a href={channelPageUrl(c.id)} style={{ textDecoration: "none" }}>
                              {c.name || c.id}
                            </a>
                            <div className="id-chip">{c.id}</div>
                          </div>
                          {c.canManage && <span className="badge outline">Manager</span>}
                        </div>
                      </td>
                      <td>
                        <StatusBadge enabled={c.enabled} />
                      </td>
                      <td className="hide-md text-2">{approvalMode(c)}</td>
                      <td className="hide-md text-2">
                        <span className="row" style={{ gap: 6 }}>
                          {!c.accessPermUsers.includes("*") && <Icon name="lock" size={13} />}
                          {accessLabel(c)}
                        </span>
                      </td>
                      <td className="hide-md text-2">
                        {sc ? `${sc.out} out · ${sc.in} in` : <span className="muted">—</span>}
                      </td>
                      <td className="hide-md muted">{fmtDate(c.createdAt)}</td>
                      <td className="right">
                        <Icon name="chevronRight" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {session?.user && (
        <PublishModal open={modal} onClose={() => setModal(false)} isAdmin={!!managed.data?.isAdmin} />
      )}
    </>
  );
}

renderPage("channels", <ChannelsPage />, {
  crumbs: [{ label: "Build", href: "/" }, { label: "Channels" }],
});
