// src/context/Theme.tsx — light / dark / system theme, remembered per browser.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type ThemePref = "system" | "light" | "dark";
const KEY = "escrowx:theme";

const Ctx = createContext<{ pref: ThemePref; resolved: "light" | "dark"; cycle: () => void }>({
  pref: "system",
  resolved: "dark",
  cycle: () => {},
});

function systemDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPref] = useState<ThemePref>("system");
  const [dark, setDark] = useState(true);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved === "light" || saved === "dark") setPref(saved);
    } catch {
      /* storage blocked: follow the system */
    }
    setDark(systemDark());
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (pref === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", pref);
  }, [pref]);

  const cycle = useCallback(() => {
    setPref((p) => {
      const next: ThemePref = p === "system" ? (systemDark() ? "light" : "dark") : p === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(KEY, next);
      } catch {
        /* not persisted */
      }
      return next;
    });
  }, []);

  const resolved = pref === "system" ? (dark ? "dark" : "light") : pref;
  return <Ctx.Provider value={{ pref, resolved, cycle }}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);
