import {
  useCallback,
  useEffect,
  useRef,
  useState,
  createContext,
  useContext,
  type ReactNode,
} from "react";

// --- Links -----------------------------------------------------------------

export const slackChannelUrl = (channelId: string) =>
  `https://hackclub.enterprise.slack.com/archives/${channelId}`;
export const slackUserUrl = (userId: string) =>
  `https://hackclub.enterprise.slack.com/team/${userId}`;
/** Cachet serves (and caches) Slack profile pictures by user ID. */
export const CACHET_URL = "https://cachet.hackclub.com";
export const isSlackUserId = (id: string | null | undefined): id is string =>
  !!id && /^[UW][A-Z0-9]+$/.test(id);
export const cachetAvatarUrl = (slackId: string) =>
  `${CACHET_URL}/users/${encodeURIComponent(slackId)}/r`;
export const channelPageUrl = (channelId: string) =>
  `/channel.html?id=${encodeURIComponent(channelId)}`;

// --- API -------------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method || "GET",
    headers:
      init?.body !== undefined ? { "Content-Type": "application/json" } : {},
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    // oRPC validation errors carry the zod issues under data.issues.
    const issue = data?.data?.issues?.[0]?.message;
    throw new ApiError(
      issue || data?.message || data?.error || `HTTP ${res.status}`,
      res.status,
    );
  }
  return data as T;
}

