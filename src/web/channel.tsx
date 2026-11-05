import { useEffect, useMemo, useState, type ReactNode } from "react";
import { renderPage } from "./layout";
import { authClient } from "../lib/auth-client";
import { signIn } from "./shell";
import { describeTemplateError, parseTemplate, renderTemplate, safe } from "../lib/template";
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
    | "forwardFormat"
    | "forwardFormatLocked"
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
        description={`Fields approvers fill in when publishing, shown as a Slack modal. A field with action_id "agreement" stays on this channel and is left out of forwards.`}
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

const FORMAT_EXAMPLES: { label: string; format: string }[] = [
  {
    label: "Headline",
    format: "{% if meta.title %}*{{ meta.title }}*\n{% endif %}{{ text }}",
  },
  {
    label: "Byline",
    format: '*{{ meta.title | default: "New post" }}*\n_by {{ author }} in {{ channel.mention }}_\n\n{{ text }}',
  },
  {
    label: "Every field",
    format: "{{ text }}\n{% for f in fields %}\n• *{{ f.label }}:* {{ f.value }}{% endfor %}",
  },
  {
    label: "Teaser",
    format:
      '{% if meta.priority == "high" %}:rotating_light: {% endif %}*{{ meta.title | default: "New post" }}*\n' +
      "{{ text | truncate: 280 }}\n{{ link | link: \"Read more\" }}",
  },
];

// Sample values shaped like each field's type, for the live preview.
function sampleFormatContext(source: Channel | null | undefined) {
  let fields: any[] = [];
  try {
    fields = JSON.parse(source?.metadataSchema || "{}")?.fields ?? [];
  } catch {}
  const meta: Record<string, unknown> = {};
  for (const f of fields) {
    if (!f?.action_id || f.action_id === "agreement") continue;
    const options = (f.options ?? []).map((o: any) => o?.value).filter(Boolean);
    meta[f.action_id] =
      f.type === "multi_static_select"
        ? options.slice(0, 2)
        : f.type === "static_select"
          ? options[0] ?? "option"
          : f.type === "datepicker"
            ? new Date().toISOString().slice(0, 10)
            : f.type === "number_input"
              ? "3"
              : f.type === "url_text_input"
                ? "https://hackclub.com"
                : `Sample ${(f.label || f.action_id).toLowerCase()}`;
  }
  let props: Record<string, unknown> = {};
  try {
    props = JSON.parse(source?.properties || "{}") ?? {};
  } catch {}
  const name = source?.name || "source";
  return {
    text: safe("This is the original message, with *formatting* and <https://hackclub.com|a link>."),
    author: "Orpheus",
    channel: { id: source?.id || "C0", name, mention: safe(`<#${source?.id || "C0"}|${name}>`) },
    link: "https://hackclub.slack.com/archives/C0/p1",
    permalink: "https://hackclub.slack.com/archives/C0/p1",
    date: new Date().toISOString(),
    meta,
    fields: Object.entries(meta).map(([id, value]) => ({
      id,
      label: fields.find((f) => f?.action_id === id)?.label || id,
      value,
    })),
    props,
    static: safe(""),
  };
}

