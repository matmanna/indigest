import { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { authClient } from "../lib/auth-client";

function Navbar({ active }: { active: string }) {
  const { data: session, isPending } = authClient.useSession();
  const [stars, setStars] = useState<number | null>(null);

  useEffect(() => {
    const cached = localStorage.getItem("gh_stars");
    const cachedAt = localStorage.getItem("gh_stars_at");
    if (cached && cachedAt && Date.now() - Number(cachedAt) < 10 * 60 * 1000) {
      setStars(Number(cached));
      return;
    }
    fetch("/site-config")
      .then((r) => r.json())
      .then((d: any) => {
        if (d.githubStars != null) {
          setStars(d.githubStars);
          localStorage.setItem("gh_stars", String(d.githubStars));
          localStorage.setItem("gh_stars_at", String(Date.now()));
        }
      })
      .catch(() => { });
  }, []);

  return (
    <nav class="navbar">
      <a href="/" class="navbar-brand">
        indigest
      </a>
      <div class="navbar-links navbar-links-main">
        <a href="/" class={active === "map" ? "active" : ""}>
          feed map
        </a>
        <a href="/docs.html" class={active === "docs" ? "active" : ""}>
          api docs
        </a>
        <a href="/usage.html" class={active === "usage" ? "active" : ""}>
          usage
        </a>

        <a href="https://github.com/matmanna/indigest">
          github (★ {stars ?? "?"}) ↗
          <span class="badge rot-badge">🫵 have you starred yet??? </span>
          {/* (⭐ {stars ?? "?"})          {' '} 〉 */}
        </a>
      </div>
      {isPending ? (
        <p>loading...</p>
      ) : session?.user ? (
        <div class="navbar-links">
          <a href="/keys.html" class={active === "keys" ? "active" : ""}>
            your keys
          </a>
          <button class="button" onClick={() => authClient.signOut()}>
            Log out ({session.user.slackId})
          </button>
        </div>
      ) : (
        <button
          class="button"
          onClick={() => {
            authClient.signIn.oauth2({
              providerId: "hackclub",
              callbackURL: "/",
            });
          }}
        >
          Log in with Hack Club
        </button>
      )}
    </nav>
  );
}

export function renderNavbar(active: string) {
  const el = document.getElementById("navbar");
  if (el) createRoot(el).render(<Navbar active={active} />);
}
