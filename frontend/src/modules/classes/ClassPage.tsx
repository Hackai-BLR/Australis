import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError } from "../../shared/api";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  SimulatedBadge,
  Spinner,
} from "../../shared/ui";
import { formatStart, getClass, updateClass, type ClassItem } from "./api";
import { AttendanceSlot } from "./attendance/AttendanceSlot";
import { RecordingPanel } from "./recordings/RecordingPanel";
import { SummarySlot } from "./summary/SummarySlot";

export function ClassPage() {
  const { cid = "" } = useParams();
  const [item, setItem] = useState<ClassItem | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    getClass(cid)
      .then((value) => alive && setItem(value))
      .catch((e: unknown) => alive && setError(e instanceof ApiError ? e.message : "Error"));
    return () => {
      alive = false;
    };
  }, [cid]);

  if (error) return <EmptyState title="No se pudo abrir la clase" description={error} />;
  if (!item) return <Spinner />;

  async function toggleEnded(current: ClassItem) {
    setBusy(true);
    try {
      setItem(await updateClass(current.id, { ended: !current.ended_at }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }

  const hostLink = item.start_url ?? item.join_url;
  return (
    <div className="au-stack">
      <PageHeader
        title={item.title}
        subtitle={`${item.campus_name} · ${formatStart(item.starts_at)} · ${item.duration_min} min`}
        badge={item.simulated ? <SimulatedBadge detail="Reunión de Zoom simulada." /> : undefined}
        actions={<Link to={`/campuses/${item.campus_id}/classes`}>Volver a las clases</Link>}
      />
      <Card title="Reunión de Zoom">
        <div className="au-row">
          {item.ended_at && <Badge tone="neutral">Finalizada</Badge>}
          {item.can_teach ? (
            <>
              <a href={hostLink} target="_blank" rel="noreferrer">
                <Button>Iniciar clase</Button>
              </a>
              <Button variant="secondary" loading={busy} onClick={() => toggleEnded(item)}>
                {item.ended_at ? "Reabrir clase" : "Marcar como finalizada"}
              </Button>
            </>
          ) : (
            <a href={item.join_url} target="_blank" rel="noreferrer">
              <Button>Unirme a la clase</Button>
            </a>
          )}
        </div>
      </Card>
      <AttendanceSlot classItem={item} />
      <RecordingPanel classItem={item} />
      <SummarySlot classItem={item} />
    </div>
  );
}
