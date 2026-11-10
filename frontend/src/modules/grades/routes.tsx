import type { RouteObject } from "react-router-dom";
import { RequireRole } from "../../shared/auth";
import type { CampusTab, NavItem } from "../../shared/routing";
import { GradesTab } from "./GradesTab";
import { MyGradesPage } from "./MyGrades";
import "./grades.css";

export const routes: RouteObject[] = [
  {
    path: "/grades",
    element: (
      <RequireRole roles={["student"]}>
        <MyGradesPage />
      </RequireRole>
    ),
  },
];

export const campusTabs: CampusTab[] = [
  { path: "grades", label: "Calificaciones", access: "view", order: 40, element: <GradesTab /> },
];

export const navItems: NavItem[] = [
  { to: "/grades", label: "Mis notas", roles: ["student"], order: 30 },
];
