import { Fragment, useState } from "react";
import { renderPage } from "./layout";
import { RequireAuth, useSiteConfig, type SessionUser } from "./shell";
import {
  Avatar,
  CopyField,
  Empty,
  Icon,
  Modal,
  Notice,
  PageHeader,
  Skeleton,
  SlackChannelPill,
  Spinner,
  api,
  fmtDate,
  fmtRelative,
  useApi,
  useConfirm,
  useToast,
  type Channel,
} from "./ui";

type KeyOwner = { id: string | null; name: string | null; slackId: string | null };
type BaseKey = {
  id: number;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedBy: string | null;
  revokedAt: string | null;
  canDelegate: boolean;
  channels: { id: string; name: string }[];
  owner: KeyOwner;
};
type Subkey = BaseKey & { subject: string | null; label: string | null };
type ApiKey = BaseKey & { subkeys: Subkey[] };

// Keys revoked by value carry revokedAt without a revoking user.
const isRevoked = (k: BaseKey) => !!(k.revokedBy || k.revokedAt);

function OwnerCell({ owner }: { owner: KeyOwner }) {
  const name = owner.name || owner.slackId || owner.id || "Unknown";
  return (
    <div className="cell-title" style={{ gap: 10 }}>
      <Avatar name={name} slackId={owner.slackId} size="sm" />
      <div style={{ minWidth: 0 }}>
        <div>{name}</div>
        {owner.slackId && <div className="id-chip">{owner.slackId}</div>}
      </div>
    </div>
  );
}

function ScopeCell({ channels }: { channels: BaseKey["channels"] }) {
  return channels.length > 0 ? (
    <div className="row" style={{ gap: 6 }}>
      {channels.map((c) => (
        <SlackChannelPill key={c.id} id={c.id} name={c.name} />
      ))}
    </div>
  ) : (
    <span className="text-2">All accessible channels</span>
  );
}

function CreateKeyModal({
  open,
  onClose,
  user,
  isAdmin,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  user: SessionUser;
  isAdmin: boolean;
  onCreated: (fullKey: string) => void;
}) {
  const channels = useApi<Channel[]>(open ? `/channels/by-user/${user.id}` : null);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [canDelegate, setCanDelegate] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The server rejects unscoped delegating keys; say so before submitting.
  const needsScope = canDelegate && selected.length === 0;

  function close() {
    setName("");
    setSelected([]);
    setCanDelegate(false);
    setError(null);
    onClose();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || needsScope || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const data = await api<{ fullKey: string }>("/api-keys", {
        method: "POST",
        body: { name: name.trim(), channelIds: selected, ...(canDelegate ? { canDelegate: true } : {}) },
      });
      onCreated(data.fullKey);
      close();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={close} title="Create API key" description="Keys act as you, limited to the channels you pick." width={560}>
      <form className="stack" style={{ gap: 22 }} onSubmit={submit}>
        <div className="field">
          <label className="field-label" htmlFor="key-name">
            Name
          </label>
          <input
            className="input"
            id="key-name"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            placeholder="e.g. my integration"
            autoFocus
            required
          />
        </div>

        <div className="field">
          <label className="field-label">
            Channel scope <span className="optional">(optional)</span>
          </label>
          <span className="field-hint">Leave empty to follow each channel's own access rules.</span>
          <div className="picker">
            {channels.loading && <Spinner />}
            {channels.data?.length === 0 && <span className="muted small">No channels available to you.</span>}
            {channels.data?.map((ch) => (
              <button
                type="button"
                key={ch.id}
                className={"pick" + (selected.includes(ch.id) ? " selected" : "")}
                onClick={() =>
                  setSelected((prev) => (prev.includes(ch.id) ? prev.filter((c) => c !== ch.id) : [...prev, ch.id]))
                }
              >
                #{ch.name || ch.id}
              </button>
            ))}
          </div>
        </div>

        {isAdmin && (
          <label className="radio-card" style={{ flexDirection: "row", gap: 12, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={canDelegate}
              onChange={(e) => setCanDelegate(e.currentTarget.checked)}
              style={{ marginTop: 3 }}
            />
            <div>
              <strong>Can mint subkeys</strong>
              <span style={{ display: "block", marginTop: 4 }}>
                For services like Slacker News that hand out per-reader keys, limited to this key's channels.
              </span>
              {needsScope && (
                <span className="field-error" style={{ display: "block", marginTop: 6 }}>
                  Pick at least one channel for a key that mints subkeys.
                </span>
              )}
            </div>
          </label>
        )}

        {error && <Notice tone="danger" icon="alert">{error}</Notice>}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting || !name.trim() || needsScope}>
            {submitting && <Spinner />} Create key
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RevokeByValue() {
  const toast = useToast();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3>Revoke a leaked key</h3>
          <p>Paste any indigest key, yours or not, to revoke it immediately.</p>
        </div>
      </div>
      <form
        className="card-body row"
        style={{ flexWrap: "nowrap" }}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const r = await api<{ alreadyRevoked: boolean }>("/api-keys/revoke", {
              method: "POST",
              body: { key: key.trim() },
            });
            toast(r.alreadyRevoked ? "That key was already revoked" : "Key revoked");
            setKey("");
          } catch (e: any) {
            toast(e.message, "error");
          } finally {
            setBusy(false);
          }
        }}
      >
        <input
          className="input mono"
          placeholder="ind_…"
          value={key}
          onChange={(e) => setKey(e.currentTarget.value)}
          autoComplete="off"
        />
        <button className="btn btn-danger" disabled={!key.trim() || busy}>
          {busy && <Spinner />} Revoke
        </button>
      </form>
    </div>
  );
}

