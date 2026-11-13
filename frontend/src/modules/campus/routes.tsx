import type { RouteObject } from "react-router-dom";
import { RequireRole } from "../../shared/auth";
import type { CampusTab, NavItem } from "../../shared/routing";
import { HistoryTab } from "./HistoryTab";
import { CampusListPage, CampusOverviewTab, NewCampusPage } from "./pages";
import { SettingsTab } from "./settings/SettingsTab";

export const routes: RouteObject[] = [
  {
    path: "/campuses",
    element: (
      <RequireRole roles={["professor"]}>
        <CampusListPage />
      </RequireRole>
    ),
  },
  {
    path: "/campuses/new",
    element: (
      <RequireRole roles={["professor"]}>
        <NewCampusPage />
      </RequireRole>
    ),
  },
];

export const campusTabs: CampusTab[] = [
  { path: "", label: "Inicio", access: "view", order: 0, element: <CampusOverviewTab /> },
  {
    path: "settings",
    label: "Configuración",
    access: "manage",
    order: 80,
    element: <SettingsTab />,
  },
  { path: "history", label: "Historial", access: "teach", order: 90, element: <HistoryTab /> },
];

export const navItems: NavItem[] = [
  { to: "/campuses", label: "Campus", roles: ["professor"], order: 10 },
];
