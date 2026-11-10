import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "./primitives";
import { ToastContext, type ToastInput, type ToastTone } from "./toast-context";

type ToastItem = { id: number; message: string; tone: ToastTone };

/** Renders queued toasts in a polite live region (errors use role="alert"). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const show = useCallback(
    ({ message, tone = "info", duration = 5000 }: ToastInput) => {
      const id = nextId.current++;
      setToasts((list) => [...list, { id, message, tone }]);
      if (duration > 0)
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="au-toasts" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`au-toast au-toast--${t.tone}`}
            role={t.tone === "error" ? "alert" : "status"}
          >
            <span>{t.message}</span>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Cerrar aviso"
              onClick={() => dismiss(t.id)}
            >
              ✕
            </Button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
