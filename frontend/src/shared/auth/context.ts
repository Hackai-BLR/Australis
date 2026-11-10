import { createContext, useContext } from "react";

/** Global user role (decision 5). Campus membership roles are a separate concept. */
export type Role = "student" | "professor" | "secretary";

/** Frozen auth contract: the body of POST /api/auth/login and GET /api/auth/me. */
export type User = {
  id: number;
  email: string;
  full_name: string;
  role: Role;
};

export type AuthStatus = "loading" | "authenticated" | "anonymous";

export type AuthContextValue = {
  status: AuthStatus;
  user: User | null;
  login: (email: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
  /** Re-reads /api/auth/me (e.g. after accepting an invite). */
  refresh: () => Promise<void>;
};

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}

/**
 * True when the user holds one of the roles. The secretary can do everything a professor can,
 * so a check that admits professors also admits the secretary.
 */
export function hasRole(user: User | null, roles: readonly Role[]): boolean {
  if (!user) return false;
  if (roles.includes(user.role)) return true;
  return user.role === "secretary" && roles.includes("professor");
}

export const ROLE_LABELS: Record<Role, string> = {
  student: "Estudiante",
  professor: "Docente",
  secretary: "Secretaría",
};

/** Builds the login URL that brings the user back to where they were. */
export function loginPath(pathname: string, search = ""): string {
  const target = pathname + search;
  if (!target || target === "/" || pathname === "/login") return "/login";
  return `/login?next=${encodeURIComponent(target)}`;
}
