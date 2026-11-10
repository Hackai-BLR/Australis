import { ApiError } from "../../shared/api";

export type ErrorContext = "login" | "invite" | "users";

/** Spanish (es-AR) message for a failed request; the server's English text is never shown. */
export function errorMessage(err: unknown, context: ErrorContext, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;
  switch (err.status) {
    case 401:
      return context === "login"
        ? "Correo o contraseña incorrectos."
        : "Tu sesión venció. Volvé a iniciar sesión.";
    case 403:
      return context === "login"
        ? "Tu cuenta no puede ingresar. Consultá con Secretaría."
        : "No tenés permiso para hacer esto.";
    case 404:
      return context === "invite"
        ? "Este enlace ya se usó, venció o no existe."
        : "No se encontró lo que pedías.";
    case 409:
      return context === "invite"
        ? "Este enlace ya se usó o la cuenta ya tiene contraseña."
        : "Ya existe un registro con esos datos.";
    case 422:
      return context === "invite"
        ? "La contraseña no es válida. Probá con otra."
        : "Revisá los datos ingresados.";
    case 429:
      return "Demasiados intentos. Esperá un momento y probá de nuevo.";
    default:
      return err.status >= 500
        ? "Ocurrió un error en el servidor. Probá de nuevo más tarde."
        : fallback;
  }
}
