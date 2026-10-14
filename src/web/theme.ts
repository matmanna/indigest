import { useEffect, useState } from "react";

// Mirrors the inline script in each page's <head>, which applies the theme
// before first paint so there's no flash of the wrong colors.
export type ThemePref = "system" | "light" | "dark";
const KEY = "indigest-theme";
const media = window.matchMedia("(prefers-color-scheme: light)");

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark") return v;
  } catch {}
  return "system";
}

function apply(pref: ThemePref) {
  const resolved = pref === "system" ? (media.matches ? "light" : "dark") : pref;
  document.documentElement.dataset.theme = resolved;
  window.dispatchEvent(new CustomEvent("indigest-theme", { detail: resolved }));
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(readPref);
  useEffect(() => {
    apply(pref);
    if (pref !== "system") return;
    const onChange = () => apply("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [pref]);
  const set = (next: ThemePref) => {
    try {
      if (next === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {}
    setPref(next);
  };
  return { pref, setPref: set };
}

/** The theme actually showing, following system changes. */
export function useResolvedTheme(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">(
    () => (document.documentElement.dataset.theme as "light" | "dark") || "dark",
  );
  useEffect(() => {
    const onTheme = (e: Event) => setTheme((e as CustomEvent).detail);
    window.addEventListener("indigest-theme", onTheme);
    return () => window.removeEventListener("indigest-theme", onTheme);
  }, []);
  return theme;
}
