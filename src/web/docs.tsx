import { useEffect } from "react";
import { renderPage } from "./layout";
import { useResolvedTheme } from "./theme";

const SCALAR_CSS = `
.dark-mode { --scalar-background-1: #000; --scalar-background-2: #0c0c0c; --scalar-background-3: #161616; --scalar-border-color: #1f1f1f; --scalar-color-accent: #fff; }
.light-mode { --scalar-background-1: #fafafa; --scalar-background-2: #fff; --scalar-background-3: #f2f2f2; --scalar-border-color: #e5e5e5; --scalar-color-accent: #0a0a0a; }
.dark-mode, .light-mode { --scalar-font: "Inter", sans-serif; --scalar-font-code: "JetBrains Mono", monospace; }`;

let scalarLoaded: Promise<any> | null = null;
function loadScalar() {
  scalarLoaded ??= new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/@scalar/api-reference";
    script.onload = () => resolve((window as any).Scalar);
    document.head.appendChild(script);
  });
  return scalarLoaded;
}

function DocsPage() {
  const theme = useResolvedTheme();
  useEffect(() => {
    let app: any = null;
    let cancelled = false;
    loadScalar().then((Scalar) => {
      if (cancelled || !Scalar) return;
      app = Scalar.createApiReference("#scalar-api-reference", {
        url: "/spec.json",
        forceDarkModeState: theme,
        hideDarkModeToggle: true,
        withDefaultFonts: false,
        customCss: SCALAR_CSS,
      });
    });
    // Rebuild on theme change; Scalar only reads the mode at creation.
    return () => {
      cancelled = true;
      app?.destroy?.();
      const el = document.getElementById("scalar-api-reference");
      if (el) el.innerHTML = "";
    };
  }, [theme]);

  return <div id="scalar-api-reference" />;
}

renderPage("docs", <DocsPage />, {
  crumbs: [{ label: "Reference" }, { label: "API reference" }],
  wide: true,
});
