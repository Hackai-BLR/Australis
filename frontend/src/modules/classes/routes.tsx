import type { RouteObject } from "react-router-dom";
import type { CampusTab, NavItem } from "../../shared/routing";
import { ClassesTab } from "./ClassesTab";

export const routes: RouteObject[] = [];

export const campusTabs: CampusTab[] = [
  { path: "classes", label: "Clases", access: "view", order: 20, element: <ClassesTab /> },
];

export const navItems: NavItem[] = [];
