import type { RouteObject } from "react-router-dom";
import type { CampusTab, NavItem } from "../../shared/routing";
import { SlidesTab } from "./SlidesTab";

export const routes: RouteObject[] = [];

export const campusTabs: CampusTab[] = [
  { path: "slides", label: "Presentaciones", access: "view", order: 25, element: <SlidesTab /> },
];

export const navItems: NavItem[] = [];
