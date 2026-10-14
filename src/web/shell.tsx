import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { authClient } from "../lib/auth-client";
import { useTheme, type ThemePref } from "./theme";
import {
  Icon,
  Spinner,
  Avatar,
  api,
  channelPageUrl,
  type Channel,
  type IconName,
} from "./ui";

export interface Crumb {
  label: string;
  href?: string;
}

interface SiteConfig {
  lockdownUsers: { id: string; name: string; url: string }[];
  githubStars: number | null;
}

let siteConfigPromise: Promise<SiteConfig | null> | null = null;
export function loadSiteConfig(): Promise<SiteConfig | null> {
  siteConfigPromise ??= fetch("/site-config")
    .then((r) => (r.ok ? (r.json() as Promise<SiteConfig>) : null))
    .catch(() => null);
  return siteConfigPromise;
}

export function useSiteConfig() {
  const [config, setConfig] = useState<SiteConfig | null>(null);
  useEffect(() => {
    loadSiteConfig().then(setConfig);
  }, []);
  return config;
}

export function signIn(callbackURL = window.location.pathname + window.location.search) {
  return authClient.signIn.oauth2({ providerId: "hackclub", callbackURL });
}

type NavItem = { key: string; label: string; href: string; icon: IconName; auth?: boolean };

const NAV: { label?: string; items: NavItem[] }[] = [
  {
    items: [
      { key: "home", label: "Overview", href: "/", icon: "home" },
      { key: "map", label: "Feed map", href: "/map.html", icon: "map" },
    ],
  },
  {
    label: "Build",
    items: [
      { key: "channels", label: "Channels", href: "/channels.html", icon: "hash" },
      { key: "subscriptions", label: "Pub/sub", href: "/subscriptions.html", icon: "radio" },
      { key: "keys", label: "API keys", href: "/keys.html", icon: "key", auth: true },
    ],
  },
  {
    label: "Reference",
    items: [
      { key: "docs", label: "API reference", href: "/docs.html", icon: "code" },
      { key: "usage", label: "Slack commands", href: "/usage.html", icon: "terminal" },
    ],
  },
];

const TAGLINES = [
  "does plumbing for Slack",
  "is this the mushroom kingdom? 🍄",
  "ghost pinging since 2026",
  "unclogging your feeds",
  "now with 100% more pipes",
  "it's-a me, indigest",
  "your messages, but elsewhere",
  "Yep! / No",
  "RSS is not dead",
  "pub/sub/hub/dub",
  "certified drain specialist",
  "warp pipe to your webhook",
];

/** Logo and Hack Club pill, with a tagline picked fresh on every page load. */
export function Brand() {
  const [tagline] = useState(() => TAGLINES[Math.floor(Math.random() * TAGLINES.length)]!);
  return (
    <div className="brand-block">
      <div className="brand-row">
        <a href="/" className="brand">
          <span className="brand-mark">
            <img src="/plunger-72.png" alt="" width="20" height="20" />
          </span>
          <span className="brand-name">indigest</span>
        </a>
        <a className="brand-tag" href="https://hackclub.com" target="_blank" rel="noopener">
          Hack Club
        </a>
      </div>
      <span className="brand-tagline" title={tagline}>
        {tagline}
      </span>
    </div>
  );
}

const ADMIN_NAV: { label?: string; items: NavItem[] } = {
  label: "Admin",
  items: [{ key: "audit", label: "Audit log", href: "/audit.html", icon: "shield" }],
};

/** Lockdown users are indigest's admins. */
export function useIsAdmin(): boolean {
  const { data: session } = authClient.useSession();
  const config = useSiteConfig();
  const slackId = (session?.user as { slackId?: string | null } | undefined)?.slackId;
  return !!slackId && !!config?.lockdownUsers.some((u) => u.id === slackId);
}

function navGroups(isAdmin: boolean) {
  return isAdmin ? [...NAV, ADMIN_NAV] : NAV;
}

