import type { RouteObject } from "react-router-dom";
import { RequireRole } from "../../shared/auth";
import type { CampusTab, NavItem } from "../../shared/routing";
import { AllCampusesPage } from "./AllCampusesPage";
import { PersonPage } from "./PersonPage";

export const routes: RouteObject[] = [
  {
    path: "/admin/campuses",
    element: (
      <RequireRole roles={["secretary"]}>
        <AllCampusesPage />
      </RequireRole>
    ),
  },
  {
    path: "/admin/people/:id",
    element: (
      <RequireRole roles={["secretary"]}>
        <PersonPage />
      </RequireRole>
    ),
  },
];

export const campusTabs: CampusTab[] = [];

export const navItems: NavItem[] = [
  { to: "/admin/campuses", label: "Directorio", roles: ["secretary"], order: 85 },
];
