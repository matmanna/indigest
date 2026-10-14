import { useEffect, useState } from "react";
import { renderBare } from "./layout";
import { authClient } from "../lib/auth-client";
import { Icon, Notice, Spinner } from "./ui";
import { Brand, ThemeToggle } from "./shell";

const params = new URLSearchParams(location.search);
// Only follow same-site relative paths after sign-in.
const rawNext = params.get("next") || "/";
const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";

function LoginPage() {
  const { data: session, isPending } = authClient.useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(params.get("error"));

  useEffect(() => {
    document.title = "Sign in · indigest";
  }, []);
  useEffect(() => {
    if (session?.user && !params.has("signedout")) window.location.replace(next);
  }, [session?.user]);

  async function signIn() {
    setBusy(true);
    setError(null);
    const res = await authClient.signIn.oauth2({ providerId: "hackclub", callbackURL: next });
    if (res?.error) {
      setError(res.error.message || "Couldn't start sign-in");
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <header className="auth-top">
        <Brand />
        <div className="spacer" />
        <a className="topbar-link" href="/usage.html">
          <Icon name="book" /> Docs
        </a>
        <ThemeToggle compact />
      </header>

      <main className="auth-center">
        <div className="auth-card">
          <h1>Sign in to indigest</h1>
          <p className="lead">Use your Hack Club account to manage channels, pub/sub, and API keys.</p>

          {params.has("signedout") && !error && (
            <div style={{ marginBottom: 20 }}>
              <Notice tone="success" icon="check">You've been signed out.</Notice>
            </div>
          )}
          {error && (
            <div style={{ marginBottom: 20 }}>
              <Notice tone="danger" icon="alert">{error}</Notice>
            </div>
          )}

          <button className="btn btn-primary btn-lg btn-block" onClick={signIn} disabled={busy || isPending}>
            {busy ? <Spinner /> : <Icon name="arrowRight" />}
            Continue with Hack Club
          </button>

          <div className="auth-divider" />
          <ul className="auth-list">
            <li>
              <Icon name="slack" size={15} /> Your Slack identity decides which channels you can manage.
            </li>
            <li>
              <Icon name="shield" size={15} /> indigest never sees your password — it only receives your name, email, and Slack ID.
            </li>
          </ul>
          <div className="auth-divider" />
          <p className="auth-fine">
            Just browsing? <a href="/">Continue without signing in</a>
          </p>
        </div>
      </main>

      <footer className="footer">
        <a href="/usage.html">Slack commands</a>
        <a href="/docs.html">API reference</a>
        <a href="https://github.com/matmanna/indigest" target="_blank" rel="noopener">GitHub</a>
        <a href="https://hackclub.com" target="_blank" rel="noopener">Hack Club</a>
        <span>indigest</span>
      </footer>
    </div>
  );
}

renderBare(<LoginPage />);
