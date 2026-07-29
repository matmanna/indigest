import { render } from "preact";

export function Navbar({ active }: { active: string }) {
  return (
    <nav class="navbar">
      <a href="/" class="navbar-brand">indigest</a>
      <div class="navbar-links">
        <a href="/" class={active === "map" ? "active" : ""}>Feed Map</a>
        <a href="/docs.html" class={active === "docs" ? "active" : ""}>API Docs</a>
      </div>
    </nav>
  );
}

export function renderNavbar(active: string) {
  render(<Navbar active={active} />, document.getElementById("navbar")!);
}
