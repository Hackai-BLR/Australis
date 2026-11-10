import { EmptyState, PageHeader } from "../../shared/ui";

// Placeholders: the campus package replaces these with the real screens.

export function CampusListPage() {
  return (
    <>
      <PageHeader title="Campus" subtitle="Los campus que administrás o en los que das clase." />
      <EmptyState
        title="Todavía no hay campus"
        description="Acá vas a crear un campus a partir de una plantilla y darle forma con IA."
      />
    </>
  );
}

export function CampusOverviewTab() {
  return (
    <EmptyState
      title="Inicio del campus"
      description="Acá van a estar las secciones del curso y el asistente para darle forma con IA."
    />
  );
}
