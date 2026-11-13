import { useEffect, useState, type ReactNode } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { EmptyState, Spinner } from "../ui";
import { hasRole, loginPath, useAuth, type Role } from "./context";
import { goToPlatform, loadAuthMode, platformUrl, type AuthMode } from "./mode";

/** Header mode: there is no login page here, so the browser goes to the platform to sign in. */
function ToPlatform() {
  useEffect(() => {
    goToPlatform();
  }, []);
  return (
    <EmptyState
      title="Tu sesión terminó"
      description="Te llevamos a Campus IA para que vuelvas a entrar."
      action={<a href={platformUrl()}>Ir a Campus IA</a>}
    />
  );
}

/**
 * Renders its children (or the nested route) only for a signed-in user. While the session is
 * being checked it shows a spinner; an anonymous visitor is sent to /login?next=<here>.
 */
export function RequireAuth({ children }: { children?: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  const [mode, setMode] = useState<AuthMode | null>(null);

  useEffect(() => {
    if (status !== "anonymous") return;
    let current = true;
    void loadAuthMode().then((found) => {
      if (current) setMode(found);
    });
    return () => {
      current = false;
    };
  }, [status]);

  if (status === "loading" || (status === "anonymous" && mode === null)) {
    return (
      <div className="au-page-center">
        <Spinner label="Verificando sesión…" />
      </div>
    );
  }
  if (status === "anonymous" && mode === "header") return <ToPlatform />;
  if (status === "anonymous") {
    return <Navigate to={loginPath(location.pathname, location.search)} replace />;
  }
  return <>{children ?? <Outlet />}</>;
}

/**
 * Renders its children only when the user holds one of `roles` (a professor check also admits
 * the secretary). Place it inside RequireAuth. The backend enforces access on its own; this only
 * keeps people away from screens they cannot use.
 */
export function RequireRole({ roles, children }: { roles: readonly Role[]; children?: ReactNode }) {
  const { user } = useAuth();
  if (!hasRole(user, roles)) {
    return (
      <EmptyState
        title="No tenés acceso a esta página"
        description="Tu rol no permite ver esta sección. Si creés que es un error, consultá con Secretaría."
      />
    );
  }
  return <>{children ?? <Outlet />}</>;
}
