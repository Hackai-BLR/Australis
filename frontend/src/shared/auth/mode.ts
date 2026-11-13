import { ApiError, apiGet } from "../api";

/**
 * How the backend identifies people. "password" is local development: the login page asks for
 * email and password. "header" is production: Campus IA signs people in, so Australis never shows
 * a login form and sends anonymous visitors to the platform's front door instead.
 */
export type AuthMode = "password" | "header";

/**
 * Asks GET /api/auth/mode. In header mode the platform answers 401 before the request reaches
 * Australis when the person is not signed in, so a 401 also means "header". Any other failure
 * falls back to the password form, which is what local development uses.
 */
export async function loadAuthMode(): Promise<AuthMode> {
  try {
    const body = await apiGet<{ mode?: string }>("/auth/mode", { skipAuthRedirect: true });
    return body.mode === "header" ? "header" : "password";
  } catch (err) {
    return err instanceof ApiError && err.status === 401 ? "header" : "password";
  }
}

/** The platform's front door: the same address without the leading "campus." label. */
export function platformUrl(location: Pick<Location, "protocol" | "host"> = window.location) {
  const prefix = "campus.";
  if (!location.host.startsWith(prefix)) return "/";
  return `${location.protocol}//${location.host.slice(prefix.length)}/`;
}

export function goToPlatform() {
  window.location.assign(platformUrl());
}
