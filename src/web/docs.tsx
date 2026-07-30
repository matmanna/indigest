import "./lockdown";

const navEl = document.getElementById("navbar")!;
navEl.innerHTML = `<nav class="navbar">
  <a href="/" class="navbar-brand">indigest</a>
  <div class="navbar-links">
    <a href="/">feed map</a>
        <a href="/usage.html">usage</a>
    <a href="/docs.html" class="active">api docs</a>
  </div>
</nav>`;

const script = document.createElement("script");
script.src = "https://cdn.jsdelivr.net/npm/@scalar/api-reference";
script.onload = () => {
  const Scalar = (window as any).Scalar;
  if (Scalar) {
    Scalar.createApiReference("#app", { url: "/spec.json" });
  }
};
document.head.appendChild(script);
