import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../../../shared/api";
import { Badge, EmptyState, Spinner } from "../../../shared/ui";
import { formatStart, listClasses, type ClassItem } from "../api";
import { statusLabel, statusTone, type RecordingStatus } from "./api";

/** Compact list of the classes of a campus that already have a recording in progress or ready. */
export function RecordingsList({ campusId }: { campusId: string }) {
  const [items, setItems] = useState<ClassItem[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    listClasses(campusId)
      .then((all) => alive && setItems(all.filter((c) => c.recording_status !== "none")))
      .catch((e: unknown) => alive && setError(e instanceof ApiError ? e.message : "Error"));
    return () => {
      alive = false;
    };
  }, [campusId]);

  if (error)
    return <EmptyState title="No se pudieron cargar las grabaciones" description={error} />;
  if (!items) return <Spinner />;
  if (items.length === 0) return <EmptyState title="Todavía no hay grabaciones" />;
  return (
    <ul className="au-stack">
      {items.map((c) => (
        <li key={c.id} className="au-row">
          <Link to={`/classes/${c.id}`}>{c.title}</Link>
          <span>{formatStart(c.starts_at)}</span>
          <Badge tone={statusTone(c.recording_status as RecordingStatus)}>
            {statusLabel(c.recording_status as RecordingStatus)}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
