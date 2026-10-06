import { useState, useEffect, useRef } from "react";
import { renderPage } from "./layout";
import { authClient } from "../lib/auth-client";
import "./lockdown";

const slackLink = (channelId: string) =>
  `https://hackclub.enterprise.slack.com/archives/${channelId}`;

type ChannelOption = { id: string; name: string };
type ApiKeyChannel = { id: string; name: string };
type ApiKey = {
  id: number;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedBy: string | null;
  revokedAt: string | null;
  canDelegate: boolean;
  channels: ApiKeyChannel[];
};

function formatDate(value: string | null): string {
  if (!value) return "never";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "never";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function SlackChannelPill({ id, name }: { id: string; name: string }) {
  return (
    <a
      className="slack-pill"
      href={slackLink(id)}
      target="_blank"
      rel="noopener"
      title="open in Slack"
    >
      #{name}
    </a>
  );
}

function CreateKeyModal({
  open,
  onClose,
  channels,
  channelsPending,
  isAdmin,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  channels: ChannelOption[];
  channelsPending: boolean;
  isAdmin: boolean;
  onCreated: (fullKey: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [canDelegate, setCanDelegate] = useState(false);
  // The server rejects unscoped delegating keys; say so before submitting.
  const needsScope = canDelegate && selected.length === 0;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  function toggleChannel(id: string) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id],
    );
  }

  function handleClose() {
    setName("");
    setSelected([]);
    setCanDelegate(false);
    setError(null);
    onClose();
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim() || needsScope || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          channelIds: selected,
          ...(canDelegate ? { canDelegate: true } : {}),
        }),
      });
      const data = await res.json();
      if (data.fullKey) {
        onCreated(data.fullKey);
        handleClose();
      } else {
        setError(data.message || JSON.stringify(data));
      }
    } catch (e: any) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="modal"
      onClose={handleClose}
      onCancel={handleClose}
    >
      <form className="modal-body" onSubmit={handleSubmit}>
        <div className="modal-header">
          <h2>new api key</h2>
          <button
            type="button"
            className="modal-close"
            onClick={handleClose}
            aria-label="close"
          >
            ×
          </button>
        </div>

        <div className="field">
          <label className="field-label" for="key-name">
            key name
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
            scoped channels{" "}
            <span className="muted normal">
              (optional — leave empty for default access)
            </span>
          </label>
          <div className="channel-picker">
            {channelsPending && (
              <span className="muted">loading channels...</span>
            )}
            {!channelsPending && channels.length === 0 && (
              <span className="muted">no channels available to you</span>
            )}
            {channels.map((ch) => (
              <button
                type="button"
                key={ch.id}
                className={
                  "channel-chip" +
                  (selected.includes(ch.id) ? " selected" : "")
                }
                onClick={() => toggleChannel(ch.id)}
              >
                #{ch.name || ch.id}
              </button>
            ))}
          </div>
        </div>

        {isAdmin && (
          <div className="field">
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={canDelegate}
                onChange={(e) => setCanDelegate(e.currentTarget.checked)}
              />
              <span>
                can mint subkeys{" "}
                <span className="muted">
                  (for services like Slacker News that hand out per-reader
                  keys, limited to this key's channels)
                </span>
              </span>
            </label>
            {needsScope && (
              <span className="red">
                pick at least one channel for a key that mints subkeys
              </span>
            )}
          </div>
        )}

        {error && <p className="red">{error}</p>}

        <div className="modal-actions">
          <button
            type="button"
            className="button button-outline"
            onClick={handleClose}
          >
            cancel
          </button>
          <button
            type="submit"
            className="button"
            disabled={submitting || !name.trim() || needsScope}
          >
            {submitting ? "creating..." : "create key"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function KeysList() {
  const { data: session, isPending } = authClient.useSession();
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [keysPending, setKeysPending] = useState(true);
  const [channelsPending, setChannelsPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<number | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [lockdownIds, setLockdownIds] = useState<string[]>([]);

  // Only lockdown admins may create delegating keys. The server enforces
  // this; the page just hides the option from everyone else.
  useEffect(() => {
    fetch("/site-config")
      .then((r) => (r.ok ? r.json() : null))
      .then((config) => {
        const users =
          (config as { lockdownUsers?: { id: string }[] } | null)
            ?.lockdownUsers ?? [];
        setLockdownIds(users.map((u) => u.id));
      })
      .catch(() => {});
  }, []);

  function loadKeys() {
    setKeysPending(true);
    return fetch("/api/api-keys")
      .then((r) => r.json())
      .then((data) => {
        setKeys(Array.isArray(data) ? data : []);
        setKeysPending(false);
      })
      .catch((e) => {
        setError(String(e));
        setKeysPending(false);
      });
  }

  useEffect(() => {
    if (session?.user?.slackId) {
      fetch(`/api/channels/by-user/${session.user.id}`)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((data) => {
          setChannels(Array.isArray(data) ? data : []);
          setChannelsPending(false);
        })
        .catch((e) => setError(String(e)));
      loadKeys();
    }
  }, [session?.user?.slackId]);

  if (isPending) return <p>loading auth...</p>;
  if (!session?.user?.slackId) {
    return (
      <div className="markdown-body">
        <h1>your api keys</h1>
        <p className="muted">
          log in with your Hack Club account above to manage api keys.
        </p>
      </div>
    );
  }

  function handleRevoke(id: number) {
    setRevokingId(id);
    fetch(`/api/api-keys/${id}`, { method: "DELETE" })
      .then((r) => r.json())
      .then(() => loadKeys())
      .catch((e) => setError(String(e)))
      .finally(() => setRevokingId(null));
  }

  // Keys revoked by value carry revokedAt without a revoking user.
  const isRevoked = (k: ApiKey) => !!(k.revokedBy || k.revokedAt);
  const activeKeys = keys.filter((k) => !isRevoked(k));
  const revokedKeys = keys.filter(isRevoked);

  return (
    <div className="column keys-page">
      <div className="keys-toolbar">
        <div className="keys-header">
          <h1>your api keys</h1>
          <p className="muted">
            logged in as{" "}
            <strong>{session.user.name || session.user.slackId}</strong>
          </p>
        </div>
        <button className="button" onClick={() => setModalOpen(true)}>
          + new key
        </button>
      </div>

      {error && <p className="red">error: {error}</p>}
      {createdKey && (
        <div className="card key-created-card">
          <div className="api-key-row">
            <h3>key created!</h3>
            <button className="modal-close" onClick={() => setCreatedKey(null)} aria-label="dismiss">
              ×
            </button>
          </div>
          <p className="muted">copy this key now — it won't be shown again:</p>
          <code className="key-secret">{createdKey}</code>
        </div>
      )}

      <CreateKeyModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        channels={channels}
        channelsPending={channelsPending}
        isAdmin={lockdownIds.includes(session.user.slackId)}
        onCreated={(key) => {
          setCreatedKey(key);
          loadKeys();
        }}
      />

      <div className="keys-list">
        <h2>your keys</h2>
        {keysPending && <p className="muted">loading keys...</p>}
        {!keysPending && keys.length === 0 && (
          <div className="card empty-state-card">
            <p className="muted">you haven't made any api keys yet.</p>
            <button className="button" onClick={() => setModalOpen(true)}>
              + new key
            </button>
          </div>
        )}
        {activeKeys.map((k) => (
          <div className="card api-key-card" key={k.id}>
            <div className="api-key-row">
              <div className="api-key-title">
                <strong>{k.name}</strong>{" "}
                <code className="key-prefix">ind_{k.keyPrefix}...</code>
                {k.canDelegate && (
                  <>
                    {" "}
                    <span className="badge">mints subkeys</span>
                  </>
                )}
              </div>
              <button
                className="button button-outline-red"
                disabled={revokingId === k.id}
                onClick={() => handleRevoke(k.id)}
              >
                {revokingId === k.id ? "revoking..." : "revoke"}
              </button>
            </div>
            <div className="api-key-meta muted">
              created {formatDate(k.createdAt)} · last used{" "}
              {formatDate(k.lastUsedAt)}
            </div>
            {k.channels.length > 0 ? (
              <div className="api-key-channels">
                {k.channels.map((c) => (
                  <SlackChannelPill key={c.id} id={c.id} name={c.name} />
                ))}
              </div>
            ) : (
              <div className="api-key-meta muted">
                no channel scope — access follows each channel's own
                permissions
              </div>
            )}
          </div>
        ))}
        {revokedKeys.length > 0 && (
          <details className="revoked-keys">
            <summary className="muted">
              revoked keys ({revokedKeys.length})
            </summary>
            <div className="column">
              {revokedKeys.map((k) => (
                <div className="card api-key-card revoked" key={k.id}>
                  <div className="api-key-row">
                    <div className="api-key-title">
                      <strong>{k.name}</strong>{" "}
                      <code className="key-prefix">ind_{k.keyPrefix}...</code>
                    </div>
                    <span className="red">
                      {k.revokedBy ? `revoked by ${k.revokedBy}` : "revoked"}
                    </span>
                  </div>
                  {k.channels.length > 0 && (
                    <div className="api-key-channels">
                      {k.channels.map((c) => (
                        <SlackChannelPill key={c.id} id={c.id} name={c.name} />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

renderPage(
  "keys",
  <div className="markdown-body">
    <KeysList />
  </div>,
);