const unescapeMrkdwn = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// A rough Slack mrkdwn preview, built from React text nodes only.
function MrkdwnPreview({ text }: { text: string }) {
  const inline = (line: string, key: string): ReactNode[] => {
    const parts: ReactNode[] = [];
    const re = /<([^<>]+)>|\*([^*\n]+)\*|_([^_\n]+)_|~([^~\n]+)~|`([^`\n]+)`/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(line))) {
      if (m.index > last) parts.push(unescapeMrkdwn(line.slice(last, m.index)));
      const k = `${key}-${i++}`;
      if (m[1] !== undefined) {
        const [target = "", label] = m[1].split("|");
        if (target.startsWith("#")) parts.push(<span key={k} className="slack-pill">#{label || target.slice(1)}</span>);
        else if (target.startsWith("!date")) parts.push(<span key={k}>{label || target}</span>);
        else if (/^https?:\/\//.test(target))
          parts.push(
            <a key={k} href={target} target="_blank" rel="noreferrer noopener">
              {unescapeMrkdwn(label || target)}
            </a>,
          );
        else parts.push(unescapeMrkdwn(m[0]));
      } else if (m[2] !== undefined) parts.push(<strong key={k}>{inline(m[2], k)}</strong>);
      else if (m[3] !== undefined) parts.push(<em key={k}>{inline(m[3], k)}</em>);
      else if (m[4] !== undefined) parts.push(<s key={k}>{inline(m[4], k)}</s>);
      else parts.push(<code key={k}>{unescapeMrkdwn(m[5]!)}</code>);
      last = re.lastIndex;
    }
    if (last < line.length) parts.push(unescapeMrkdwn(line.slice(last)));
    return parts;
  };
  return (
    <div className="mrkdwn-preview">
      {text.split("\n").map((line, i) =>
        line.startsWith("&gt; ") || line.startsWith("> ") ? (
          <blockquote key={i}>{inline(line.replace(/^(&gt;|>) /, ""), `q${i}`)}</blockquote>
        ) : (
          <div key={i}>{line ? inline(line, `l${i}`) : "\u00a0"}</div>
        ),
      )}
    </div>
  );
}

function useFormatPreview(format: string, sample: Record<string, unknown>) {
  return useMemo(() => {
    if (!format.trim()) return { out: "", error: null as string | null };
    try {
      return { out: renderTemplate(parseTemplate(format), sample).trim(), error: null as string | null };
    } catch (e) {
      return { out: "", error: describeTemplateError(format, e) as string | null };
    }
  }, [format, sample]);
}

/** Format source, example buttons, live preview and reference. */
function FormatEditor({
  id,
  value,
  onChange,
  preview,
  disabled,
  hint,
  emptyLabel,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  preview: { out: string; error: string | null };
  disabled?: boolean;
  hint: ReactNode;
  emptyLabel: ReactNode;
}) {
  return (
    <>
      <div className="field">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <label className="field-label" htmlFor={id}>
            Format
          </label>
          {!disabled && (
            <div className="row" style={{ gap: 6 }}>
              {FORMAT_EXAMPLES.map((ex) => (
                <button key={ex.label} type="button" className="btn btn-sm btn-ghost" onClick={() => onChange(ex.format)}>
                  {ex.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <textarea
          id={id}
          className="textarea mono"
          rows={8}
          spellCheck={false}
          disabled={disabled}
          value={value}
          placeholder={"{% if meta.title %}*{{ meta.title }}*\n{% endif %}{{ text }}"}
          onChange={(e) => onChange((e.currentTarget as HTMLTextAreaElement).value)}
        />
        {preview.error ? <span className="field-error">{preview.error}</span> : <span className="field-hint">{hint}</span>}
      </div>

      <div className="field">
        <label className="field-label">Preview</label>
        <div className="code-block" style={{ fontFamily: "inherit", whiteSpace: "normal" }}>
          {preview.out ? (
            <MrkdwnPreview text={preview.out} />
          ) : (
            <span className="muted">{value.trim() ? "Renders nothing, so the default layout is used." : emptyLabel}</span>
          )}
        </div>
        <span className="field-hint">Sample values shaped like the source channel's metadata fields.</span>
      </div>

      <details>
        <summary className="field-label" style={{ cursor: "pointer" }}>
          What you can use
        </summary>
        <div className="stack-sm small text-2" style={{ marginTop: 8 }}>
          <div>
            <code>{"{{ text }}"}</code> message · <code>{"{{ author }}"}</code> · <code>{"{{ channel.mention }}"}</code> ·{" "}
            <code>{"{{ link }}"}</code> · <code>{"{{ date }}"}</code> · <code>{"{{ meta.<field> }}"}</code> ·{" "}
            <code>fields</code> (each has <code>label</code>, <code>value</code>) · <code>{"{{ props.<name> }}"}</code> ·{" "}
            <code>{"{{ static }}"}</code>
          </div>
          <div>
            <code>{"{% if a == b %}…{% elif … %}…{% else %}…{% endif %}"}</code>, <code>unless</code>, <code>and</code>,{" "}
            <code>or</code>, <code>not</code>, <code>contains</code>, <code>empty</code>
          </div>
          <div>
            <code>{"{% for x in list limit: 5 %}…{% else %}…{% endfor %}"}</code> with <code>loop.index</code>,{" "}
            <code>loop.first</code>, <code>loop.last</code> · <code>{"{% assign x = … %}"}</code> ·{" "}
            <code>{"{# comment #}"}</code> · <code>{"{%- -%}"}</code> trims whitespace
          </div>
          <div>
            Filters: <code>upper</code> <code>lower</code> <code>capitalize</code> <code>strip</code>{" "}
            <code>default: "x"</code> <code>truncate: 100</code> <code>replace: "a", "b"</code> <code>split: ","</code>{" "}
            <code>join: ", "</code> <code>size</code> <code>first</code> <code>last</code> <code>sort</code>{" "}
            <code>reverse</code> <code>uniq</code> <code>plus</code> <code>minus</code> <code>times</code>{" "}
            <code>round</code> <code>plural: "item", "items"</code> <code>date: "short|long|pretty|time|datetime|iso"</code>{" "}
            <code>link: "label"</code> <code>bold</code> <code>italic</code> <code>strike</code> <code>code</code>{" "}
            <code>quote</code> <code>bullets</code>
          </div>
          <div>
            Values are escaped, so metadata can't add mentions or links. Formats can't use @channel, @here or group
            mentions. The <code>agreement</code> field is never available.
          </div>
        </div>
      </details>
    </>
  );
}

function FormatModal({
  sub,
  onClose,
  onSaved,
}: {
  sub: SubscriptionRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const source = useApi<Channel>(sub ? `/channels/${sub.sourceChannelId}` : null);
  const [format, setFormat] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setFormat(sub?.format || "");
    setErr(null);
  }, [sub]);
  const sample = useMemo(() => sampleFormatContext(source.data), [source.data]);
  const preview = useFormatPreview(format, sample);
  const publisherFormat = source.data?.forwardFormat || "";
  const locked = !!publisherFormat && !!source.data?.forwardFormatLocked;
  const publisherPreview = useFormatPreview(publisherFormat, sample);
  const sourceName = `#${sub?.sourceName || sub?.sourceChannelId || "source"}`;

  async function save(value: string) {
    if (!sub) return;
    setBusy(true);
    setErr(null);
    try {
      await api("/subscriptions", {
        method: "PATCH",
        body: { subscriberChannelId: sub.subscriberChannelId, sourceChannelId: sub.sourceChannelId, format: value },
      });
      toast(value.trim() ? "Message format saved" : "Back to the default format");
      onSaved();
      onClose();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={!!sub}
      onClose={onClose}
      title="Message format"
      description={sub ? `How forwards from ${sourceName} read here.` : undefined}
      width={720}
    >
      <form
        className="stack"
        style={{ gap: 18 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!preview.error) save(format);
        }}
      >
        {locked ? (
          <Notice tone="warn" icon="lock">
            {sourceName} locks its own format for every subscriber, so a format saved here isn't used.
          </Notice>
        ) : publisherFormat ? (
          <Notice icon="info">Leave this empty to use {sourceName}'s format. A format saved here replaces it.</Notice>
        ) : null}
        <FormatEditor
          id="format-src"
          value={format}
          onChange={setFormat}
          preview={preview}
          hint={
            publisherFormat
              ? `Leave empty for ${sourceName}'s format. The "Forwarded from" footer is always added.`
              : 'Leave empty for the default layout. The "Forwarded from" footer is always added.'
          }
          emptyLabel={
            publisherFormat && publisherPreview.out ? (
              <MrkdwnPreview text={publisherPreview.out} />
            ) : (
              "Default layout"
            )
          }
        />

        {err && <Notice tone="danger" icon="alert">{err}</Notice>}
        <div className="modal-actions">
          {sub?.format && (
            <button type="button" className="btn" style={{ marginRight: "auto" }} disabled={busy} onClick={() => save("")}>
              {publisherFormat ? `Use ${sourceName}'s format` : "Reset to default"}
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !!preview.error}>
            {busy && <Spinner />} Save format
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** The publisher's default format for forwards, and whether it overrides subscribers' formats. */
function ForwardFormatCard({ ch, canManage, save }: Ctx) {
  const sample = useMemo(() => sampleFormatContext(ch), [ch]);
  return (
    <SectionCard
      title="Forward format"
      description="How this channel's forwards read in subscribing channels. Subscribers can set their own format unless you lock this one."
      canManage={canManage}
      initial={{ format: ch.forwardFormat || "", locked: !!ch.forwardFormatLocked }}
      onSave={(v) =>
        save(
          { forwardFormat: v.format.trim() ? v.format : null, forwardFormatLocked: v.locked },
          v.format.trim() ? "Forward format saved" : "Forwards use the default layout",
        )
      }
    >
      {(v, set) => (
        <ForwardFormatBody v={v} set={set} sample={sample} canManage={canManage} />
      )}
    </SectionCard>
  );
}

function ForwardFormatBody({
  v,
  set,
  sample,
  canManage,
}: {
  v: { format: string; locked: boolean };
  set: (next: { format: string; locked: boolean }) => void;
  sample: Record<string, unknown>;
  canManage: boolean;
}) {
  const preview = useFormatPreview(v.format, sample);
  return (
    <>
      <div className="card-body stack" style={{ gap: 18 }}>
        <FormatEditor
          id="forward-format-src"
          value={v.format}
          onChange={(format) => set({ ...v, format })}
          preview={preview}
          disabled={!canManage}
          hint='Leave empty for the default layout. The "Forwarded from" footer is always added.'
          emptyLabel="Default layout"
        />
      </div>
      <Setting
        title="Lock this format"
        control={
          <Switch
            label="Lock this format"
            checked={v.locked}
            disabled={!canManage || !v.format.trim()}
            onChange={(locked) => set({ ...v, locked })}
          />
        }
      >
        Use this format in every subscribing channel, even ones that set their own.
      </Setting>
    </>
  );
}

function PubSubTab({
  ch,
  canManage,
  save,
  subs,
  reloadSubs,
}: Ctx & { subs: SubscriptionRow[] | null; reloadSubs: () => void }) {
  const toast = useToast();
  const sources = useApi<Channel[]>(canManage ? "/channels?enabled=true" : null);
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<SubscriptionRow | null>(null);
  const [formatting, setFormatting] = useState<SubscriptionRow | null>(null);
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
                    {(() => {
                      const src = sources.data?.find((c) => c.id === s.sourceChannelId);
                      if (src?.forwardFormat && src.forwardFormatLocked)
                        return <span className="badge outline" style={{ marginLeft: 8 }} title="The source channel locks its format">source format</span>;
                      if (s.format) return <span className="badge outline" style={{ marginLeft: 8 }}>custom format</span>;
                      if (src?.forwardFormat) return <span className="badge outline" style={{ marginLeft: 8 }}>source format</span>;
                      return null;
                    })()}
                  </td>
                  <td className="hide-md muted">{fmtDate(s.createdAt)}</td>
                  <td className="right">
                    {canManage && (
                      <div className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
                        <button className="btn btn-sm" onClick={() => setEditing(s)}>
                          <Icon name="edit" size={14} /> Profile
                        </button>
                        <button className="btn btn-sm" onClick={() => setFormatting(s)}>
                          <Icon name="code" size={14} /> Format
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

      {ch.enabled && <ForwardFormatCard ch={ch} canManage={canManage} save={save} />}

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
      <FormatModal sub={formatting} onClose={() => setFormatting(null)} onSaved={reloadSubs} />
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
