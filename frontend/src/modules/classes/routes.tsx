import type { RouteObject } from "react-router-dom";
import { RequireRole } from "../../shared/auth";
import type { CampusTab, NavItem } from "../../shared/routing";
import { ClassesTab } from "./ClassesTab";
import { ClassPage } from "./ClassPage";
import { ZoomConnectPage } from "./ZoomConnectPage";

export const routes: RouteObject[] = [
  { path: "/classes/:cid", element: <ClassPage /> },
  {
    path: "/zoom",
    element: (
      <RequireRole roles={["professor"]}>
        <ZoomConnectPage />
      </RequireRole>
    ),
  },
];

export const campusTabs: CampusTab[] = [
  { path: "classes", label: "Clases", access: "view", order: 20, element: <ClassesTab /> },
];

export const navItems: NavItem[] = [];
