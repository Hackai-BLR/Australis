import type { RouteObject } from "react-router-dom";
import { RequireRole } from "../../shared/auth";
import type { CampusTab, NavItem } from "../../shared/routing";
import { LoginPage } from "./LoginPage";
import { UsersPage } from "./UsersPage";

/** Pages reachable without a session. */
export const publicRoutes: RouteObject[] = [{ path: "/login", element: <LoginPage /> }];

export const routes: RouteObject[] = [
  {
    path: "/users",
    element: (
      <RequireRole roles={["secretary"]}>
        <UsersPage />
      </RequireRole>
    ),
  },
];

export const campusTabs: CampusTab[] = [];

export const navItems: NavItem[] = [
  { to: "/users", label: "Usuarios", roles: ["secretary"], order: 90 },
];
