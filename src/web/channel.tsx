import { useEffect, useMemo, useState, type ReactNode } from "react";
import { renderPage } from "./layout";
import { authClient } from "../lib/auth-client";
import { signIn } from "./shell";
import {
  CopyField,
  Empty,
  Icon,
  Modal,
  Notice,
  PageHeader,
  Skeleton,
  Spinner,
  StatusBadge,
  Switch,
  UserChip,
  UserListInput,
  api,
  accessLabel,
  approvalMode,
  channelPageUrl,
  fmtDate,
  slackChannelUrl,
  useApi,
  useSlackUsers,
  useToast,
  useConfirm,
  type Channel,
  type SubscriptionRow,
} from "./ui";

const channelId = new URLSearchParams(location.search).get("id") || "";
const TABS = ["overview", "settings", "access", "webhook", "metadata", "pubsub", "danger"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  overview: "Overview",
  settings: "Publishing",
  access: "Access",
  webhook: "Webhook",
  metadata: "Metadata & properties",
  pubsub: "Pub/sub",
  danger: "Danger zone",
};

type Patch = Partial<
  Pick<
    Channel,
    | "enabled"
    | "linkMode"
    | "trackReplies"
    | "triggerMode"
    | "webhookUrl"
    | "autoApproveUsers"
    | "manualUsers"
    | "approvedPosters"
    | "accessPermUsers"
    | "metadataSchema"
    | "metadataRequired"
    | "properties"
    | "staticMetadata"
  >
>;

interface Ctx {
  ch: Channel;
  canManage: boolean;
  save: (patch: Patch, msg?: string) => Promise<boolean>;
}

