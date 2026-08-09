import { useEffect } from "react";
import "./lockdown";
import { renderPage } from "./layout";

function DocsPage() {
  useEffect(() => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/@scalar/api-reference";
    script.onload = () => {
      const Scalar = (window as any).Scalar;
      if (Scalar) {
        Scalar.createApiReference("#scalar-api-reference", { url: "/spec.json" });
      }
    };
    document.head.appendChild(script);
    return () => script.remove();
  }, []);

  return <div id="scalar-api-reference" />;
}

renderPage("docs", <DocsPage />);
