import { useEffect, useState } from "react";
import { renderPage } from "./layout";
import { authClient } from "../lib/auth-client";
import { Avatar, RequireAuth, useSiteConfig, type SessionUser } from "./shell";
import {
  CopyField,
  Icon,
  Notice,
  PageHeader,
  Skeleton,
  Spinner,
  fmtDate,
  fmtRelative,
  slackUserUrl,
  useApi,
  useConfirm,
  useToast,
  type ManageableResponse,
} from "./ui";

type Section = "profile" | "access" | "sessions" | "danger";
const SECTIONS: { key: Section; label: string }[] = [
  { key: "profile", label: "Profile" },
  { key: "access", label: "Permissions" },
  { key: "sessions", label: "Sessions" },
  { key: "danger", label: "Sign out" },
];

interface AuthSession {
  id: string;
  token: string;
  createdAt: string | Date;
  updatedAt: string | Date;
  expiresAt: string | Date;
  ipAddress?: string | null;
  userAgent?: string | null;
}

function describeAgent(ua?: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Mac OS X/.test(ua)
      ? /iPhone|iPad/.test(ua)
        ? "iOS"
        : "macOS"
      : /Android/.test(ua)
        ? "Android"
        : /Linux/.test(ua)
          ? "Linux"
          : "Unknown OS";
  return `${browser} on ${os}`;
}

function ProfileSection({ user }: { user: SessionUser }) {
  return (
    <div className="card" id="profile">
      <div className="card-header">
        <div>
          <h3>Profile</h3>
          <p>Synced from your Hack Club account each time you sign in.</p>
        </div>
        <a className="btn btn-sm" href="https://auth.hackclub.com" target="_blank" rel="noopener">
          Edit on Hack Club <Icon name="external" size={13} />
        </a>
      </div>
      <div className="card-body row" style={{ gap: 20, borderBottom: "1px solid var(--border)" }}>
        <Avatar name={user.name || user.email} slackId={user.slackId} image={user.image} size="lg" />
        <div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{user.name || "Unnamed"}</div>
          <div className="text-2">{user.email}</div>
        </div>
      </div>
      <dl className="kv">
        <dt>Slack user</dt>
        <dd>
          {user.slackId ? (
            <a className="slack-pill" href={slackUserUrl(user.slackId)} target="_blank" rel="noopener">
              <span className="mono">{user.slackId}</span>
            </a>
          ) : (
            <span className="red">Not linked — sign out and back in to refresh it.</span>
          )}
        </dd>
        <dt>Account ID</dt>
        <dd>
          <CopyField value={user.id} />
        </dd>
        <dt>Member since</dt>
        <dd>{fmtDate(user.createdAt ? String(user.createdAt) : null)}</dd>
        <dt>Sign-in method</dt>
        <dd>Hack Club (OpenID Connect)</dd>
      </dl>
    </div>
  );
}

function AccessSection() {
  const config = useSiteConfig();
  const managed = useApi<ManageableResponse>("/channels/manageable");
  const keys = useApi<{ revokedAt: string | null }[]>("/api-keys");
  const mine = managed.data?.channels.filter((c) => c.canManage) ?? [];
  return (
    <div className="card" id="access">
      <div className="card-header">
        <div>
          <h3>Permissions</h3>
          <p>What your account can do in indigest.</p>
        </div>
      </div>
      <dl className="kv">
        <dt>Role</dt>
        <dd>
          {managed.data ? (
            managed.data.isAdmin ? (
              <span className="badge solid">Authorized user</span>
            ) : (
              <span className="badge outline">Member</span>
            )
          ) : (
            <Skeleton w={90} h={22} />
          )}
        </dd>
        <dt>Lockdown mode</dt>
        <dd>
          {config ? (
            config.lockdownUsers.length > 0 ? (
              <span className="text-2">On — {config.lockdownUsers.length} authorized users</span>
            ) : (
              <span className="text-2">Off</span>
            )
          ) : (
            <Skeleton w={120} />
          )}
        </dd>
        <dt>Channels you manage</dt>
        <dd>
          {managed.data ? (
            mine.length === 0 ? (
              <span className="muted">None</span>
            ) : (
              <div className="row" style={{ gap: 6 }}>
                {mine.slice(0, 12).map((c) => (
                  <a key={c.id} className="slack-pill" href={`/channel.html?id=${c.id}`}>
                    #{c.name || c.id}
                  </a>
                ))}
                {mine.length > 12 && <span className="muted small">+{mine.length - 12} more</span>}
              </div>
            )
          ) : (
            <Skeleton w={200} />
          )}
        </dd>
        <dt>Active API keys</dt>
        <dd>
          {keys.data ? (
            <a href="/keys.html">{keys.data.filter((k) => !k.revokedAt).length} keys →</a>
          ) : (
            <Skeleton w={60} />
          )}
        </dd>
      </dl>
    </div>
  );
}

