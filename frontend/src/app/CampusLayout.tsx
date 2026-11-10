import type { ReactNode } from "react";
import { NavLink, Outlet, useParams } from "react-router-dom";
import { CampusHeader, useCampusAccess } from "../modules/campus";
import type { CampusAccess, CampusTab } from "../shared/routing";
import { EmptyState } from "../shared/ui";

const RANK: Record<CampusAccess, number> = { view: 1, teach: 2, manage: 3 };

function canSee(access: CampusAccess | null, required: CampusAccess): boolean {
  return access !== null && RANK[access] >= RANK[required];
}

function NoAccess() {
  return (
    <EmptyState
      title="No tenés acceso a esta sección"
      description="Pedile acceso al docente del curso o a Secretaría."
    />
  );
}

/** /campuses/:id: campus header, the tabs the user may see, and the selected tab. */
export function CampusLayout({ tabs }: { tabs: CampusTab[] }) {
  const { id = "" } = useParams();
  const access = useCampusAccess(id);
  if (access === null) return <NoAccess />;

  const visible = tabs.filter((t) => canSee(access, t.access));
  return (
    <>
      <CampusHeader campusId={id} />
      <nav className="au-tabs" aria-label="Secciones del campus">
        {visible.map((t) => (
          <NavLink
            key={t.path || "index"}
            to={t.path ? `/campuses/${id}/${t.path}` : `/campuses/${id}`}
            end={!t.path}
            className="au-tab"
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      <div className="au-tabpanel">
        <Outlet />
      </div>
    </>
  );
}

/** Wraps one tab's page so a typed-in URL cannot open a tab above the user's access level. */
export function CampusTabRoute({
  required,
  children,
}: {
  required: CampusAccess;
  children: ReactNode;
}) {
  const { id = "" } = useParams();
  const access = useCampusAccess(id);
  return canSee(access, required) ? <>{children}</> : <NoAccess />;
}
