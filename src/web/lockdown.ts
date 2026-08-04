interface LockdownUser {
  id: string;
  name: string;
  url: string;
}

function renderLockdownBanner(users: LockdownUser[]) {
  if (users.length === 0) return;

  const banner = document.createElement("div");
  banner.className = "lockdown-banner";

  const message = document.createElement("span");
  message.textContent =
    "🔒 lockdown mode enabled: contact an authorized user (";
  banner.appendChild(message);

  users.forEach((user, index) => {
    const link = document.createElement("a");
    link.href = user.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = `@${user.name || user.id}`;
    banner.appendChild(link);

    if (index < users.length - 1)
      banner.appendChild(document.createTextNode(", "));
  });

  banner.appendChild(document.createTextNode(") to configure the bot"));
  document.body.insertBefore(banner, document.body.firstChild);
}

fetch("/site-config")
  .then((response): Promise<{ lockdownUsers: LockdownUser[] }> | null =>
    response.ok ? response.json() : null,
  )
  .then((config) => {
    const users = config?.lockdownUsers || [];
    if (users.length === 0 || !document.body) return;
    renderLockdownBanner(users);
  })
  .catch(() => {});
