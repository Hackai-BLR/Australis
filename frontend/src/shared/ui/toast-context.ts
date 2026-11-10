import { createContext, useContext } from "react";

export type ToastTone = "info" | "success" | "error";

export type ToastInput = {
  message: string;
  tone?: ToastTone;
  /** Milliseconds before it hides; 0 keeps it open. Default 5000. */
  duration?: number;
};

export type ToastApi = { show: (toast: ToastInput) => void };

export const ToastContext = createContext<ToastApi | null>(null);

/** Shows short notifications: `const toast = useToast(); toast.show({ message: "Guardado" })`. */
export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast must be used inside <ToastProvider>");
  return value;
}
