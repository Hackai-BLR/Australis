// Composes every module's routes. Feature packages edit only their own module's index/routes;
// this file stays as it is.
import type { RouteObject } from "react-router-dom";
import * as admin from "../modules/admin";
import * as auth from "../modules/auth";
import * as campus from "../modules/campus";
import * as classes from "../modules/classes";
import * as grades from "../modules/grades";
import * as health from "../modules/health";
import * as roster from "../modules/roster";
import * as slides from "../modules/slides";
import * as support from "../modules/support";
import { RequireAuth } from "../shared/auth";
import type { CampusTab, GlobalWidget, NavItem } from "../shared/routing";
import { AppLayout } from "./AppLayout";
import { CampusLayout, CampusTabRoute } from "./CampusLayout";
import { HomePage } from "./pages/HomePage";
import { NotFoundPage } from "./pages/NotFoundPage";

const modules = [auth, campus, roster, grades, classes, slides, admin, support, health];

const navItems: NavItem[] = modules.flatMap((m) => m.navItems);
const campusTabs: CampusTab[] = modules
  .flatMap((m) => m.campusTabs)
  .sort((a, b) => a.order - b.order);
// A module opts in by exporting `globalWidgets` from its index.
const globalWidgets: GlobalWidget[] = modules.flatMap((m): GlobalWidget[] =>
  "globalWidgets" in m ? (m.globalWidgets as GlobalWidget[]) : [],
);

const campusTabRoutes: RouteObject[] = campusTabs.map((tab) => {
  const element = <CampusTabRoute required={tab.access}>{tab.element}</CampusTabRoute>;
  return tab.path ? { path: tab.path, element } : { index: true, element };
});

export const appRoutes: RouteObject[] = [
  ...auth.publicRoutes,
  {
    element: (
      <RequireAuth>
        <AppLayout navItems={navItems} globalWidgets={globalWidgets} />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <HomePage /> },
      ...modules.flatMap((m) => m.routes),
      {
        path: "/campuses/:id",
        element: <CampusLayout tabs={campusTabs} />,
        children: campusTabRoutes,
      },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];

// Opt in to the v7 behaviours now so react-router does not warn and the later upgrade is a no-op.
export const routerFuture = {
  v7_fetcherPersist: true,
  v7_normalizeFormMethod: true,
  v7_partialHydration: true,
  v7_relativeSplatPath: true,
  v7_skipActionErrorRevalidation: true,
} as const;
