import type { RouteObject } from "react-router-dom";
import type { CampusTab, GlobalWidget, NavItem } from "../../shared/routing";
import { ReportProblemSlot } from "./ReportProblemSlot";

export const routes: RouteObject[] = [];

export const campusTabs: CampusTab[] = [];

export const navItems: NavItem[] = [];

/** Shown on every signed-in page by the app shell. */
export const globalWidgets: GlobalWidget[] = [
  { id: "report-problem", element: <ReportProblemSlot /> },
];