function Sidebar({
  active,
  onSearch,
  signedIn,
  isAdmin,
}: {
  active: string;
  onSearch: () => void;
  signedIn: boolean;
  isAdmin: boolean;
}) {
  const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <Brand />
      </div>
      <div className="sidebar-scroll">
        <button className="sidebar-search" onClick={onSearch}>
          <Icon name="search" />
          <span>Quick search…</span>
          <span className="kbd">
            <kbd>{isMac ? "⌘" : "Ctrl"}</kbd>
            <kbd>K</kbd>
          </span>
        </button>
        {navGroups(isAdmin).map((group, i) => (
          <nav className="nav-group" key={i}>
            {group.label && <div className="nav-label">{group.label}</div>}
            {group.items.map((item) => (
              <a
                key={item.key}
                href={item.href}
                className={"nav-item" + (active === item.key ? " active" : "")}
              >
                <Icon name={item.icon} size={18} />
                {item.label}
                {item.auth && !signedIn && (
                  <span className="nav-chevron">
                    <Icon name="lock" size={13} />
                  </span>
                )}
              </a>
            ))}
          </nav>
        ))}
      </div>
      <div className="sidebar-foot">
        <ThemeToggle />
        <a
          href="/settings.html"
          className={"nav-item" + (active === "settings" ? " active" : "")}
        >
          <Icon name="settings" size={18} />
          Account settings
          <span className="nav-chevron">
            <Icon name="chevronRight" size={14} />
          </span>
        </a>
      </div>
    </aside>
  );
}

const THEME_OPTIONS: { value: ThemePref; icon: IconName; label: string }[] = [
  { value: "system", icon: "monitor", label: "System" },
  { value: "light", icon: "sun", label: "Light" },
  { value: "dark", icon: "moon", label: "Dark" },
];

export function ThemeToggle({ compact }: { compact?: boolean }) {
  const { pref, setPref } = useTheme();
  return (
    <div className={"theme-toggle" + (compact ? " compact" : "")} role="radiogroup" aria-label="Theme">
      {THEME_OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={pref === o.value}
          className={pref === o.value ? "active" : ""}
          onClick={() => setPref(o.value)}
          title={`${o.label} theme`}
        >
          <Icon name={o.icon} size={15} />
          {!compact && <span>{o.label}</span>}
        </button>
      ))}
    </div>
  );
}

export { Avatar };

function AccountMenu() {
  const { data: session, isPending } = authClient.useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (isPending) return <span className="avatar" />;
  if (!session?.user)
    return (
      <a className="btn btn-primary btn-sm" href={`/login.html?next=${encodeURIComponent(location.pathname + location.search)}`}>
        Sign in
      </a>
    );
  const user = session.user as typeof session.user & { slackId?: string | null };
  return (
    <div className="menu-wrap" ref={ref}>
      <button
        className="menu-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
      >
        <Avatar name={user.name || user.email} slackId={user.slackId} image={user.image} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-header">
            <strong>{user.name || user.slackId}</strong>
            <span>{user.email}</span>
          </div>
          <a className="menu-item" href="/settings.html">
            <Icon name="user" /> Profile
          </a>
          <a className="menu-item" href="/settings.html#sessions">
            <Icon name="monitor" /> Sessions
          </a>
          <a className="menu-item" href="/keys.html">
            <Icon name="key" /> API keys
          </a>
          <div className="menu-sep" />
          <button
            className="menu-item danger"
            onClick={() =>
              authClient.signOut().then(() => (window.location.href = "/login.html?signedout=1"))
            }
          >
            <Icon name="logout" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function Topbar({ crumbs, onMenu }: { crumbs: Crumb[]; onMenu: () => void }) {
  const config = useSiteConfig();
  return (
    <header className="topbar">
      <button className="btn btn-ghost btn-icon topbar-menu" onClick={onMenu} aria-label="Open navigation">
        <Icon name="menu" />
      </button>
      <div className="crumbs">
        {crumbs.map((c, i) => (
          <span key={i} className="row" style={{ gap: 8, flexWrap: "nowrap", minWidth: 0 }}>
            {i > 0 && <span className="sep">/</span>}
            {c.href && i < crumbs.length - 1 ? (
              <a href={c.href}>{c.label}</a>
            ) : (
              <span className="current">{c.label}</span>
            )}
          </span>
        ))}
      </div>
      <div className="topbar-actions">
        <a className="topbar-link hide-sm" href="/usage.html">
          <Icon name="book" /> Docs
        </a>
        <a
          className="topbar-link hide-sm"
          href="https://github.com/matmanna/indigest"
          target="_blank"
          rel="noopener"
        >
          <Icon name="github" /> GitHub
          {config?.githubStars != null && (
            <span className="count">★ {config.githubStars}</span>
          )}
        </a>
        <AccountMenu />
      </div>
    </header>
  );
}

function LockdownBanner() {
  const config = useSiteConfig();
  const users = config?.lockdownUsers ?? [];
  if (users.length === 0) return null;
  return (
    <div className="banner">
      <Icon name="lock" />
      <span>
        Lockdown mode is on — only authorized users can change bot settings. Contact{" "}
        {users.map((u, i) => (
          <span key={u.id}>
            <a href={u.url} target="_blank" rel="noopener noreferrer">
              @{u.name || u.id}
            </a>
            {i < users.length - 1 ? ", " : ""}
          </span>
        ))}{" "}
        for changes.
      </span>
    </div>
  );
}

// --- Command palette ---------------------------------------------------------

type PaletteItem = { label: string; href: string; icon: IconName; group: string; hint?: string };

function CommandPalette({
  open,
  onClose,
  isAdmin,
}: {
  open: boolean;
  onClose: () => void;
  isAdmin: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [channels, setChannels] = useState<Channel[] | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      setQuery("");
      setIndex(0);
      if (!channels) api<Channel[]>("/channels").then(setChannels).catch(() => setChannels([]));
    }
    if (!open && d.open) d.close();
  }, [open]);

  const items = useMemo(() => {
    const pages: PaletteItem[] = navGroups(isAdmin).flatMap((g) =>
      g.items.map((i) => ({ label: i.label, href: i.href, icon: i.icon, group: "Pages" })),
    );
    pages.push({ label: "Account settings", href: "/settings.html", icon: "settings", group: "Pages" });
    const chans: PaletteItem[] = (channels ?? [])
      .filter((c) => c.enabled)
      .map((c) => ({
        label: `#${c.name || c.id}`,
        href: channelPageUrl(c.id),
        icon: "hash",
        group: "Channels",
        hint: c.id,
      }));
    const q = query.trim().toLowerCase();
    const all = [...pages, ...chans];
    return q
      ? all.filter((i) => i.label.toLowerCase().includes(q) || i.hint?.toLowerCase().includes(q))
      : all.slice(0, 14);
  }, [query, channels, isAdmin]);

  useEffect(() => setIndex(0), [query]);

  const go = (item?: PaletteItem) => {
    if (item) window.location.href = item.href;
  };

  let lastGroup = "";
  return (
    <dialog
      ref={ref}
      className="palette"
      onClose={onClose}
      onCancel={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
    >
      <div className="palette-input">
        <Icon name="search" size={18} />
        <input
          autoFocus
          value={query}
          placeholder="Search pages and channels…"
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              go(items[index]);
            }
          }}
        />
        <span className="kbd">
          <kbd>esc</kbd>
        </span>
      </div>
      <div className="palette-list">
        {items.length === 0 && <div className="palette-empty">No results for “{query}”</div>}
        {items.map((item, i) => {
          const header = item.group !== lastGroup ? item.group : null;
          lastGroup = item.group;
          return (
            <div key={item.href}>
              {header && <div className="palette-group">{header}</div>}
              <a
                className={"palette-item" + (i === index ? " active" : "")}
                href={item.href}
                onMouseEnter={() => setIndex(i)}
              >
                <Icon name={item.icon} />
                {item.label}
                {item.hint && <span className="hint mono">{item.hint}</span>}
              </a>
            </div>
          );
        })}
        {channels === null && (
          <div className="palette-empty">
            <Spinner />
          </div>
        )}
      </div>
    </dialog>
  );
}

