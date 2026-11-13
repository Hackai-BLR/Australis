import { useCallback, useEffect, useState } from "react";
import { ApiError, apiGet, apiPost } from "../../../shared/api";
import { useAuth } from "../../../shared/auth";
import { Badge, Button, Card, Input, type BadgeTone } from "../../../shared/ui";

export type Submission = {
  campus_id: number;
  status: "draft" | "sent" | "checked";
  note: string | null;
  updated_at: string | null;
};

const LABELS: Record<Submission["status"], string> = {
  draft: "Borrador",
  sent: "Enviadas a secretaría",
  checked: "Verificadas",
};

const TONES: Record<Submission["status"], BadgeTone> = {
  draft: "neutral",
  sent: "warning",
  checked: "success",
};

/** Status bar of the grades: the teacher sends them, the secretary checks or returns them. */
export function SubmissionSlot({ campusId }: { campusId: number }) {
  const { user } = useAuth();
  const [sub, setSub] = useState<Submission | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const base = `/campuses/${campusId}/grades/submission`;

  useEffect(() => {
    apiGet<Submission>(base)
      .then(setSub)
      .catch(() => setError("No se pudo cargar el estado de las notas."));
  }, [base]);

  const act = useCallback(
    async (action: "send" | "check" | "return", data?: unknown) => {
      setBusy(true);
      setError(null);
      try {
        setSub(await apiPost<Submission>(`${base}/${action}`, data));
        setNote("");
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "No se pudo completar la acción.");
      } finally {
        setBusy(false);
      }
    },
    [base],
  );

  const secretary = user?.role === "secretary";
  if (!sub) {
    return <div data-slot="grades-submission">{error && <p role="alert">{error}</p>}</div>;
  }
  return (
    <div data-slot="grades-submission">
      <Card
        title="Envío de notas a secretaría"
        actions={<Badge tone={TONES[sub.status]}>{LABELS[sub.status]}</Badge>}
      >
        {sub.status === "draft" && sub.note && (
          <p>
            Secretaría devolvió las notas: <strong>{sub.note}</strong>
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        {sub.status === "draft" && (
          <Button loading={busy} onClick={() => void act("send")}>
            Enviar notas a secretaría
          </Button>
        )}
        {sub.status === "sent" && !secretary && <p>Esperando la verificación de secretaría.</p>}
        {secretary && sub.status !== "draft" && (
          <div className="au-stack">
            {sub.status === "sent" && (
              <div>
                <Button loading={busy} onClick={() => void act("check")}>
                  Marcar como verificadas
                </Button>
              </div>
            )}
            <Input
              label="Nota para devolver las notas al docente"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div>
              <Button
                variant="secondary"
                loading={busy}
                disabled={note.trim() === ""}
                onClick={() => void act("return", { note })}
              >
                Devolver al docente
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
