import { PageHeader } from "../../shared/ui";

/**
 * Header shown above the tabs of /campuses/:id. Placeholder: the campus package loads the campus
 * name and its "Simulado" markers from the API.
 */
export function CampusHeader({ campusId }: { campusId: string }) {
  return <PageHeader title={`Campus ${campusId}`} />;
}
