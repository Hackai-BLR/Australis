import { Fragment, useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { HealthStatus } from "../modules/health";
import { ROLE_LABELS, hasRole, useAuth } from "../shared/auth";
import type { GlobalWidget, NavItem } from "../shared/routing";
import { Button } from "../shared/ui";

/**
 * Signed-in shell: sidebar with role-aware navigation, user box and the current page. The
 * global widgets (exported by modules) are rendered once, on every page.
 */
export function AppLayout({
  navItems,
  globalWidgets = [],
}: {
  navItems: NavItem[];
  globalWidgets?: GlobalWidget[];
}) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [leaving, setLeaving] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  const items = navItems
    .filter((item) => hasRole(user, item.roles))
    .sort((a, b) => a.order - b.order);

  const onLogout = async () => {
    setLeaving(true);
    setLogoutError(null);
    try {
      await logout();
    } catch {
      // The session may still be alive on the server: stay here and say so.
      setLeaving(false);
      setLogoutError("No se pudo cerrar la sesión. Revisá la conexión e intentá de nuevo.");
      return;
    }
    navigate("/login", { replace: true });
  };

  return (
    <>
      <div className="au-shell">
        <aside className="au-sidebar">
          <Link to="/" className="au-brand">
            Australis
          </Link>
          <nav className="au-nav" aria-label="Navegación principal">
            <NavLink to="/" end>
              Inicio
            </NavLink>
            {items.map((item) => (
              <NavLink key={item.to} to={item.to}>
                {item.label}
              </NavLink>
            ))}
          </nav>
          {user && (
            <div className="au-user">
              <span className="au-user__name">{user.full_name}</span>
              <span>{ROLE_LABELS[user.role]}</span>
              <Button variant="secondary" size="sm" onClick={onLogout} loading={leaving}>
                Cerrar sesión
              </Button>
              {logoutError && (
                <p role="alert" className="au-user__error">
                  {logoutError}
                </p>
              )}
            </div>
          )}
        </aside>
        <main className="au-main">
          <div className="au-main__inner">
            <Outlet />
            <footer className="au-footer">
              <HealthStatus />
            </footer>
          </div>
        </main>
      </div>
      <div className="au-global-widgets">
        {globalWidgets.map((widget) => (
          <Fragment key={widget.id}>{widget.element}</Fragment>
        ))}
      </div>
    </>
  );
}
