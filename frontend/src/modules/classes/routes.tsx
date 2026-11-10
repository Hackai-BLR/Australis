import type { RouteObject } from "react-router-dom";
import { RequireRole } from "../../shared/auth";
import type { CampusTab, NavItem } from "../../shared/routing";
import { ClassesTab } from "./ClassesTab";
import { ClassPage } from "./ClassPage";
import { SimulatedMeetingPage } from "./SimulatedMeetingPage";
import { ZoomConnectPage } from "./ZoomConnectPage";

export const routes: RouteObject[] = [
  { path: "/classes/:cid", element: <ClassPage /> },
  { path: "/simulado/zoom/:id", element: <SimulatedMeetingPage /> },
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
