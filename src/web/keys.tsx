import { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { renderNavbar } from "./navbar";
import { authClient } from "../lib/auth-client";
import './lockdown'

renderNavbar("usage");

function KeysList() {
  const { data: session, isPending } = authClient.useSession();
  const [channels, setChannels] = useState<any[]>([]);
  const [keys, setKeys] = useState<any[]>([]);
  const [keysPending, setKeysPending] = useState(true);
  const [channelsPending, setChannelsPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  useEffect(() => {
    if (session?.user?.slackId) {
      fetch(`/api/channels/by-user/${session.user.id}`)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((data) => { setChannels(Array.isArray(data) ? data : []); setChannelsPending(false) })
        .catch((e) => setError(String(e)));
      fetch('api/api-keys').then((r) => r.json()).then((data) => { setKeys(Array.isArray(data) ? data : []); setKeysPending(false) }).catch((e) => setError(String(e)));
    }
  }, [session?.user?.slackId]);

  if (isPending) return <p>loading auth...</p>;
  if (!session?.user?.slackId) {
    return (
      <div className="markdown-body">
        <h1>your api keys</h1>
        <p>session: {JSON.stringify(session, null, 2)}</p>
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setCreatedKey(null);

    const formData = new FormData(e.currentTarget);
    const name = formData.get("name") as string;
    const channelIds = formData.getAll("channels") as string[];

    try {
      const res = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, channelIds }),
      });
      const data = await res.json();
      if (data.fullKey) {
        setCreatedKey(data.fullKey);
      } else {
        setError(data.message || JSON.stringify(data));
      }
    } catch (e: any) {
      setError(String(e));
    }
  }

  return (
    <div class="column">
      {error && <p style={{ color: 'red' }}>Error: {error}</p>}
      {createdKey && (
        <div className="card" style={{ borderColor: 'green' }}>
          <h3>Key created!</h3>
          <p>Copy this key now — it won't be shown again:</p>
          <code style={{ userSelect: 'all', wordBreak: 'break-all' }}>{createdKey}</code>
        </div>
      )}
      <form class="card" onSubmit={handleSubmit}>
        <h2>make a new api key</h2>
        <span>
          <label for="key-name">key name:</label>
          <input class="input" name="name" id="key-name" placeholder="key name" />
        </span>
        <span>
          <label for="key-channels">scoped channels:</label>
          <select class="input" id="key-channels" name="channels" multiple>
            <option value="">--{channelsPending ? "loading channels..." : "select channels"}--</option>
            {channels.map((ch) => (
              <option key={ch.id} value={ch.id}>#{ch.name || ch.id}</option>
            ))}
          </select>
        </span>
        <button type="submit" class="button">make a key!</button>
      </form>

      <div class="keys-list card">
        <h2>your keys</h2>
        {keysPending ? "loading keys..." : null}
        {keys.map((k) => (
          <div class="api-key card">
            {k.name} ind_{k.keyPrefix}... {k.revokedBy && `Revoked by ${k.revokedBy}`} <button onClick={() => {
              fetch(`api/api-keys/${k.id}`, {
                method: "DELETE"
              }).then((r) => r.json()).then((data) => { setKeys(Array.isArray(data) ? data : []); setKeysPending(false) }).catch((e) => setError(String(e)));

            }} class="button red">revoke!</button>
            {(k.channels != null && k.channels.length > 0) ? (
              <>
                <strong>scoped channels: ({k.channels.length})</strong>
                <ul>
                  {k.channels.map((c) => (

                    <li>{c}</li>
                  )

                  )}
                </ul>
              </>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

createRoot(document.getElementById("app")!).render(
  <div className="markdown-body">
    <h1>integrate with indigest</h1>
    <p>for now, all keys are read-only</p>
    <KeysList />
  </div>
);