function KeysPage({ user }: { user: SessionUser }) {
  const toast = useToast();
  const config = useSiteConfig();
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const keys = useApi<ApiKey[]>(`/api-keys?scope=${scope}`);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<number | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const { confirm, dialog } = useConfirm();
  // Only lockdown admins may create delegating keys. The server enforces
  // this; the page just hides the option from everyone else.
  const isAdmin = !!user.slackId && !!config?.lockdownUsers.some((u) => u.id === user.slackId);

  async function revoke(k: BaseKey) {
    const ok = await confirm({
      title: `Revoke “${k.name}”?`,
      description:
        "Anything using this key will immediately lose access. This can't be undone." +
        ("subkeys" in k && (k as ApiKey).subkeys.some((c) => !isRevoked(c))
          ? " Its subkeys stop working too."
          : ""),
      action: "Revoke key",
    });
    if (!ok) return;
    setRevokingId(k.id);
    try {
      await api(`/api-keys/${k.id}`, { method: "DELETE" });
      toast("Key revoked");
      keys.reload();
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setRevokingId(null);
    }
  }

  const all = Array.isArray(keys.data) ? keys.data : [];
  const showOwner = scope === "all";
  const active = all.filter((k) => !isRevoked(k));
  const revoked = all.filter(isRevoked);

  return (
    <>
      <PageHeader
        title="API keys"
        description="Authenticate requests to the indigest API and private feeds with a Bearer token."
        actions={
          <>
            <a className="btn" href="/docs.html">
              <Icon name="code" /> API reference
            </a>
            <button className="btn btn-primary" onClick={() => setModalOpen(true)}>
              <Icon name="plus" /> Create key
            </button>
          </>
        }
      />

      <div className="stack">
        {isAdmin && (
          <div className="toolbar" style={{ marginBottom: 0 }}>
            <div className="segmented" role="tablist">
              <button className={scope === "mine" ? "active" : ""} onClick={() => setScope("mine")}>
                Your keys
              </button>
              <button className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>
                <Icon name="shield" size={13} /> All users' keys
              </button>
            </div>
          </div>
        )}
        {createdKey && (
          <div className="card" style={{ borderColor: "var(--inv)" }}>
            <div className="card-header">
              <div>
                <h3>Your new key</h3>
                <p>Copy it now — it won't be shown again.</p>
              </div>
              <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setCreatedKey(null)} aria-label="Dismiss">
                <Icon name="x" />
              </button>
            </div>
            <div className="card-body stack-sm">
              <CopyField value={createdKey} reveal />
              <code className="small muted">curl -H "Authorization: Bearer {createdKey.slice(0, 12)}…" {location.origin}/api/messages?channel=…</code>
            </div>
          </div>
        )}

        <div className="card">
          {keys.error && (
            <div className="card-body">
              <Notice tone="danger" icon="alert">{keys.error}</Notice>
            </div>
          )}
          {keys.loading && !keys.data && (
            <div className="card-body stack-sm">
              <Skeleton h={36} />
              <Skeleton h={36} />
            </div>
          )}
          {keys.data && active.length === 0 && (
            <Empty
              icon="key"
              title="No active keys"
              action={
                <button className="btn btn-primary" onClick={() => setModalOpen(true)}>
                  <Icon name="plus" /> Create key
                </button>
              }
            >
              Create a key to read feeds and messages from your own code.
            </Empty>
          )}
          {active.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    {showOwner && <th>Owner</th>}
                    <th>Scope</th>
                    <th className="hide-md">Created</th>
                    <th className="hide-md">Last used</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {active.map((k) => {
                    const subs = k.subkeys;
                    const liveSubs = subs.filter((c) => !isRevoked(c)).length;
                    const open = expanded.has(k.id);
                    return (
                      <Fragment key={k.id}>
                        <tr>
                          <td>
                            <div style={{ fontWeight: 500 }}>
                              {k.name} {k.canDelegate && <span className="badge outline">mints subkeys</span>}
                            </div>
                            <div className="row" style={{ gap: 8, marginTop: 2 }}>
                              <span className="id-chip">ind_{k.keyPrefix}…</span>
                              {subs.length > 0 && (
                                <button className="subkey-toggle" onClick={() => toggle(k.id)} aria-expanded={open}>
                                  <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
                                  {liveSubs} active subkey{liveSubs === 1 ? "" : "s"}
                                  {subs.length > liveSubs && <span className="muted"> · {subs.length - liveSubs} revoked</span>}
                                </button>
                              )}
                            </div>
                          </td>
                          {showOwner && (
                            <td>
                              <OwnerCell owner={k.owner} />
                            </td>
                          )}
                          <td>
                            <ScopeCell channels={k.channels} />
                          </td>
                          <td className="hide-md muted">{fmtDate(k.createdAt)}</td>
                          <td className="hide-md muted">{fmtRelative(k.lastUsedAt)}</td>
                          <td className="right">
                            <button className="btn btn-sm btn-danger" disabled={revokingId === k.id} onClick={() => revoke(k)}>
                              {revokingId === k.id ? <Spinner /> : "Revoke"}
                            </button>
                          </td>
                        </tr>
                        {open &&
                          subs.map((c) => (
                            <tr key={c.id} className={"subkey-row" + (isRevoked(c) ? " revoked" : "")}>
                              <td>
                                <div className="subkey-name">
                                  <span className="subkey-branch" aria-hidden="true" />
                                  <div>
                                    <div>
                                      <span className="mono small">{c.subject ?? "subkey"}</span>
                                      {c.label && <span className="text-2"> · {c.label}</span>}
                                    </div>
                                    <div className="id-chip">ind_{c.keyPrefix}…</div>
                                  </div>
                                </div>
                              </td>
                              {showOwner && <td />}
                              <td>
                                <ScopeCell channels={c.channels} />
                              </td>
                              <td className="hide-md muted">{fmtDate(c.createdAt)}</td>
                              <td className="hide-md muted">{fmtRelative(c.lastUsedAt)}</td>
                              <td className="right">
                                {isRevoked(c) ? (
                                  <span className="badge outline">Revoked</span>
                                ) : (
                                  <button
                                    className="btn btn-sm btn-danger"
                                    disabled={revokingId === c.id}
                                    onClick={() => revoke(c)}
                                  >
                                    {revokingId === c.id ? <Spinner /> : "Revoke"}
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {revoked.length > 0 && (
            <details>
              <summary className="card-footer" style={{ cursor: "pointer", borderRadius: 0 }}>
                Revoked keys ({revoked.length})
              </summary>
              <table className="table">
                <tbody>
                  {revoked.map((k) => (
                    <tr key={k.id} style={{ opacity: 0.6 }}>
                      <td>
                        <div style={{ fontWeight: 500 }}>{k.name}</div>
                        <div className="id-chip">ind_{k.keyPrefix}…</div>
                      </td>
                      {showOwner && (
                        <td>
                          <OwnerCell owner={k.owner} />
                        </td>
                      )}
                      <td className="text-2">{k.revokedBy ? `Revoked by ${k.revokedBy}` : "Revoked"}</td>
                      <td className="right muted">{fmtDate(k.revokedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </div>

        <RevokeByValue />
      </div>

      <CreateKeyModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        user={user}
        isAdmin={isAdmin}
        onCreated={(key) => {
          setCreatedKey(key);
          keys.reload();
        }}
      />
      {dialog}
    </>
  );
}

renderPage(
  "keys",
  <RequireAuth title="Sign in to manage API keys" description="API keys are tied to your Hack Club account.">
    {(user) => <KeysPage user={user} />}
  </RequireAuth>,
  { crumbs: [{ label: "Build", href: "/" }, { label: "API keys" }] },
);
