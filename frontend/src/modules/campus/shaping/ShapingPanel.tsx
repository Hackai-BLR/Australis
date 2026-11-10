import { Card } from "../../../shared/ui";
import type { CampusDocument } from "../types";

export type ShapingPanelProps = {
  campusId: number;
  /** The document version the panel works on; an accepted change must name it. */
  version: number;
  document: CampusDocument;
  /** Call after the campus changed so the page reloads it. */
  onChanged: () => void;
};

/**
 * Slot for the AI shaping panel (propose a change, preview it, accept or reject). The shaping
 * package replaces this placeholder; the campus page already renders it for users who can manage.
 */
export function ShapingPanel(props: ShapingPanelProps) {
  void props;
  return (
    <Card title="Asistente de IA">
      <p style={{ margin: 0 }}>
        Pronto vas a poder pedirle cambios al campus; vas a ver una vista previa antes de
        aceptarlos.
      </p>
    </Card>
  );
}
