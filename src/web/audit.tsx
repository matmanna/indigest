import { useEffect, useState } from "react";
import { renderPage } from "./layout";
import { RequireAuth, useIsAdmin, useSiteConfig } from "./shell";
import {
  Avatar,
  Empty,
  Icon,
  Modal,
  Notice,
  PageHeader,
  Skeleton,
  Spinner,
  api,
  channelPageUrl,
  fmtRelative,
  slackUserUrl,
  useApi,
  useToast,
  type IconName,
} from "./ui";

interface AuditEntry {
  id: number;
  createdAt: string;
  action: string;
  outcome: "success" | "failure" | "denied";
  severity: string;
  source: "web" | "api" | "slack" | "auth" | "system";
  actorType: string;
  actorId: string;
  actorName: string | null;
  actorSlackId: string | null;
  targetType: string | null;
  targetId: string | null;
  targetName: string | null;
  reason: string | null;
  changes: { before?: unknown; after?: unknown; patch?: { op: string; path: string; value?: unknown }[] } | null;
  context: Record<string, unknown> | null;
  prevHash: string | null;
  hash: string;
}

interface Filters {
  q: string;
  action: string;
  outcome: string;
  source: string;
}

const SOURCE_ICON: Record<AuditEntry["source"], IconName> = {
  web: "monitor",
  api: "key",
  slack: "slack",
  auth: "user",
  system: "settings",
};

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function OutcomeBadge({ outcome }: { outcome: AuditEntry["outcome"] }) {
  if (outcome === "denied") return <span className="badge danger">Denied</span>;
  if (outcome === "failure") return <span className="badge warn">Failed</span>;
  return (
    <span className="badge outline">
      <span className="dot on" /> Success
    </span>
  );
}

function Target({ e }: { e: AuditEntry }) {
  if (!e.targetId) return <span className="muted">—</span>;
  if (e.targetType === "channel")
    return (
      <a className="slack-pill" href={channelPageUrl(e.targetId)} onClick={(ev) => ev.stopPropagation()}>
        #{e.targetName || e.targetId}
      </a>
    );
  return (
    <span className="text-2">
      <span className="muted">{e.targetType} </span>
      <span className="mono small">{e.targetName || e.targetId}</span>
    </span>
  );
}

function Actor({ e }: { e: AuditEntry }) {
  return (
    <div className="cell-title" style={{ gap: 10 }}>
      {e.actorType === "api" ? (
        <span className="avatar sm">
          <Icon name="key" size={11} />
        </span>
      ) : (
        <Avatar name={e.actorName || e.actorId} slackId={e.actorSlackId} size="sm" />
      )}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 500 }}>{e.actorName || e.actorId}</div>
        {e.actorSlackId && <div className="id-chip">{e.actorSlackId}</div>}
      </div>
    </div>
  );
}

