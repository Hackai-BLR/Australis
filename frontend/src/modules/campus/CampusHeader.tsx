import { PageHeader } from "../../shared/ui";
import { useCampusState } from "./store";

const ACCESS_LABELS = {
  manage: "Docente",
  teach: "Docente invitado",
  view: "Estudiante",
} as const;

/** Header shown above the tabs of /campuses/:id: the campus name and the user's standing. */
export function CampusHeader({ campusId }: { campusId: string }) {
  const { data } = useCampusState(campusId);
  return (
    <PageHeader
      title={data?.name ?? "Campus"}
      subtitle={data ? ACCESS_LABELS[data.access] : undefined}
    />
  );
}
