import "./lockdown";
import { renderNavbar } from "./navbar";

renderNavbar("docs");

const script = document.createElement("script");
script.src = "https://cdn.jsdelivr.net/npm/@scalar/api-reference";
script.onload = () => {
  const Scalar = (window as any).Scalar;
  if (Scalar) {
    Scalar.createApiReference("#app", { url: "/spec.json" });
  }
};
document.head.appendChild(script);