function DetailModal({ entry, onClose }: { entry: AuditEntry | null; onClose: () => void }) {
  return (
    <Modal open={!!entry} onClose={onClose} title={entry?.action ?? ""} description={entry ? fmtTime(entry.createdAt) : undefined} width={680}>
      {entry && (
        <div className="stack" style={{ gap: 20 }}>
          <dl className="kv card" style={{ borderRadius: 10 }}>
            <dt>Outcome</dt>
            <dd>
              <OutcomeBadge outcome={entry.outcome} />
              {entry.reason && <span className="text-2" style={{ marginLeft: 10 }}>{entry.reason}</span>}
            </dd>
            <dt>Actor</dt>
            <dd>
              {entry.actorName || entry.actorId}{" "}
              <span className="id-chip">
                {entry.actorType} · {entry.actorId}
              </span>
              {entry.actorSlackId && (
                <>
                  {" "}
                  <a className="small" href={slackUserUrl(entry.actorSlackId)} target="_blank" rel="noopener">
                    Slack ↗
                  </a>
                </>
              )}
            </dd>
            <dt>Target</dt>
            <dd>
              <Target e={entry} />
            </dd>
            <dt>Source</dt>
            <dd className="text-2">{entry.source}</dd>
            <dt>Severity</dt>
            <dd className="text-2">{entry.severity}</dd>
          </dl>
          {entry.changes?.patch && entry.changes.patch.length > 0 && (
            <div className="field">
              <span className="field-label">Changes</span>
              <div className="card" style={{ borderRadius: 10 }}>
                <table className="table">
                  <tbody>
                    {entry.changes.patch.map((p, i) => (
                      <tr key={i}>
                        <td style={{ width: 90 }}>
                          <span className="badge mono">{p.op}</span>
                        </td>
                        <td className="mono small">{p.path}</td>
                        <td className="mono small text-2" style={{ wordBreak: "break-all" }}>
                          {p.value === undefined ? "" : JSON.stringify(p.value)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {entry.context && (
            <div className="field">
              <span className="field-label">Context</span>
              <pre className="code-block">{JSON.stringify(entry.context, null, 2)}</pre>
            </div>
          )}
          <div className="field">
            <span className="field-label">Integrity</span>
            <pre className="code-block" style={{ maxHeight: 120 }}>
              {`hash      ${entry.hash}\nprev_hash ${entry.prevHash ?? "(first entry)"}`}
            </pre>
          </div>
        </div>
      )}
    </Modal>
  );
}

function ChainStatus() {
  const toast = useToast();
  const [state, setState] = useState<{ ok: boolean; brokenAt: number | null; checked: number } | null>(null);
  const [busy, setBusy] = useState(false);
  async function verify() {
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; brokenAt: number | null; checked: number }>("/admin/audit/verify");
      setState(r);
      if (!r.ok) toast(`Chain broken at entry #${r.brokenAt}`, "error");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {state && (
        <span className={"badge" + (state.ok ? " outline" : " danger")}>
          <Icon name={state.ok ? "check" : "alert"} size={13} />
          {state.ok ? `${state.checked} entries intact` : `Tampered at #${state.brokenAt}`}
        </span>
      )}
      <button className="btn" onClick={verify} disabled={busy}>
        {busy ? <Spinner /> : <Icon name="shield" />} Verify integrity
      </button>
    </>
  );
}

function AuditPage() {
  const isAdmin = useIsAdmin();
  const config = useSiteConfig();
  const actions = useApi<{ action: string; description: string }[]>(isAdmin ? "/admin/audit/actions" : null);
  const [filters, setFilters] = useState<Filters>({ q: "", action: "", outcome: "", source: "" });
  const [query, setQuery] = useState(filters);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<AuditEntry | null>(null);

  // Debounce the free-text search; selects apply immediately.
  useEffect(() => {
    const t = setTimeout(() => setQuery(filters), filters.q === query.q ? 0 : 250);
    return () => clearTimeout(t);
  }, [filters]);

  function qs(before?: number | null) {
    const p = new URLSearchParams({ limit: "50" });
    for (const [k, v] of Object.entries(query)) if (v) p.set(k, v);
    if (before) p.set("before", String(before));
    return p.toString();
  }

  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    setEntries(null);
    api<{ entries: AuditEntry[]; nextBefore: number | null }>(`/admin/audit?${qs()}`)
      .then((r) => {
        if (!alive) return;
        setEntries(r.entries);
        setNextBefore(r.nextBefore);
        setError(null);
      })
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [query, isAdmin]);

  async function loadMore() {
    if (!nextBefore) return;
    setLoadingMore(true);
    try {
      const r = await api<{ entries: AuditEntry[]; nextBefore: number | null }>(`/admin/audit?${qs(nextBefore)}`);
      setEntries((prev) => [...(prev ?? []), ...r.entries]);
      setNextBefore(r.nextBefore);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingMore(false);
    }
  }

  if (!config) return <Skeleton h={200} />;
  if (!isAdmin)
    return (
      <div className="card">
        <Empty icon="lock" title="Admins only">
          The audit log is visible to indigest's authorized (lockdown) users.
        </Empty>
      </div>
    );

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

  return (
    <>
      <PageHeader
        eyebrow={<span className="badge outline">Admin</span>}
        title="Audit log"
        description="Every change to channels, subscriptions, API keys, and sign-ins, from the dashboard, the API, and Slack. Entries are hash-chained so edits or deletions are detectable."
        actions={<ChainStatus />}
      />

      <div className="toolbar">
        <div className="search-input">
          <Icon name="search" />
          <input
            className="input"
            placeholder="Search actor, target, or action…"
            value={filters.q}
            onChange={(e) => set({ q: e.currentTarget.value })}
          />
        </div>
        <select className="select" style={{ width: 210 }} value={filters.action} onChange={(e) => set({ action: e.currentTarget.value })}>
          <option value="">All actions</option>
          {actions.data?.map((a) => (
            <option key={a.action} value={a.action} title={a.description}>
              {a.action}
            </option>
          ))}
        </select>
        <select className="select" style={{ width: 150 }} value={filters.source} onChange={(e) => set({ source: e.currentTarget.value })}>
          <option value="">All sources</option>
          <option value="web">Dashboard</option>
          <option value="api">API key</option>
          <option value="slack">Slack</option>
          <option value="auth">Sign-in</option>
        </select>
        <div className="spacer" />
        <div className="segmented">
          {[
            ["", "All"],
            ["success", "Success"],
            ["denied", "Denied"],
            ["failure", "Failed"],
          ].map(([v, label]) => (
            <button key={v} className={filters.outcome === v ? "active" : ""} onClick={() => set({ outcome: v! })}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        {error && (
          <div className="card-body">
            <Notice tone="danger" icon="alert">{error}</Notice>
          </div>
        )}
        {!entries && !error && (
          <div className="card-body stack-sm">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} h={40} />
            ))}
          </div>
        )}
        {entries?.length === 0 && (
          <Empty icon="shield" title="No audit entries">
            {Object.values(query).some(Boolean) ? "Nothing matches these filters." : "Changes will show up here as they happen."}
          </Empty>
        )}
        {entries && entries.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th className="hide-md">Target</th>
                  <th>Outcome</th>
                  <th className="hide-md">Source</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className="clickable" onClick={() => setSelected(e)}>
                    <td className="muted small" title={fmtTime(e.createdAt)} style={{ whiteSpace: "nowrap" }}>
                      {fmtRelative(e.createdAt)}
                    </td>
                    <td>
                      <Actor e={e} />
                    </td>
                    <td>
                      <span className="badge mono">{e.action}</span>
                      {typeof e.context?.command === "string" && (
                        <div className="id-chip" style={{ marginTop: 4 }}>{e.context.command}</div>
                      )}
                    </td>
                    <td className="hide-md">
                      <Target e={e} />
                    </td>
                    <td>
                      <OutcomeBadge outcome={e.outcome} />
                    </td>
                    <td className="hide-md text-2">
                      <span className="row" style={{ gap: 6 }}>
                        <Icon name={SOURCE_ICON[e.source] ?? "settings"} size={14} /> {e.source}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {nextBefore && (
          <div className="card-footer" style={{ justifyContent: "center" }}>
            <button className="btn btn-sm" onClick={loadMore} disabled={loadingMore}>
              {loadingMore && <Spinner />} Load older entries
            </button>
          </div>
        )}
      </div>
      <DetailModal entry={selected} onClose={() => setSelected(null)} />
    </>
  );
}

renderPage(
  "audit",
  <RequireAuth title="Sign in to view the audit log">{() => <AuditPage />}</RequireAuth>,
  { crumbs: [{ label: "Admin" }, { label: "Audit log" }] },
);
