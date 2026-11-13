import type { RouteObject } from "react-router-dom";
import { RequireRole } from "../../shared/auth";
import type { CampusTab, GlobalWidget, NavItem } from "../../shared/routing";
import { ReportProblemSlot } from "./ReportProblemSlot";
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

/** Shown on every signed-in page by the app shell. */
export const globalWidgets: GlobalWidget[] = [
  { id: "report-problem", element: <ReportProblemSlot /> },
];
