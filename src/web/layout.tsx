import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import posthog from "posthog-js";
import { PostHogProvider } from "@posthog/react";
import { Navbar } from "./navbar";

posthog.init("phc_BCfnEJYUncGL4otpd7a7MHdtRotSvn5t634cZcnnzbBq", {
  api_host: "https://u.moldycrust.pizza",
  defaults: "2026-05-30",
});

export function RootLayout({
  active,
  children,
}: {
  active: string;
  children: ReactNode;
}) {
  return (
    <StrictMode>
      <PostHogProvider client={posthog}>
        <Navbar active={active} />
        {children}
      </PostHogProvider>
    </StrictMode>
  );
}

export function renderPage(active: string, page: ReactNode) {
  const el = document.getElementById("app");
  if (!el) throw new Error("Missing #app root element");
  createRoot(el).render(<RootLayout active={active}>{page}</RootLayout>);
}
