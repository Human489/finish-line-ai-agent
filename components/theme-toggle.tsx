"use client";

import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";

/**
 * Mirrors the portfolio's theme contract (portfolio/js/effects.js):
 * an explicit data-theme="light" | "dark" on <html> wins, and removing the
 * attribute means "follow the OS". The same localStorage key is used, so a
 * choice made on either site carries over when they share an origin.
 */
const THEME_KEY = "portfolio-theme";

type Theme = "light" | "dark" | "auto";

const listeners = new Set<() => void>();

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  // Keep other tabs in sync, matching how the portfolio persists the choice.
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

/**
 * Read from the DOM rather than component state: an inline script in the
 * layout already applies the stored theme before first paint, so the
 * attribute is the source of truth by the time React hydrates.
 */
function getSnapshot(): Theme {
  const explicit = document.documentElement.getAttribute("data-theme");
  return explicit === "light" || explicit === "dark" ? explicit : "auto";
}

/** No DOM on the server; "auto" matches what the markup renders with. */
function getServerSnapshot(): Theme {
  return "auto";
}

function apply(theme: Theme) {
  const root = document.documentElement;

  if (theme === "auto") {
    root.removeAttribute("data-theme");
    try {
      localStorage.removeItem(THEME_KEY);
    } catch {
      // Private browsing or storage disabled — the attribute still applies.
    }
  } else {
    root.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // As above: the theme still applies for this page view.
    }
  }

  for (const listener of listeners) listener();
}

const NEXT: Record<Theme, Theme> = {
  light: "dark",
  dark: "auto",
  auto: "light",
};

const LABEL: Record<Theme, string> = {
  light: "Light",
  dark: "Dark",
  auto: "Auto",
};

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => apply(NEXT[theme])}
      className="text-muted-foreground"
      aria-label={`Theme: ${LABEL[theme]}. Click to change.`}
      title={`Theme: ${LABEL[theme]} (click to cycle light / dark / auto)`}
    >
      {LABEL[theme]}
    </Button>
  );
}
