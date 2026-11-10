import type { RouteObject } from "react-router-dom";
import type { CampusTab, NavItem } from "../../shared/routing";
import { RosterTab } from "./RosterTab";

export const routes: RouteObject[] = [];

export const campusTabs: CampusTab[] = [
  { path: "students", label: "Estudiantes", access: "manage", order: 30, element: <RosterTab /> },
];

export const navItems: NavItem[] = [];
