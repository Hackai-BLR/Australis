import type { ReactNode } from "react";
import type { RouteObject } from "react-router-dom";
import { RequireRole } from "../../shared/auth";
import type { CampusTab, NavItem } from "../../shared/routing";
import { ReportButton } from "./ReportButton";
import { ReportsInbox } from "./ReportsInbox";

export const routes: RouteObject[] = [
  {
    path: "/reports",
    element: (
      <RequireRole roles={["professor", "secretary"]}>
        <ReportsInbox />
      </RequireRole>
    ),
  },
];

export const campusTabs: CampusTab[] = [];

export const navItems: NavItem[] = [
  { to: "/reports", label: "Reportes", roles: ["professor", "secretary"], order: 90 },
];

/** Shown on every page of the signed-in shell. */
export const globalWidgets: ReactNode[] = [<ReportButton key="report-button" />];
