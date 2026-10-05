import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";

export type ThemeMode = "system" | "light" | "warm" | "dark";
export type EffectiveTheme = "light" | "warm" | "dark";

const DEFAULT_MODE: ThemeMode = "system";
const SETTINGS_KEY = "theme";
const EVENT_THEME_CHANGED = "theme-changed";

interface ThemeContextValue {
  mode: ThemeMode;
  effective: EffectiveTheme;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function resolveEffective(mode: ThemeMode, systemPrefersDark: boolean): EffectiveTheme {
  return mode === "system" ? (systemPrefersDark ? "dark" : "light") : mode;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(DEFAULT_MODE);
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    invoke<string | null>("get_setting", { key: SETTINGS_KEY })
      .then((value) => {
        if (value === '"system"' || value === '"light"' || value === '"warm"' || value === '"dark"') {
          setModeState(JSON.parse(value) as ThemeMode);
        }
      })
      .catch(() => {});

    const unlisten = listen<ThemeMode>(EVENT_THEME_CHANGED, (event) => {
      setModeState(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const effective = resolveEffective(mode, systemPrefersDark);

  useEffect(() => {
    document.documentElement.dataset.theme = effective;
  }, [effective]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    invoke("set_setting", { key: SETTINGS_KEY, value: JSON.stringify(next) }).catch(() => {});
    // Other windows (e.g. the Floating Card, if open) pick this up live.
    void emit(EVENT_THEME_CHANGED, next);
  }, []);

  const value = useMemo(() => ({ mode, effective, setMode }), [mode, effective, setMode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