/** Load once on mount (and on reload()), tracking loading/error state. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    setLoading(true);
    api<T>(path)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
      })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}

// --- Domain types ------------------------------------------------------------

export interface Channel {
  id: string;
  name: string;
  teamId: string;
  enabled: boolean;
  linkMode: boolean;
  webhookUrl: string;
  autoApproveUsers: string[];
  manualUsers: string[];
  triggerMode: "message" | "shortcut";
  approvedPosters: string[];
  accessPermUsers: string[];
  trackReplies: boolean;
  metadataSchema: string;
  metadataRequired: boolean;
  properties: string;
  staticMetadata: string;
  createdAt: string;
  canManage?: boolean;
}

export interface ManageableResponse {
  lockdown: boolean;
  isAdmin: boolean;
  channels: Channel[];
}

export interface SubscriptionRow {
  id?: number;
  subscriberChannelId: string;
  sourceChannelId: string;
  profileName?: string | null;
  profileImageUrl?: string | null;
  createdAt: string;
  sourceName: string;
  subscriberName: string;
}

export interface SlackUser {
  id: string;
  name: string;
  image: string | null;
}

export function approvalMode(ch: Channel): string {
  if (ch.triggerMode === "shortcut") return "Shortcut only";
  if (ch.autoApproveUsers.includes("*")) return "Auto-approve";
  if (ch.manualUsers.length > 0 && !ch.manualUsers.includes("*"))
    return "Manual (selected)";
  if (ch.autoApproveUsers.length > 0) return "Mixed";
  return "Prompt";
}

export function accessLabel(ch: Pick<Channel, "accessPermUsers">): string {
  if (ch.accessPermUsers.includes("*")) return "Public";
  if (ch.accessPermUsers.length === 0) return "Nobody";
  return `${ch.accessPermUsers.length} user${ch.accessPermUsers.length === 1 ? "" : "s"}`;
}

export function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function fmtRelative(value: string | null | undefined): string {
  if (!value) return "never";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "never";
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  const units: [number, string][] = [
    [60, "minute"],
    [3600, "hour"],
    [86400, "day"],
    [2592000, "month"],
    [31536000, "year"],
  ];
  let unit = units[0]!;
  for (const u of units) if (s >= u[0]) unit = u;
  const n = Math.floor(s / unit[0]);
  return `${n} ${unit[1]}${n === 1 ? "" : "s"} ago`;
}

// --- Icons -------------------------------------------------------------------

const paths: Record<string, ReactNode> = {
  home: (
    <>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V20h14V9.5" />
    </>
  ),
  map: (
    <>
      <circle cx="5" cy="6" r="2.5" />
      <circle cx="19" cy="6" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="M7.5 6h9M6.2 8.2l4.6 7.6M17.8 8.2l-4.6 7.6" />
    </>
  ),
  hash: <path d="M5 9h14M4 15h14M10 3 8 21M16 3l-2 18" />,
  radio: (
    <>
      <circle cx="12" cy="12" r="2" />
      <path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19 5a10 10 0 0 1 0 14M5 19A10 10 0 0 1 5 5" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m10.8 12.2 8.7-8.7M17 6l2.5 2.5M14.5 8.5 16.5 10.5" />
    </>
  ),
  book: (
    <>
      <path d="M4 19.5V5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2Z" />
      <path d="M4 19.5A2 2 0 0 0 6 21.5h14" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  chevronRight: <path d="m9 6 6 6-6 6" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2.5" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  logout: <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10" />,
  github: (
    <path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21" />
  ),
  star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3l-5.5 2.9 1-6.2L3 9.6l6.2-.9Z" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.5a6.5 6.5 0 0 1 3 5.5" />
    </>
  ),
  shield: <path d="M12 3 4.5 6v6c0 4.4 3.2 8.2 7.5 9 4.3-.8 7.5-4.6 7.5-9V6Z" />,
  rss: (
    <>
      <path d="M5 5a14 14 0 0 1 14 14M5 11a8 8 0 0 1 8 8" />
      <circle cx="6" cy="18" r="1.3" />
    </>
  ),
  webhook: (
    <>
      <path d="M9.5 8.5 7 13a3 3 0 1 0 4.5 2.6h6" />
      <path d="M12 4a3 3 0 0 0-2.5 4.5L13 14.5" />
      <path d="M14 5.5a3 3 0 1 1 3.2 4.4L14.5 15.5" />
    </>
  ),
  code: <path d="m8 7-5 5 5 5M16 7l5 5-5 5" />,
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
  alert: (
    <>
      <path d="M12 3 2 20h20Z" />
      <path d="M12 10v4M12 17v.5" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8v.5" />
    </>
  ),
  lock: (
    <>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </>
  ),
  monitor: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2.5" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
  refresh: <path d="M20 11a8 8 0 0 0-14.8-4M4 4v4h4M4 13a8 8 0 0 0 14.8 4M20 20v-4h-4" />,
  edit: <path d="M4 20h4L19 9l-4-4L4 16Z M13.5 6.5l4 4" />,
  layers: (
    <>
      <path d="m12 3 9 5-9 5-9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  slack: (
    <>
      <rect x="10" y="3" width="4" height="8" rx="2" />
      <rect x="13" y="10" width="8" height="4" rx="2" />
      <rect x="10" y="13" width="4" height="8" rx="2" />
      <rect x="3" y="10" width="8" height="4" rx="2" />
    </>
  ),
};

export type IconName = keyof typeof paths;

export function Icon({
  name,
  size = 16,
  stroke = 1.7,
}: {
  name: IconName;
  size?: number;
  stroke?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

// --- Primitives --------------------------------------------------------------

export function Spinner() {
  return <span className="spinner" aria-label="loading" />;
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  width,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="modal"
      style={width ? { width: `min(${width}px, calc(100vw - 32px))` } : undefined}
      onClose={onClose}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="modal-body">
          <div className="modal-header">
            <div>
              <h2>{title}</h2>
              {description && <p>{description}</p>}
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm"
              onClick={onClose}
              aria-label="Close"
            >
              <Icon name="x" />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

export function CopyField({
  value,
  display,
  reveal,
}: {
  value: string;
  display?: string;
  reveal?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={"copy-field" + (reveal ? " reveal" : "")}>
      <code title={value}>{display ?? value}</code>
      <button
        type="button"
        className="btn btn-ghost btn-sm btn-icon"
        aria-label="Copy"
        onClick={() => {
          navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          });
        }}
      >
        <Icon name={copied ? "check" : "copy"} />
      </button>
    </div>
  );
}

export function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={20} />
      </div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        {eyebrow && <div className="page-eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function SlackChannelPill({ id, name }: { id: string; name?: string }) {
  return (
    <a
      className="slack-pill"
      href={slackChannelUrl(id)}
      target="_blank"
      rel="noopener"
      title="Open in Slack"
    >
      #{name || id}
    </a>
  );
}

export function StatusBadge({ enabled }: { enabled: boolean }) {
  return (
    <span className="badge outline">
      <span className={"dot" + (enabled ? " on" : "")} />
      {enabled ? "Pub'd" : "Off"}
    </span>
  );
}

export function Skeleton({ w = "100%", h = 14 }: { w?: number | string; h?: number }) {
  return <div className="skeleton" style={{ width: w, height: h }} />;
}

export function Notice({
  tone,
  icon = "info",
  children,
}: {
  tone?: "danger" | "warn" | "success";
  icon?: IconName;
  children: ReactNode;
}) {
  return (
    <div className={"notice" + (tone ? ` ${tone}` : "")}>
      <Icon name={icon} />
      <div>{children}</div>
    </div>
  );
}

// --- Avatars -----------------------------------------------------------------

function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .map((p) => p[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

/**
 * Profile picture for a person. Tries Cachet when we know their Slack ID,
 * then any image we were given, then falls back to initials.
 */
export function Avatar({
  name,
  slackId,
  image,
  size,
  glyph,
}: {
  name: string;
  slackId?: string | null;
  image?: string | null;
  size?: "sm" | "lg";
  /** Shown instead of initials when no picture loads. */
  glyph?: ReactNode;
}) {
  const sources = [isSlackUserId(slackId) ? cachetAvatarUrl(slackId) : null, image].filter(
    (src): src is string => !!src,
  );
  const [failed, setFailed] = useState(0);
  const key = sources.join(" ");
  useEffect(() => setFailed(0), [key]);
  const src = sources[failed];
  const cls = "avatar" + (size ? ` ${size}` : "");
  if (src)
    return (
      <img
        className={cls}
        src={src}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed((n) => n + 1)}
      />
    );
  return <span className={cls}>{glyph ?? initials(name)}</span>;
}

