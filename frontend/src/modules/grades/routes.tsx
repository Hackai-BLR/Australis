import type { RouteObject } from "react-router-dom";
import type { CampusTab, NavItem } from "../../shared/routing";
import { GradesTab } from "./GradesTab";

export const routes: RouteObject[] = [];

export const campusTabs: CampusTab[] = [
  { path: "grades", label: "Calificaciones", access: "view", order: 40, element: <GradesTab /> },
];

export const navItems: NavItem[] = [];
