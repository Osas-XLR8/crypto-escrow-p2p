// src/context/Toasts.tsx — in-app toasts, plus optional browser notifications when the tab is in the background.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export interface Toast {
  id: number;
  title: string;
  body?: string;
  tone?: "info" | "ok" | "warn";
  /** Shown as a button; clicking it runs `onAction` and dismisses the toast. */
  actionLabel?: string;
  onAction?: () => void;
}

interface ToastsValue {
  notify: (t: Omit<Toast, "id">) => void;
  browserPermission: NotificationPermission | "unsupported";
  enableBrowserNotifications: () => Promise<void>;
}

const Ctx = createContext<ToastsValue>({ notify: () => {}, browserPermission: "unsupported", enableBrowserNotifications: async () => {} });

const BASE_TITLE = "EscrowX";

export function ToastsProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("unsupported");
  const [unseen, setUnseen] = useState(0);
  const nextId = useRef(1);

  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window) setPermission(Notification.permission);
    const onVisible = () => {
      if (document.visibilityState === "visible") setUnseen(0);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // "(2) EscrowX" in the tab title while things happened in the background.
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, "") || BASE_TITLE;
    document.title = unseen > 0 ? `(${unseen}) ${base}` : base;
  }, [unseen]);

  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);

  const notify = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = nextId.current++;
      setToasts((ts) => [...ts.slice(-3), { ...t, id }]);
      setTimeout(() => dismiss(id), 9000);
      if (document.visibilityState !== "visible") {
        setUnseen((n) => n + 1);
        if ("Notification" in window && Notification.permission === "granted") {
          try {
            const n = new Notification(t.title, { body: t.body, tag: `escrowx-${t.title}`, icon: undefined });
            n.onclick = () => {
              window.focus();
              t.onAction?.();
              n.close();
            };
          } catch {
            /* some browsers only allow notifications from a service worker */
          }
        }
      }
    },
    [dismiss]
  );

  const enableBrowserNotifications = useCallback(async () => {
    if (!("Notification" in window)) return;
    setPermission(await Notification.requestPermission());
  }, []);

  const value = useMemo(() => ({ notify, browserPermission: permission, enableBrowserNotifications }), [notify, permission, enableBrowserNotifications]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone ?? "info"}`}>
            <div className="stack-xs grow">
              <strong className="small">{t.title}</strong>
              {t.body && <span className="small muted">{t.body}</span>}
            </div>
            <div className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
              {t.actionLabel && (
                <button className="btn btn-sm" onClick={() => { t.onAction?.(); dismiss(t.id); }}>{t.actionLabel}</button>
              )}
              <button className="icon-btn" aria-label="Dismiss" onClick={() => dismiss(t.id)}>×</button>
            </div>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToasts = () => useContext(Ctx);