function SessionsSection() {
  const toast = useToast();
  const { data: current } = authClient.useSession();
  const [sessions, setSessions] = useState<AuthSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  async function load() {
    const res = await authClient.listSessions();
    if (res.error) setError(res.error.message || "Couldn't load sessions");
    else setSessions((res.data as AuthSession[]) ?? []);
  }
  useEffect(() => {
    load();
  }, []);

  const currentToken = current?.session?.token;
  const sorted = [...(sessions ?? [])].sort(
    (a, b) => Number(b.token === currentToken) - Number(a.token === currentToken) ||
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );

  return (
    <div className="card" id="sessions">
      <div className="card-header">
        <div>
          <h3>Sessions</h3>
          <p>Devices currently signed in to your account.</p>
        </div>
        <button
          className="btn btn-sm"
          disabled={!sessions || sessions.length < 2 || busy === "others"}
          onClick={async () => {
            const ok = await confirm({
              title: "Sign out other sessions?",
              description: "Every device except this one will be signed out.",
              action: "Sign out others",
            });
            if (!ok) return;
            setBusy("others");
            const res = await authClient.revokeOtherSessions();
            setBusy(null);
            if (res.error) toast(res.error.message || "Failed", "error");
            else {
              toast("Other sessions signed out");
              load();
            }
          }}
        >
          {busy === "others" && <Spinner />} Sign out other sessions
        </button>
      </div>
      {error && (
        <div className="card-body">
          <Notice tone="danger" icon="alert">{error}</Notice>
        </div>
      )}
      {!sessions && !error && (
        <div className="card-body stack-sm">
          <Skeleton h={40} />
          <Skeleton h={40} />
        </div>
      )}
      {sorted.length > 0 && (
        <table className="table">
          <tbody>
            {sorted.map((s) => {
              const isCurrent = s.token === currentToken;
              return (
                <tr key={s.id}>
                  <td>
                    <div className="cell-title">
                      <span className="channel-glyph">
                        <Icon name="monitor" />
                      </span>
                      <div>
                        <div>
                          {describeAgent(s.userAgent)}{" "}
                          {isCurrent && <span className="badge solid" style={{ marginLeft: 6 }}>This device</span>}
                        </div>
                        <div className="cell-sub">
                          {s.ipAddress || "Unknown IP"} · active {fmtRelative(String(s.updatedAt))}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="hide-md muted">Signed in {fmtDate(String(s.createdAt))}</td>
                  <td className="right">
                    {!isCurrent && (
                      <button
                        className="btn btn-sm btn-danger"
                        disabled={busy === s.id}
                        onClick={async () => {
                          setBusy(s.id);
                          const res = await authClient.revokeSession({ token: s.token });
                          setBusy(null);
                          if (res.error) toast(res.error.message || "Failed", "error");
                          else {
                            toast("Session revoked");
                            load();
                          }
                        }}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {dialog}
    </div>
  );
}

function SignOutSection() {
  const [busy, setBusy] = useState(false);
  return (
    <div className="card danger" id="danger">
      <div className="card-header">
        <div>
          <h3>Sign out everywhere</h3>
          <p>End every session, including this one. Your API keys keep working until you revoke them.</p>
        </div>
      </div>
      <div className="card-footer">
        <span>You can sign back in with Hack Club at any time.</span>
        <div className="actions">
          <button
            className="btn btn-danger btn-sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await authClient.revokeSessions();
              await authClient.signOut();
              window.location.href = "/login.html?signedout=1";
            }}
          >
            {busy && <Spinner />} Sign out everywhere
          </button>
        </div>
      </div>
    </div>
  );
}

function SettingsPage({ user }: { user: SessionUser }) {
  const [active, setActive] = useState<Section>(() => (location.hash.slice(1) as Section) || "profile");
  useEffect(() => {
    const el = document.getElementById(active);
    if (el && location.hash) el.scrollIntoView({ block: "start" });
  }, []);
  return (
    <>
      <PageHeader title="Account settings" description="Manage your profile, permissions, and active sessions." />
      <div className="tabs">
        {SECTIONS.map((s) => (
          <a
            key={s.key}
            href={`#${s.key}`}
            className={active === s.key ? "active" : ""}
            onClick={() => setActive(s.key)}
          >
            {s.label}
          </a>
        ))}
      </div>
      <div className="stack" style={{ maxWidth: 880 }}>
        <ProfileSection user={user} />
        <AccessSection />
        <SessionsSection />
        <SignOutSection />
      </div>
    </>
  );
}

renderPage(
  "settings",
  <RequireAuth title="Sign in to view settings">{(user) => <SettingsPage user={user} />}</RequireAuth>,
  { crumbs: [{ label: "Account", href: "/settings.html" }, { label: "Settings" }] },
);
