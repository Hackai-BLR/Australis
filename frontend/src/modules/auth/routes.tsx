import { Navigate, type RouteObject } from "react-router-dom";
import { RequireRole } from "../../shared/auth";
import type { CampusTab, NavItem } from "../../shared/routing";
import { InvitePage } from "./InvitePage";
import { LoginPage } from "./LoginPage";
import { UsersPage } from "./UsersPage";

/** Pages reachable without a session. */
export const publicRoutes: RouteObject[] = [
  { path: "/login", element: <LoginPage /> },
  { path: "/invite/:token", element: <InvitePage /> },
];

export const routes: RouteObject[] = [
  {
    path: "/admin/users",
    element: (
      <RequireRole roles={["secretary"]}>
        <UsersPage />
      </RequireRole>
    ),
  },
  // The app shell's home page still links to /users.
  { path: "/users", element: <Navigate to="/admin/users" replace /> },
];

export const campusTabs: CampusTab[] = [];

export const navItems: NavItem[] = [
  { to: "/admin/users", label: "Usuarios", roles: ["secretary"], order: 90 },
];
