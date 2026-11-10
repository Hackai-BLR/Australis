import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, apiGet, apiPost, setUnauthorizedHandler } from "../api";
import { AuthContext, type AuthContextValue, type AuthStatus, type User } from "./context";

type State = { status: AuthStatus; user: User | null };

/**
 * Holds the signed-in user. On mount it asks GET /api/auth/me: 200 means signed in, 401 (or any
 * failure) means anonymous. While mounted, a 401 from any API call clears the user, and
 * RequireAuth then sends the browser to /login.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading", user: null });

  const refresh = useCallback(async () => {
    try {
      const user = await apiGet<User>("/auth/me", { skipAuthRedirect: true });
      setState({ status: "authenticated", user });
    } catch {
      // 401, network failure or a malformed body: treat as signed out.
      setState({ status: "anonymous", user: null });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => setUnauthorizedHandler(() => setState({ status: "anonymous", user: null })), []);

  const login = useCallback(async (email: string, password: string) => {
    const user = await apiPost<User>(
      "/auth/login",
      { email, password },
      { skipAuthRedirect: true },
    );
    setState({ status: "authenticated", user });
    return user;
  }, []);

  // Only clear the user once the server has ended the session (204), or says there is none
  // (401). Any other failure rethrows and keeps the user: the cookie may still be valid, so
  // showing the login page would hide a live session from the next person at this computer.
  const logout = useCallback(async () => {
    try {
      await apiPost("/auth/logout", undefined, { skipAuthRedirect: true });
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) throw err;
    }
    setState({ status: "anonymous", user: null });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, login, logout, refresh }),
    [state, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
