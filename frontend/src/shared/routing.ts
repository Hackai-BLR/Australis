// Contracts between feature modules and the app shell (src/app/routes.tsx).
//
// Every module's index.ts exports:
//   routes:     RouteObject[] mounted inside the signed-in layout. Use absolute paths
//               ("/campuses"); wrap role-only pages in <RequireRole>.
//   campusTabs: CampusTab[] shown as tabs inside /campuses/:id.
//   navItems:   NavItem[] added to the sidebar (optional; [] when none).
// The auth module also exports publicRoutes (pages reachable without a session, e.g. /login).
import type { ReactNode } from "react";
import type { Role } from "./auth";

/** Decision 5: Manage (secretary or professor member), Teach (Manage plus guest), View (student). */
export type CampusAccess = "manage" | "teach" | "view";

export type CampusTab = {
  /** Path relative to /campuses/:id ("" for the default tab, e.g. "grades"). */
  path: string;
  /** Tab label in Spanish. */
  label: string;
  element: ReactNode;
  /** Lowest access level that sees the tab. The backend still checks every request. */
  access: CampusAccess;
  /** Sort key; lower comes first. */
  order: number;
};

export type NavItem = {
  to: string;
  /** Label in Spanish. */
  label: string;
  /** Roles that see the item (a professor item is also shown to the secretary). */
  roles: readonly Role[];
  order: number;
};