/** A settings card with its own draft and a Save footer, Cloudflare-style. */
function SectionCard<T>({
  title,
  description,
  initial,
  canManage,
  onSave,
  children,
  footerNote,
}: {
  title: string;
  description?: ReactNode;
  initial: T;
  canManage: boolean;
  onSave: (draft: T) => Promise<boolean>;
  children: (draft: T, set: (next: T) => void) => ReactNode;
  footerNote?: ReactNode;
}) {
  const [draft, setDraft] = useState<T>(initial);
  const [busy, setBusy] = useState(false);
  const initialKey = JSON.stringify(initial);
  useEffect(() => setDraft(initial), [initialKey]);
  const dirty = JSON.stringify(draft) !== initialKey;
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3>{title}</h3>
          {description && <p>{description}</p>}
        </div>
      </div>
      <div>{children(draft, setDraft)}</div>
      {canManage && (
        <div className="card-footer">
          <span>{footerNote}</span>
          <div className="actions">
            {dirty && (
              <button className="btn btn-ghost btn-sm" onClick={() => setDraft(initial)} disabled={busy}>
                Reset
              </button>
            )}
            <button
              className="btn btn-primary btn-sm"
              disabled={!dirty || busy}
              onClick={async () => {
                setBusy(true);
                await onSave(draft);
                setBusy(false);
              }}
            >
              {busy && <Spinner />} Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Setting({
  title,
  children,
  control,
  stacked,
}: {
  title: string;
  children?: ReactNode;
  control: ReactNode;
  stacked?: boolean;
}) {
  return (
    <div className={"setting" + (stacked ? " stacked" : "")}>
      <div className="setting-text">
        <strong>{title}</strong>
        {children && <p>{children}</p>}
      </div>
      <div className="setting-control">{control}</div>
    </div>
  );
}

// --- Tabs --------------------------------------------------------------------

function OverviewTab({ ch, subs }: Ctx & { subs: SubscriptionRow[] | null }) {
  const origin = location.origin;
  const inbound = subs?.filter((s) => s.subscriberChannelId === ch.id) ?? [];
  const outbound = subs?.filter((s) => s.sourceChannelId === ch.id) ?? [];
  const users = useSlackUsers([...ch.approvedPosters, ...ch.autoApproveUsers, ...ch.manualUsers]);
  return (
    <div className="stack">
      <div className="card">
        <div className="card-header">
          <div>
            <h3>Feeds</h3>
            <p>
              Endpoints serving this channel's approved messages.
              {!ch.accessPermUsers.includes("*") && " Restricted — callers need a session or API key."}
            </p>
          </div>
          <a className="btn btn-sm" href="/keys.html">
            <Icon name="key" size={14} /> API keys
          </a>
        </div>
        <div className="card-body stack-sm">
          {!ch.enabled && (
            <Notice tone="warn" icon="alert">
              This channel isn't pub'd, so its feeds won't receive new messages.
            </Notice>
          )}
          <div className="field">
            <span className="field-label">RSS</span>
            <CopyField value={`${origin}/feed/${ch.id}`} />
          </div>
          <div className="field">
            <span className="field-label">JSON Feed</span>
            <CopyField value={`${origin}/feed/${ch.id}.json`} />
          </div>
          <div className="field">
            <span className="field-label">REST API</span>
            <CopyField value={`${origin}/api/messages?channel=${ch.id}`} />
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <h3>Summary</h3>
          </div>
          <dl className="kv">
            <dt>Status</dt>
            <dd>
              <StatusBadge enabled={ch.enabled} />
            </dd>
            <dt>Approval</dt>
            <dd>{approvalMode(ch)}</dd>
            <dt>Approvers</dt>
            <dd>
              <div className="row" style={{ gap: 6 }}>
                {ch.approvedPosters.length === 0 ? (
                  <span className="text-2">Poster + channel managers</span>
                ) : (
                  ch.approvedPosters.map((id) => <UserChip key={id} id={id} user={users.get(id)} />)
                )}
              </div>
            </dd>
            <dt>Feed access</dt>
            <dd>{accessLabel(ch)}</dd>
            <dt>Webhook</dt>
            <dd className="mono small">{ch.webhookUrl || <span className="muted">none</span>}</dd>
            <dt>Created</dt>
            <dd>{fmtDate(ch.createdAt)}</dd>
          </dl>
        </div>
        <div className="card">
          <div className="card-header">
            <h3>Pub/sub</h3>
          </div>
          <dl className="kv">
            <dt>Forwards to</dt>
            <dd>
              <div className="row" style={{ gap: 6 }}>
                {outbound.length === 0 && <span className="muted">no subscribers</span>}
                {outbound.map((s) => (
                  <a key={s.subscriberChannelId} className="slack-pill" href={channelPageUrl(s.subscriberChannelId)}>
                    #{s.subscriberName || s.subscriberChannelId}
                  </a>
                ))}
              </div>
            </dd>
            <dt>Receives from</dt>
            <dd>
              <div className="row" style={{ gap: 6 }}>
                {inbound.length === 0 && <span className="muted">no sources</span>}
                {inbound.map((s) => (
                  <a key={s.sourceChannelId} className="slack-pill" href={channelPageUrl(s.sourceChannelId)}>
                    #{s.sourceName || s.sourceChannelId}
                  </a>
                ))}
              </div>
            </dd>
            <dt>Link mode</dt>
            <dd>{ch.linkMode ? "On" : "Off"}</dd>
            <dt>Thread replies</dt>
            <dd>{ch.trackReplies ? "Tracked" : "Ignored"}</dd>
          </dl>
        </div>
      </div>
    </div>
  );
}

type ApprovalKind = "prompt" | "auto" | "manual";
function approvalKind(ch: Pick<Channel, "autoApproveUsers" | "manualUsers">): ApprovalKind {
  if (ch.autoApproveUsers.includes("*")) return "auto";
  if (ch.manualUsers.length > 0) return "manual";
  return "prompt";
}

function SettingsTab({ ch, canManage, save }: Ctx) {
  const d = !canManage;
  return (
    <div className="stack">
      <SectionCard
        title="Publishing"
        description="How messages in this channel make it into the feed."
        canManage={canManage}
        initial={{ linkMode: ch.linkMode, trackReplies: ch.trackReplies, triggerMode: ch.triggerMode }}
        onSave={(draft) => save(draft, "Publishing settings saved")}
      >
        {(v, set) => (
          <>
            <Setting
              title="Trigger"
              stacked
              control={
                <div className="radio-cards">
                  {(
                    [
                      ["message", "Every message", "Each new message is handled by the approval rules below."],
                      ["shortcut", "Shortcut only", "Only messages added via the “Add to feed” message shortcut."],
                    ] as const
                  ).map(([mode, label, desc]) => (
                    <button
                      key={mode}
                      type="button"
                      disabled={d}
                      className={"radio-card" + (v.triggerMode === mode ? " active" : "")}
                      onClick={() => set({ ...v, triggerMode: mode })}
                    >
                      <strong>{label}</strong>
                      <span>{desc}</span>
                    </button>
                  ))}
                </div>
              }
            >
              Choose what makes a message eligible for publishing.
            </Setting>
            <Setting
              title="Link mode"
              control={
                <Switch label="Link mode" checked={v.linkMode} disabled={d} onChange={(linkMode) => set({ ...v, linkMode })} />
              }
            >
              Reply to approved messages with an unfurlable permalink, and add a “Forwarded from…” footer in
              subscriber channels.
            </Setting>
            <Setting
              title="Track thread replies"
              control={
                <Switch
                  label="Track thread replies"
                  checked={v.trackReplies}
                  disabled={d}
                  onChange={(trackReplies) => set({ ...v, trackReplies })}
                />
              }
            >
              Store replies in threads and keep their parent relationship in the feed.
            </Setting>
          </>
        )}
      </SectionCard>

      <SectionCard
        title="Approval"
        description="Who gets prompted, and whose posts skip the prompt."
        canManage={canManage}
        initial={{
          kind: approvalKind(ch),
          autoApproveUsers: ch.autoApproveUsers.filter((u) => u !== "*"),
          manualUsers: ch.manualUsers.filter((u) => u !== "*"),
          approvedPosters: ch.approvedPosters,
        }}
        onSave={(v) =>
          save(
            {
              autoApproveUsers: v.kind === "auto" ? ["*"] : v.kind === "prompt" ? v.autoApproveUsers : [],
              manualUsers: v.kind === "manual" ? v.manualUsers : [],
              approvedPosters: v.approvedPosters,
            },
            "Approval settings saved",
          )
        }
      >
        {(v, set) => (
          <>
            <Setting
              title="Mode"
              stacked
              control={
                <div className="radio-cards">
                  {(
                    [
                      ["prompt", "Prompt", "Every message gets a Yep!/No prompt, except auto-approved users."],
                      ["auto", "Auto-approve all", "Every message is published without a prompt."],
                      ["manual", "Selected users only", "Only listed users get a prompt; others aren't published."],
                    ] as const
                  ).map(([kind, label, desc]) => (
                    <button
                      key={kind}
                      type="button"
                      disabled={d}
                      className={"radio-card" + (v.kind === kind ? " active" : "")}
                      onClick={() => set({ ...v, kind })}
                    >
                      <strong>{label}</strong>
                      <span>{desc}</span>
                    </button>
                  ))}
                </div>
              }
            />
            {v.kind === "prompt" && (
              <Setting
                title="Auto-approved users"
                stacked
                control={
                  <UserListInput
                    value={v.autoApproveUsers}
                    disabled={d}
                    onChange={(autoApproveUsers) => set({ ...v, autoApproveUsers })}
                  />
                }
              >
                These users' messages are published without a prompt.
              </Setting>
            )}
            {v.kind === "manual" && (
              <Setting
                title="Prompted users"
                stacked
                control={
                  <UserListInput value={v.manualUsers} disabled={d} onChange={(manualUsers) => set({ ...v, manualUsers })} />
                }
              >
                Only these users' messages get a Yep!/No prompt.
              </Setting>
            )}
            <Setting
              title="Approvers"
              stacked
              control={
                <div className="stack-sm" style={{ width: "100%" }}>
                  <label className="row small text-2" style={{ cursor: d ? "default" : "pointer" }}>
                    <Switch
                      label="Original poster can approve"
                      checked={v.approvedPosters.includes("poster")}
                      disabled={d}
                      onChange={(on) =>
                        set({
                          ...v,
                          approvedPosters: on
                            ? ["poster", ...v.approvedPosters]
                            : v.approvedPosters.filter((p) => p !== "poster"),
                        })
                      }
                    />
                    Let each message's author approve their own message
                  </label>
                  <UserListInput
                    value={v.approvedPosters.filter((p) => p !== "poster")}
                    disabled={d}
                    onChange={(ids) =>
                      set({
                        ...v,
                        approvedPosters: v.approvedPosters.includes("poster") ? ["poster", ...ids] : ids,
                      })
                    }
                  />
                </div>
              }
            >
              Who can press Yep!/No. Leave empty for the default: the poster and channel managers.
            </Setting>
          </>
        )}
      </SectionCard>
    </div>
  );
}

function AccessTab({ ch, canManage, save }: Ctx) {
  return (
    <SectionCard
      title="Feed access"
      description="Who can read this channel's RSS, JSON, and API feeds."
      canManage={canManage}
      initial={{
        open: ch.accessPermUsers.includes("*"),
        users: ch.accessPermUsers.filter((u) => u !== "*"),
      }}
      onSave={(v) => save({ accessPermUsers: v.open ? ["*"] : v.users }, "Access updated")}
      footerNote="API keys scoped to this channel always follow these rules."
    >
      {(v, set) => (
        <>
          <Setting
            title="Visibility"
            stacked
            control={
              <div className="radio-cards">
                <button
                  type="button"
                  disabled={!canManage}
                  className={"radio-card" + (v.open ? " active" : "")}
                  onClick={() => set({ ...v, open: true })}
                >
                  <strong>
                    <Icon name="rss" size={14} /> Public
                  </strong>
                  <span>Anyone with the URL can read the feed.</span>
                </button>
                <button
                  type="button"
                  disabled={!canManage}
                  className={"radio-card" + (!v.open ? " active" : "")}
                  onClick={() => set({ ...v, open: false })}
                >
                  <strong>
                    <Icon name="lock" size={14} /> Restricted
                  </strong>
                  <span>Only listed users, signed in or via their API keys.</span>
                </button>
              </div>
            }
          />
          {!v.open && (
            <Setting
              title="Allowed users"
              stacked
              control={<UserListInput value={v.users} disabled={!canManage} onChange={(users) => set({ ...v, users })} />}
            >
              Slack users who can read the feed.
            </Setting>
          )}
        </>
      )}
    </SectionCard>
  );
}

function WebhookTab({ ch, canManage, save }: Ctx) {
  return (
    <SectionCard
      title="Webhook"
      description="POST every newly approved message to a URL as JSON."
      canManage={canManage}
      initial={{ url: ch.webhookUrl }}
      onSave={(v) => save({ webhookUrl: v.url.trim() }, v.url.trim() ? "Webhook saved" : "Webhook removed")}
      footerNote="Leave blank to disable."
    >
      {(v, set) => (
        <div className="card-body">
          <div className="field">
            <label className="field-label" htmlFor="wh">
              Endpoint URL
            </label>
            <input
              id="wh"
              className="input mono"
              placeholder="https://example.com/hooks/indigest"
              value={v.url}
              disabled={!canManage}
              onChange={(e) => set({ url: e.currentTarget.value })}
            />
            {v.url && !/^https?:\/\//.test(v.url.trim()) && (
              <span className="field-error">Must start with http:// or https://</span>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
}

function prettyJson(raw: string, fallback: string) {
  if (!raw || raw === "{}") return fallback;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function jsonError(raw: string, kind: "schema" | "props"): string | null {
  if (!raw.trim()) return null;
  try {
    const v = JSON.parse(raw);
    if (kind === "schema" && !Array.isArray(v?.fields)) return "Schema needs a `fields` array.";
    if (kind === "props" && (!v || typeof v !== "object" || Array.isArray(v))) return "Properties must be a JSON object.";
    return null;
  } catch (e: any) {
    return e.message;
  }
}

function MetadataTab({ ch, canManage, save }: Ctx) {
  return (
    <div className="stack">
      <SectionCard
        title="Metadata schema"
        description="Fields approvers fill in when publishing, shown as a Slack modal."
        canManage={canManage}
        initial={{ schema: prettyJson(ch.metadataSchema, ""), required: ch.metadataRequired }}
        onSave={(v) =>
          jsonError(v.schema, "schema")
            ? Promise.resolve(false)
            : save({ metadataSchema: v.schema.trim(), metadataRequired: v.required }, "Metadata schema saved")
        }
      >
        {(v, set) => {
          const err = jsonError(v.schema, "schema");
          return (
            <>
              <div className="card-body">
                <div className="field">
                  <textarea
                    className="textarea"
                    rows={10}
                    spellCheck={false}
                    disabled={!canManage}
                    placeholder={'{\n  "title": "Metadata",\n  "fields": [\n    { "action_id": "title", "label": "Title", "type": "plain_text_input" }\n  ]\n}'}
                    value={v.schema}
                    onChange={(e) => set({ ...v, schema: e.currentTarget.value })}
                  />
                  {err && <span className="field-error">{err}</span>}
                </div>
              </div>
              <Setting
                title="Require metadata"
                control={
                  <Switch
                    label="Require metadata"
                    checked={v.required}
                    disabled={!canManage || !v.schema.trim()}
                    onChange={(required) => set({ ...v, required })}
                  />
                }
              >
                Messages can't be published until the metadata is filled in.
              </Setting>
            </>
          );
        }}
      </SectionCard>

      <SectionCard
        title="Static metadata"
        description="Bold lines shown above every forward. For auto-publishing channels that never open the metadata modal."
        canManage={canManage}
        initial={{ text: ch.staticMetadata }}
        onSave={(v) => save({ staticMetadata: v.text.trim() }, "Static metadata saved")}
      >
        {(v, set) => (
          <div className="card-body">
            <div className="field">
              <textarea
                className="textarea"
                rows={3}
                spellCheck={false}
                disabled={!canManage}
                placeholder={"New Edition of Happenings!"}
                maxLength={2000}
                value={v.text}
                onChange={(e) => set({ text: e.currentTarget.value })}
              />
              <span className="field-hint">One line per row. Each line is rendered bold.</span>
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Channel properties"
        description="Static key/value pairs subscribers can reference as [property] in profile overrides."
        canManage={canManage}
        initial={{ props: prettyJson(ch.properties, "") }}
        onSave={(v) =>
          jsonError(v.props, "props") ? Promise.resolve(false) : save({ properties: v.props.trim() }, "Properties saved")
        }
      >
        {(v, set) => {
          const err = jsonError(v.props, "props");
          return (
            <div className="card-body">
              <div className="field">
                <textarea
                  className="textarea"
                  rows={6}
                  spellCheck={false}
                  disabled={!canManage}
                  placeholder={'{\n  "title": "Hack Club",\n  "icon": "https://…/icon.png"\n}'}
                  value={v.props}
                  onChange={(e) => set({ props: e.currentTarget.value })}
                />
                {err && <span className="field-error">{err}</span>}
              </div>
            </div>
          );
        }}
      </SectionCard>
    </div>
  );
}

function OverrideModal({
  sub,
  onClose,
  onSaved,
}: {
  sub: SubscriptionRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setName(sub?.profileName || "");
    setImage(sub?.profileImageUrl || "");
    setErr(null);
  }, [sub]);
  return (
    <Modal
      open={!!sub}
      onClose={onClose}
      title="Forwarding profile"
      description={sub ? `How forwards from #${sub.sourceName || sub.sourceChannelId} appear here.` : undefined}
    >
      <form
        className="stack"
        style={{ gap: 20 }}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!sub) return;
          setBusy(true);
          try {
            await api("/subscriptions", {
              method: "PATCH",
              body: {
                subscriberChannelId: sub.subscriberChannelId,
                sourceChannelId: sub.sourceChannelId,
                profileName: name,
                profileImageUrl: image,
              },
            });
            toast("Profile override saved");
            onSaved();
            onClose();
          } catch (e: any) {
            setErr(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="field">
          <label className="field-label">Bot username</label>
          <input className="input" value={name} placeholder="Original author" onChange={(e) => setName(e.currentTarget.value)} />
          <span className="field-hint">Static text, or [property] from the source channel's properties.</span>
        </div>
        <div className="field">
          <label className="field-label">Profile picture</label>
          <input
            className="input mono"
            value={image}
            placeholder="https://… or [icon]"
            onChange={(e) => setImage(e.currentTarget.value)}
          />
          <span className="field-hint">Leave a field blank to show the original author.</span>
        </div>
        {err && <Notice tone="danger" icon="alert">{err}</Notice>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {busy && <Spinner />} Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PubSubTab({
  ch,
  canManage,
  subs,
  reloadSubs,
}: Ctx & { subs: SubscriptionRow[] | null; reloadSubs: () => void }) {
  const toast = useToast();
  const sources = useApi<Channel[]>(canManage ? "/channels?enabled=true" : null);
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<SubscriptionRow | null>(null);
  const { confirm, dialog } = useConfirm();
  const inbound = subs?.filter((s) => s.subscriberChannelId === ch.id) ?? null;
  const outbound = subs?.filter((s) => s.sourceChannelId === ch.id) ?? null;
  const available = (sources.data ?? []).filter(
    (s) => s.enabled && s.id !== ch.id && !inbound?.some((i) => i.sourceChannelId === s.id),
  );

  async function add() {
    if (!adding) return;
    setBusy("add");
    try {
      await api("/subscriptions", {
        method: "POST",
        body: { subscriberChannelId: ch.id, sourceChannelId: adding },
      });
      toast("Subscribed");
      setAdding("");
      reloadSubs();
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(null);
    }
  }
  async function remove(s: SubscriptionRow) {
    const ok = await confirm({
      title: `Unsubscribe from #${s.sourceName || s.sourceChannelId}?`,
      description: `Its approved messages will stop being forwarded to #${ch.name || ch.id}.`,
      action: "Unsubscribe",
    });
    if (!ok) return;
    setBusy(s.sourceChannelId);
    try {
      await api("/subscriptions", {
        method: "DELETE",
        body: { subscriberChannelId: s.subscriberChannelId, sourceChannelId: s.sourceChannelId },
      });
      toast(`Unsubscribed from #${s.sourceName || s.sourceChannelId}`);
      reloadSubs();
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="card-header">
          <div>
            <h3>Subscriptions</h3>
            <p>Channels whose approved messages are forwarded into #{ch.name || ch.id}.</p>
          </div>
        </div>
        {canManage && (
          <div className="card-body" style={{ borderBottom: "1px solid var(--border)" }}>
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <select className="select" value={adding} onChange={(e) => setAdding(e.currentTarget.value)}>
                <option value="">{sources.loading ? "Loading channels…" : "Subscribe to a pub'd channel…"}</option>
                {available.map((s) => (
                  <option key={s.id} value={s.id}>
                    #{s.name || s.id}
                  </option>
                ))}
              </select>
              <button className="btn btn-primary" disabled={!adding || busy === "add"} onClick={add}>
                {busy === "add" ? <Spinner /> : <Icon name="plus" />} Subscribe
              </button>
            </div>
          </div>
        )}
        {inbound === null ? (
          <div className="card-body">
            <Skeleton h={32} />
          </div>
        ) : inbound.length === 0 ? (
          <Empty icon="radio" title="No subscriptions">
            This channel doesn't receive forwards from anywhere yet.
          </Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Source</th>
                <th className="hide-md">Display as</th>
                <th className="hide-md">Since</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {inbound.map((s) => (
                <tr key={s.sourceChannelId}>
                  <td>
                    <a className="slack-pill" href={channelPageUrl(s.sourceChannelId)}>
                      #{s.sourceName || s.sourceChannelId}
                    </a>
                  </td>
                  <td className="hide-md text-2">
                    {s.profileName || s.profileImageUrl ? (
                      <span className="row" style={{ gap: 8 }}>
                        {s.profileImageUrl && !s.profileImageUrl.startsWith("[") && (
                          <img className="avatar sm" src={s.profileImageUrl} alt="" />
                        )}
                        {s.profileName || <span className="muted">original name</span>}
                      </span>
                    ) : (
                      <span className="muted">Original author</span>
                    )}
                  </td>
                  <td className="hide-md muted">{fmtDate(s.createdAt)}</td>
                  <td className="right">
                    {canManage && (
                      <div className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
                        <button className="btn btn-sm" onClick={() => setEditing(s)}>
                          <Icon name="edit" size={14} /> Profile
                        </button>
                        <button
                          className="btn btn-sm btn-danger"
                          disabled={busy === s.sourceChannelId}
                          onClick={() => remove(s)}
                        >
                          Unsubscribe
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <h3>Subscribers</h3>
            <p>Channels that receive this channel's approved messages.</p>
          </div>
        </div>
        {outbound === null ? (
          <div className="card-body">
            <Skeleton h={32} />
          </div>
        ) : outbound.length === 0 ? (
          <Empty icon="users" title="No subscribers">
            {ch.enabled
              ? "Other channels can subscribe from their own Pub/sub tab or with /in sub."
              : "Pub this channel so others can subscribe to it."}
          </Empty>
        ) : (
          <table className="table">
            <tbody>
              {outbound.map((s) => (
                <tr key={s.subscriberChannelId} className="clickable" onClick={() => (location.href = channelPageUrl(s.subscriberChannelId))}>
                  <td>
                    <div className="cell-title">
                      <span className="channel-glyph">#</span>
                      {s.subscriberName || s.subscriberChannelId}
                    </div>
                  </td>
                  <td className="hide-md muted">since {fmtDate(s.createdAt)}</td>
                  <td className="right">
                    <Icon name="chevronRight" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <OverrideModal sub={editing} onClose={() => setEditing(null)} onSaved={reloadSubs} />
      {dialog}
    </div>
  );
}

function DangerTab({ ch, canManage, save }: Ctx) {
  const [confirm, setConfirm] = useState(false);
  const [typed, setTyped] = useState("");
  const name = ch.name || ch.id;
  return (
    <div className="card danger">
      <div className="card-header">
        <div>
          <h3>{ch.enabled ? "Unpub channel" : "Pub channel"}</h3>
          <p>
            {ch.enabled
              ? "Stop collecting new messages. Existing feed items and subscriptions stay."
              : "Resume collecting approved messages from this channel."}
          </p>
        </div>
      </div>
      <div className="card-footer">
        <span>Same as running /in {ch.enabled ? "unpub" : "pub"} in #{name}.</span>
        <div className="actions">
          {ch.enabled ? (
            <button className="btn btn-danger btn-sm" disabled={!canManage} onClick={() => setConfirm(true)}>
              Unpub #{name}
            </button>
          ) : (
            <button
              className="btn btn-primary btn-sm"
              disabled={!canManage}
              onClick={() => save({ enabled: true }, `#${name} pub'd`)}
            >
              Pub #{name}
            </button>
          )}
        </div>
      </div>
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Unpub #${name}?`}
        description="New messages will stop flowing to its feeds, webhook, and subscribers."
      >
        <div className="field">
          <label className="field-label">
            Type <code className="mono">{name}</code> to confirm
          </label>
          <input className="input mono" value={typed} onChange={(e) => setTyped(e.currentTarget.value)} autoFocus />
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => setConfirm(false)}>
            Cancel
          </button>
          <button
            className="btn btn-danger"
            disabled={typed !== name}
            onClick={async () => {
              if (await save({ enabled: false }, `#${name} unpub'd`)) setConfirm(false);
            }}
          >
            Unpub channel
          </button>
        </div>
      </Modal>
    </div>
  );
}

// --- Page --------------------------------------------------------------------

function ChannelPage() {
  const toast = useToast();
  const { data: session } = authClient.useSession();
  const channel = useApi<Channel>(channelId ? `/channels/${encodeURIComponent(channelId)}` : null);
  const perms = useApi<{ canManage: boolean; lockdown: boolean }>(
    session?.user && channelId ? `/channels/${encodeURIComponent(channelId)}/permissions` : null,
  );
  const subs = useApi<SubscriptionRow[]>("/subscriptions/all");
  const [tab, setTab] = useState<Tab>(() => {
    const h = location.hash.slice(1) as Tab;
    return TABS.includes(h) ? h : "overview";
  });
  useEffect(() => {
    history.replaceState(null, "", tab === "overview" ? location.pathname + location.search : `#${tab}`);
  }, [tab]);
  useEffect(() => {
    if (channel.data) document.title = `#${channel.data.name || channel.data.id} · indigest`;
  }, [channel.data]);

  const canManage = !!perms.data?.canManage;
  const ch = channel.data;

  const save = useMemo(
    () => async (patch: Patch, msg = "Saved") => {
      try {
        const next = await api<Channel>(`/channels/${encodeURIComponent(channelId)}`, {
          method: "PATCH",
          body: patch,
        });
        channel.setData(next);
        toast(msg);
        return true;
      } catch (e: any) {
        toast(e.message, "error");
        return false;
      }
    },
    [channel.setData, toast],
  );

  if (!channelId)
    return <Empty icon="hash" title="No channel selected" action={<a className="btn" href="/channels.html">Back to channels</a>} />;
  if (channel.error)
    return (
      <Empty icon="alert" title="Channel not found" action={<a className="btn" href="/channels.html">Back to channels</a>}>
        {channel.error}
      </Empty>
    );
  if (!ch)
    return (
      <div className="stack">
        <Skeleton w={280} h={34} />
        <Skeleton h={220} />
      </div>
    );

  const ctx: Ctx = { ch, canManage, save };

  return (
    <>
      <PageHeader
        eyebrow={
          <>
            <StatusBadge enabled={ch.enabled} />
            <span className="id-chip">{ch.id}</span>
            {canManage && <span className="badge outline">You manage this</span>}
          </>
        }
        title={`#${ch.name || ch.id}`}
        actions={
          <>
            <a className="btn" href={slackChannelUrl(ch.id)} target="_blank" rel="noopener">
              <Icon name="slack" /> Open in Slack
            </a>
            <a className="btn" href={`/feed/${ch.id}`} target="_blank" rel="noopener">
              <Icon name="rss" /> RSS
            </a>
          </>
        }
      />

      {!session?.user ? (
        <div style={{ marginBottom: 24 }}>
          <Notice icon="lock">
            <strong>Read-only.</strong>{" "}
            <a href="#" onClick={(e) => (e.preventDefault(), signIn())}>
              Sign in
            </a>{" "}
            to manage this channel.
          </Notice>
        </div>
      ) : (
        perms.data &&
        !canManage && (
          <div style={{ marginBottom: 24 }}>
            <Notice icon="lock">
              <strong>Read-only.</strong>{" "}
              {perms.data.lockdown
                ? "Lockdown mode is on, so only authorized users can change channel settings."
                : "Only the channel's creator or a workspace admin can change these settings."}
            </Notice>
          </div>
        )
      )}

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {tab === "overview" && <OverviewTab {...ctx} subs={subs.data} />}
      {tab === "settings" && <SettingsTab {...ctx} />}
      {tab === "access" && <AccessTab {...ctx} />}
      {tab === "webhook" && <WebhookTab {...ctx} />}
      {tab === "metadata" && <MetadataTab {...ctx} />}
      {tab === "pubsub" && <PubSubTab {...ctx} subs={subs.data} reloadSubs={subs.reload} />}
      {tab === "danger" && <DangerTab {...ctx} />}
    </>
  );
}

renderPage("channels", <ChannelPage />, {
  crumbs: [
    { label: "Channels", href: "/channels.html" },
    { label: channelId || "Channel" },
  ],
});
