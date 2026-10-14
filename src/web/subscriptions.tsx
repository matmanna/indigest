import { useMemo, useState } from "react";
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
  api,
  channelPageUrl,
  fmtDate,
  useApi,
  useConfirm,
  useToast,
  type ManageableResponse,
  type SubscriptionRow,
} from "./ui";

function NewSubscriptionModal({
  open,
  onClose,
  managed,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  managed: ManageableResponse | null;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [source, setSource] = useState("");
  const [subscriber, setSubscriber] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const channels = managed?.channels ?? [];
  const sources = channels.filter((c) => c.enabled && c.id !== subscriber);
  const subscribers = channels.filter((c) => c.canManage && c.id !== source);

  function close() {
    setSource("");
    setSubscriber("");
    setErr(null);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="New subscription"
      description="Forward every approved message from one channel into another."
      width={560}
    >
      <form
        className="stack"
        style={{ gap: 20 }}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            await api("/subscriptions", {
              method: "POST",
              body: { sourceChannelId: source, subscriberChannelId: subscriber },
            });
            toast("Subscription created");
            onCreated();
            close();
          } catch (e: any) {
            setErr(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="field">
          <label className="field-label">Source (publisher)</label>
          <select className="select" value={source} onChange={(e) => setSource(e.currentTarget.value)} required>
            <option value="">Select a pub'd channel…</option>
            {sources.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name || c.id}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: "grid", placeItems: "center", color: "var(--text-3)" }}>
          <Icon name="arrowRight" size={18} />
        </div>
        <div className="field">
          <label className="field-label">Subscriber (receives forwards)</label>
          <select className="select" value={subscriber} onChange={(e) => setSubscriber(e.currentTarget.value)} required>
            <option value="">Select a channel you manage…</option>
            {subscribers.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name || c.id}
              </option>
            ))}
          </select>
          {managed && subscribers.length === 0 && (
            <span className="field-hint">
              {managed.lockdown
                ? "Lockdown mode is on — only authorized users can add subscriptions."
                : "You don't manage any channels indigest knows about. Run /in status in a channel you created first."}
            </span>
          )}
        </div>
        {err && <Notice tone="danger" icon="alert">{err}</Notice>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!source || !subscriber || busy}>
            {busy ? <Spinner /> : <Icon name="radio" />} Subscribe
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SubscriptionsPage() {
  const toast = useToast();
  const { data: session } = authClient.useSession();
  const subs = useApi<SubscriptionRow[]>("/subscriptions/all");
  const managed = useApi<ManageableResponse>(session?.user ? "/channels/manageable" : null);
  const [query, setQuery] = useState("");
  const [modal, setModal] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  const canManage = useMemo(
    () => new Set(managed.data?.channels.filter((c) => c.canManage).map((c) => c.id) ?? []),
    [managed.data],
  );

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^#/, "");
    return (subs.data ?? []).filter(
      (s) =>
        !q ||
        [s.sourceName, s.subscriberName, s.sourceChannelId, s.subscriberChannelId].some((v) =>
          v.toLowerCase().includes(q),
        ),
    );
  }, [subs.data, query]);

  const sourceCount = new Set(subs.data?.map((s) => s.sourceChannelId)).size;
  const subscriberCount = new Set(subs.data?.map((s) => s.subscriberChannelId)).size;

  async function remove(s: SubscriptionRow) {
    const ok = await confirm({
      title: "Remove subscription?",
      description: `#${s.subscriberName || s.subscriberChannelId} will stop receiving messages from #${s.sourceName || s.sourceChannelId}.`,
      action: "Remove",
    });
    if (!ok) return;
    const key = `${s.sourceChannelId}:${s.subscriberChannelId}`;
    setBusy(key);
    try {
      await api("/subscriptions", {
        method: "DELETE",
        body: { sourceChannelId: s.sourceChannelId, subscriberChannelId: s.subscriberChannelId },
      });
      toast("Subscription removed");
      subs.reload();
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Pub/sub"
        description="Subscriptions forward approved messages from a publishing channel into subscriber channels, optionally under a custom name and avatar."
        actions={
          session?.user ? (
            <button className="btn btn-primary" onClick={() => setModal(true)}>
              <Icon name="plus" /> New subscription
            </button>
          ) : (
            <button className="btn" onClick={() => signIn()}>
              Sign in to manage
            </button>
          )
        }
      />

      <div className="grid-3" style={{ marginBottom: 28 }}>
        <div className="card stat">
          <div className="stat-label">
            <Icon name="radio" size={15} /> Subscriptions
          </div>
          <div className="stat-value">{subs.data ? subs.data.length : <Skeleton w={40} h={28} />}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">
            <Icon name="hash" size={15} /> Publishers
          </div>
          <div className="stat-value">{subs.data ? sourceCount : <Skeleton w={40} h={28} />}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">
            <Icon name="users" size={15} /> Subscribers
          </div>
          <div className="stat-value">{subs.data ? subscriberCount : <Skeleton w={40} h={28} />}</div>
        </div>
      </div>

      <div className="toolbar">
        <div className="search-input">
          <Icon name="search" />
          <input
            className="input"
            placeholder="Filter by channel…"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
      </div>

      <div className="card">
        {subs.error && (
          <div className="card-body">
            <Notice tone="danger" icon="alert">{subs.error}</Notice>
          </div>
        )}
        {!subs.data && !subs.error && (
          <div className="card-body stack-sm">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} h={36} />
            ))}
          </div>
        )}
        {subs.data && rows.length === 0 && (
          <Empty
            icon="radio"
            title={query ? "No matching subscriptions" : "No subscriptions yet"}
            action={
              session?.user && !query ? (
                <button className="btn btn-primary" onClick={() => setModal(true)}>
                  <Icon name="plus" /> New subscription
                </button>
              ) : undefined
            }
          >
            {query ? "Try a different filter." : "Connect two channels so one forwards into the other."}
          </Empty>
        )}
        {rows.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th />
                  <th>Subscriber</th>
                  <th className="hide-md">Display as</th>
                  <th className="hide-md">Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const key = `${s.sourceChannelId}:${s.subscriberChannelId}`;
                  return (
                    <tr key={key}>
                      <td>
                        <a className="slack-pill" href={channelPageUrl(s.sourceChannelId)}>
                          #{s.sourceName || s.sourceChannelId}
                        </a>
                      </td>
                      <td className="muted" style={{ width: 32, paddingLeft: 0, paddingRight: 0 }}>
                        <Icon name="arrowRight" />
                      </td>
                      <td>
                        <a className="slack-pill" href={channelPageUrl(s.subscriberChannelId)}>
                          #{s.subscriberName || s.subscriberChannelId}
                        </a>
                      </td>
                      <td className="hide-md text-2">
                        {s.profileName || s.profileImageUrl ? (
                          <span className="row" style={{ gap: 8 }}>
                            {s.profileImageUrl && !s.profileImageUrl.startsWith("[") && (
                              <img className="avatar sm" src={s.profileImageUrl} alt="" />
                            )}
                            {s.profileName || <span className="muted">custom avatar</span>}
                          </span>
                        ) : (
                          <span className="muted">Original author</span>
                        )}
                      </td>
                      <td className="hide-md muted">{fmtDate(s.createdAt)}</td>
                      <td className="right">
                        <div className="row" style={{ justifyContent: "flex-end", gap: 6, flexWrap: "nowrap" }}>
                          <a className="btn btn-sm btn-ghost" href={`${channelPageUrl(s.subscriberChannelId)}#pubsub`}>
                            Configure
                          </a>
                          {canManage.has(s.subscriberChannelId) && (
                            <button
                              className="btn btn-sm btn-danger"
                              disabled={busy === key}
                              onClick={() => remove(s)}
                              aria-label="Remove subscription"
                            >
                              <Icon name="trash" size={14} />
                            </button>
                          )}
                        </div>
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
        <NewSubscriptionModal
          open={modal}
          onClose={() => setModal(false)}
          managed={managed.data}
          onCreated={subs.reload}
        />
      )}
      {dialog}
    </>
  );
}

renderPage("subscriptions", <SubscriptionsPage />, {
  crumbs: [{ label: "Build", href: "/" }, { label: "Pub/sub" }],
});