// --- Slack users -------------------------------------------------------------

const userCache = new Map<string, SlackUser>();

export function useSlackUsers(ids: string[]): Map<string, SlackUser> {
  const key = [...new Set(ids)].filter((id) => /^[UW][A-Z0-9]+$/.test(id)).sort().join(",");
  const [, force] = useState(0);
  useEffect(() => {
    const missing = key.split(",").filter((id) => id && !userCache.has(id));
    if (missing.length === 0) return;
    api<SlackUser[]>(`/slack/users?ids=${missing.slice(0, 50).join(",")}`)
      .then((users) => {
        for (const u of users) userCache.set(u.id, u);
        force((n) => n + 1);
      })
      .catch(() => {});
  }, [key]);
  return userCache;
}

export function UserChip({
  id,
  user,
  onRemove,
}: {
  id: string;
  user?: SlackUser;
  onRemove?: () => void;
}) {
  const label = id === "*" ? "Everyone" : id === "poster" ? "Original poster" : user?.name || id;
  return (
    <span className="chip" title={id}>
      {id === "*" || id === "poster" ? (
        <span className="avatar sm">{id === "*" ? "∗" : "✎"}</span>
      ) : (
        <Avatar name={label} slackId={id} image={user?.image} size="sm" />
      )}
      <span className="chip-label">{label}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${label}`}>
          <Icon name="x" size={12} />
        </button>
      )}
    </span>
  );
}

/**
 * Edit a list of Slack user IDs. Accepts raw IDs or `<@U123>` mentions,
 * comma or space separated.
 */
export function UserListInput({
  value,
  onChange,
  disabled,
  placeholder = "Add Slack user ID, e.g. U07VA44DNBA",
  specials = [],
}: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
  specials?: string[];
}) {
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const users = useSlackUsers(value);
  function commit() {
    const tokens = draft
      .split(/[\s,]+/)
      .map((t) => t.replace(/^<@([A-Z0-9]+)(\|[^>]*)?>$/, "$1").trim())
      .filter(Boolean);
    if (tokens.length === 0) return;
    const bad = tokens.filter(
      (t) => !/^[UW][A-Z0-9]{4,}$/.test(t) && !specials.includes(t),
    );
    if (bad.length) {
      setErr(`Not a Slack user ID: ${bad.join(", ")}`);
      return;
    }
    setErr(null);
    onChange([...new Set([...value, ...tokens])]);
    setDraft("");
  }
  return (
    <div className="field" style={{ width: "100%" }}>
      <div className="chip-input">
        {value.map((id) => (
          <UserChip
            key={id}
            id={id}
            user={users.get(id)}
            onRemove={disabled ? undefined : () => onChange(value.filter((v) => v !== id))}
          />
        ))}
        {!disabled && (
          <input
            value={draft}
            placeholder={value.length ? "Add another…" : placeholder}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                commit();
              } else if (e.key === "Backspace" && !draft && value.length) {
                onChange(value.slice(0, -1));
              }
            }}
            onBlur={commit}
          />
        )}
        {disabled && value.length === 0 && <span className="muted small" style={{ padding: "0 6px" }}>None</span>}
      </div>
      {err && <span className="field-error">{err}</span>}
    </div>
  );
}

// --- Toasts ------------------------------------------------------------------

type Toast = { id: number; text: string; tone?: "error" };
const ToastCtx = createContext<(text: string, tone?: "error") => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone?: "error") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3600);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={"toast" + (t.tone ? ` ${t.tone}` : "")}>
            <Icon name={t.tone === "error" ? "alert" : "check"} />
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

// --- Confirm -----------------------------------------------------------------

/** Promise-based confirm dialog: `if (await confirm({...})) …`. */
export function useConfirm() {
  const [state, setState] = useState<{
    title: string;
    description?: ReactNode;
    action: string;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const confirm = useCallback(
    (opts: { title: string; description?: ReactNode; action?: string }) =>
      new Promise<boolean>((resolve) =>
        setState({ ...opts, action: opts.action ?? "Confirm", resolve }),
      ),
    [],
  );
  const close = (ok: boolean) => {
    state?.resolve(ok);
    setState(null);
  };
  const dialog = (
    <Modal open={!!state} onClose={() => close(false)} title={state?.title ?? ""} description={state?.description}>
      <div className="modal-actions">
        <button className="btn" onClick={() => close(false)}>
          Cancel
        </button>
        <button className="btn btn-danger" onClick={() => close(true)} autoFocus>
          {state?.action}
        </button>
      </div>
    </Modal>
  );
  return { confirm, dialog };
}
