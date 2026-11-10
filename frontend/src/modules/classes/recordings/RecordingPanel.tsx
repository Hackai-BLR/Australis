import { useEffect, useState } from "react";
import { ApiError } from "../../../shared/api";
import { Badge, Button, Card, EmptyState, SimulatedBadge, Spinner } from "../../../shared/ui";
import type { ClassItem } from "../api";
import {
  BASELINE_HOURS,
  downloadTranscript,
  formatDelay,
  getRecording,
  statusLabel,
  statusTone,
  type Recording,
} from "./api";
import { TranscriptViewer } from "./TranscriptViewer";

/** Recording and Zoom transcript of a class, shown on the class page. */
export function RecordingPanel({ classItem }: { classItem: ClassItem }) {
  const [recording, setRecording] = useState<Recording | null>(null);
  const [error, setError] = useState("");

  // Reload when the class is ended or reopened: the backend publishes after the end.
  useEffect(() => {
    let alive = true;
    getRecording(classItem.id)
      .then((value) => alive && setRecording(value))
      .catch((e: unknown) => alive && setError(e instanceof ApiError ? e.message : "Error"));
    return () => {
      alive = false;
    };
  }, [classItem.id, classItem.ended_at]);

  async function download() {
    try {
      await downloadTranscript(classItem.id, "txt");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo descargar la transcripción.");
    }
  }

  if (error && !recording) {
    return (
      <Card title="Grabación y transcripción">
        <EmptyState title="No se pudo cargar la grabación" description={error} />
      </Card>
    );
  }
  if (!recording) {
    return (
      <Card title="Grabación y transcripción">
        <Spinner />
      </Card>
    );
  }

  const status = recording.status;
  const delay = recording.delay_seconds;
  return (
    <Card
      title="Grabación y transcripción"
      actions={recording.simulated ? <SimulatedBadge detail="Grabación de ejemplo." /> : undefined}
    >
      <div className="au-stack">
        <div className="au-row">
          <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>
        </div>
        {status === "none" && (
          <EmptyState
            title="Todavía no hay grabación"
            description={`Cuando termine la clase "${classItem.title}", la grabación y la transcripción van a aparecer acá.`}
          />
        )}
        {status === "pending" && (
          <p>La clase terminó y la grabación se está procesando. Volvé a entrar en unos minutos.</p>
        )}
        {recording.play_url && (
          <p>
            <a href={recording.play_url} target="_blank" rel="noreferrer">
              Ver la grabación
            </a>
          </p>
        )}
        {delay !== null && (
          <p>
            Publicada {formatDelay(delay)} después de terminar la clase. Hoy la demora habitual es
            de {BASELINE_HOURS} h.
          </p>
        )}
        {status === "available" && <p>La transcripción todavía se está generando.</p>}
        {recording.transcript_text && (
          <>
            <div className="au-row">
              <Button variant="secondary" onClick={download}>
                Descargar como texto
              </Button>
            </div>
            {error && <p role="alert">{error}</p>}
            <TranscriptViewer text={recording.transcript_text} />
          </>
        )}
      </div>
    </Card>
  );
}
