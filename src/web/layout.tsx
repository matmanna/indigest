import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import posthog from "posthog-js";
import { PostHogProvider } from "@posthog/react";
import { AppShell, type Crumb } from "./shell";
import { ToastProvider } from "./ui";

posthog.init("phc_BCfnEJYUncGL4otpd7a7MHdtRotSvn5t634cZcnnzbBq", {
  api_host: "https://u.moldycrust.pizza",
  defaults: "2026-05-30",
});

export function RootLayout({ children }: { children: ReactNode }) {
  return (
    <StrictMode>
      <PostHogProvider client={posthog}>
        <ToastProvider>{children}</ToastProvider>
      </PostHogProvider>
    </StrictMode>
  );
}

function mount(node: ReactNode) {
  const el = document.getElementById("app");
  if (!el) throw new Error("Missing #app root element");
  createRoot(el).render(<RootLayout>{node}</RootLayout>);
}

/** Render a dashboard page inside the sidebar + topbar shell. */
export function renderPage(
  active: string,
  page: ReactNode,
  opts: { crumbs?: Crumb[]; wide?: boolean } = {},
) {
  mount(
    <AppShell
      active={active}
      crumbs={opts.crumbs ?? [{ label: "indigest", href: "/" }]}
      wide={opts.wide}
    >
      {page}
    </AppShell>,
  );
}

/** Render a page with no shell (e.g. sign-in). */
export function renderBare(page: ReactNode) {
  mount(page);
}
