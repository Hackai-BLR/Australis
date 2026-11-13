import { useEffect, useState } from "react";
import { ApiError } from "../../../shared/api";
import { Badge, Button, Card, EmptyState, SimulatedBadge, Spinner } from "../../../shared/ui";
import type { ClassItem } from "../api";
import { approveSummary, generateSummary, getSummary, saveSummary, type ClassSummary } from "./api";

/** Class summary on the class page: the professor drafts, edits and approves; students read. */
export function SummarySlot({ classItem }: { classItem: ClassItem }) {
  return (
    <div data-slot="class-summary" data-class-id={classItem.id}>
      <SummaryPanel classItem={classItem} />
    </div>
  );
}

function SummaryPanel({ classItem }: { classItem: ClassItem }) {
  const [summary, setSummary] = useState<ClassSummary | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function apply(value: ClassSummary) {
    setSummary(value);
    setText(value.body ?? "");
  }

  useEffect(() => {
    let alive = true;
    getSummary(classItem.id)
      .then((value) => alive && apply(value))
      .catch((e: unknown) => alive && setError(e instanceof ApiError ? e.message : "Error"));
    return () => {
      alive = false;
    };
  }, [classItem.id, classItem.recording_status]);

  async function run(action: () => Promise<ClassSummary>) {
    setBusy(true);
    setError("");
    try {
      apply(await action());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo completar la acción.");
    } finally {
      setBusy(false);
    }
  }

  if (!summary) {
    return (
      <Card title="Resumen de la clase">{error ? <p role="alert">{error}</p> : <Spinner />}</Card>
    );
  }

  const badge = summary.simulated ? (
    <SimulatedBadge detail="Borrador generado por una respuesta preparada, no por un modelo de IA." />
  ) : undefined;

  if (!summary.can_teach) {
    return (
      <Card title="Resumen de la clase" actions={badge}>
        {summary.status === "approved" && summary.body ? (
          <p style={{ whiteSpace: "pre-wrap" }}>{summary.body}</p>
        ) : (
          <EmptyState
            title="Todavía no hay resumen"
            description="Cuando el docente lo revise y lo apruebe, va a aparecer acá."
          />
        )}
      </Card>
    );
  }

  const quota = summary.quota;
  const exhausted = quota !== null && quota.remaining <= 0;
  const changed = summary.body !== null && text.trim() !== summary.body;
  return (
    <Card title="Resumen de la clase" actions={badge}>
      <div className="au-stack">
        {summary.status !== "none" && (
          <div className="au-row">
            {summary.status === "approved" ? (
              <Badge tone="success">Aprobado: los estudiantes lo ven</Badge>
            ) : (
              <Badge tone="warning">Borrador: los estudiantes todavía no lo ven</Badge>
            )}
          </div>
        )}
        {summary.status === "none" && !summary.transcript_ready && (
          <EmptyState
            title="Todavía no hay transcripción"
            description="El resumen se genera a partir de la transcripción de la clase."
          />
        )}
        {summary.status === "none" && summary.transcript_ready && (
          <p>Generá un borrador con los puntos clave y las tareas para la próxima clase.</p>
        )}
        {summary.status !== "none" && (
          <textarea
            aria-label="Texto del resumen"
            className="au-input"
            rows={14}
            value={text}
            maxLength={20000}
            onChange={(e) => setText(e.target.value)}
          />
        )}
        <div className="au-row">
          {summary.status !== "approved" && summary.transcript_ready && (
            <Button
              variant="secondary"
              loading={busy}
              disabled={exhausted}
              onClick={() => run(() => generateSummary(classItem.id))}
            >
              {summary.status === "none" ? "Generar borrador" : "Volver a generar"}
            </Button>
          )}
          {summary.status !== "none" && (
            <Button
              variant="secondary"
              loading={busy}
              disabled={!changed || text.trim() === ""}
              onClick={() => run(() => saveSummary(classItem.id, text))}
            >
              Guardar cambios
            </Button>
          )}
          {summary.status === "draft" && (
            <Button
              loading={busy}
              disabled={changed}
              onClick={() => run(() => approveSummary(classItem.id))}
            >
              Aprobar y publicar
            </Button>
          )}
        </div>
        {summary.status === "approved" && (
          <p>Si lo editás, vuelve a ser un borrador hasta que lo apruebes de nuevo.</p>
        )}
        {quota && (
          <p>
            Generaciones de hoy: {quota.used} de {quota.limit}.
            {exhausted && " Alcanzaste el límite diario."}
          </p>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
    </Card>
  );
}
