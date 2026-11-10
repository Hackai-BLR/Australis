import type { RouteObject } from "react-router-dom";
import { RequireRole } from "../../shared/auth";
import type { CampusTab, NavItem } from "../../shared/routing";
import { CampusListPage, CampusOverviewTab } from "./pages";

export const routes: RouteObject[] = [
  {
    path: "/campuses",
    element: (
      <RequireRole roles={["professor"]}>
        <CampusListPage />
      </RequireRole>
    ),
  },
];

export const campusTabs: CampusTab[] = [
  { path: "", label: "Inicio", access: "view", order: 0, element: <CampusOverviewTab /> },
];

export const navItems: NavItem[] = [
  { to: "/campuses", label: "Campus", roles: ["professor"], order: 10 },
];
