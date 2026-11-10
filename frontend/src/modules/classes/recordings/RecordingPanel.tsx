import { Card, EmptyState } from "../../../shared/ui";
import type { ClassItem } from "../api";

/**
 * Slot for the recordings package: it replaces this placeholder with the recording player and
 * Zoom's transcript. The class page already renders it with the class.
 */
export function RecordingPanel({ classItem }: { classItem: ClassItem }) {
  return (
    <Card title="Grabación y transcripción">
      <EmptyState
        title="Todavía no hay grabación"
        description={`Cuando termine la clase "${classItem.title}", la grabación y la transcripción van a aparecer acá.`}
      />
    </Card>
  );
}