// --- Shell -------------------------------------------------------------------

export function AppShell({
  active,
  crumbs,
  wide,
  children,
}: {
  active: string;
  crumbs: Crumb[];
  wide?: boolean;
  children: ReactNode;
}) {
  const { data: session } = authClient.useSession();
  const isAdmin = useIsAdmin();
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={"shell" + (navOpen ? " nav-open" : "")}>
      <Sidebar
        active={active}
        onSearch={() => setPaletteOpen(true)}
        signedIn={!!session?.user}
        isAdmin={isAdmin}
      />
      <div className="sidebar-scrim" onClick={() => setNavOpen(false)} />
      <div className="main">
        <Topbar crumbs={crumbs} onMenu={() => setNavOpen(true)} />
        <LockdownBanner />
        <main className={"content" + (wide ? " wide" : "")}>{children}</main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} isAdmin={isAdmin} />
    </div>
  );
}

/** Render children only for signed-in users; otherwise a sign-in prompt. */
export function RequireAuth({
  children,
  title = "Sign in to continue",
  description = "This page needs your Hack Club account.",
}: {
  children: (session: SessionUser) => ReactNode;
  title?: string;
  description?: string;
}) {
  const { data: session, isPending } = authClient.useSession();
  if (isPending)
    return (
      <div className="empty">
        <Spinner />
      </div>
    );
  if (!session?.user)
    return (
      <div className="card">
        <div className="empty">
          <div className="empty-icon">
            <Icon name="lock" size={20} />
          </div>
          <h3>{title}</h3>
          <p>{description}</p>
          <button className="btn btn-primary" onClick={() => signIn()}>
            Continue with Hack Club
          </button>
        </div>
      </div>
    );
  return <>{children(session.user as SessionUser)}</>;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
  slackId?: string | null;
  createdAt?: string | Date;
}
