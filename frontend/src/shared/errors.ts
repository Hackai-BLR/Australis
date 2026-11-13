import { ApiError } from "./api";

/** Spanish (es-AR) message for a failed request; the server's English text is never shown. */
export function apiErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;
  switch (err.status) {
    case 400:
    case 422:
      return "Revisá los datos ingresados.";
    case 401:
      return "Tu sesión venció. Volvé a iniciar sesión.";
    case 403:
      return "No tenés permiso para hacer esto.";
    case 404:
      return "No se encontró lo que pedías.";
    case 409:
      return "Ya existe un registro con esos datos.";
    case 413:
      return "El archivo es demasiado grande.";
    case 429:
      return "Demasiados intentos. Esperá un momento y probá de nuevo.";
    default:
      return err.status >= 500
        ? "Ocurrió un error en el servidor. Probá de nuevo más tarde."
        : fallback;
  }
}
