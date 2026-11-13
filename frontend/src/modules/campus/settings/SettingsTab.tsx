import { EmptyState } from "../../../shared/ui";

/** Seam for F14: replace the body with the per-campus settings form. Mounted as a Manage tab. */
export function SettingsTab() {
  return (
    <EmptyState
      title="Configuración del campus"
      description="Todavía no hay opciones para configurar en este campus."
    />
  );
}
