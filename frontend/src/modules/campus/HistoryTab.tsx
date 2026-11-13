import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { apiGet, apiPost } from "../../shared/api";
import { Badge, Button, Card, EmptyState, Modal, Spinner, useToast } from "../../shared/ui";
import { DocumentView } from "./DocumentView";
import { setCampusData, useCampusState } from "./store";
import type { CampusDetail, Revision, RevisionEntry, RevisionVia } from "./types";
import "./campus.css";
import { apiErrorMessage } from "../../shared/errors";

const VIA_LABELS: Record<RevisionVia, string> = {
  template: "Plantilla",
  editor: "Edición",
  ai: "IA",
  restore: "Restauración",
};

function formatDate(value: string): string {
  // The API sends UTC as "YYYY-MM-DD HH:MM:SS".
  const date = new Date(value.replace(" ", "T") + "Z");
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("es-AR");
}

function message(err: unknown, fallback: string): string {
  return apiErrorMessage(err, fallback);
}

/** Revision history of the campus; the professor can restore an earlier version. */
export function HistoryTab() {
  const { id = "" } = useParams();
  const toast = useToast();
  const { data: campus } = useCampusState(id);
  const [revisions, setRevisions] = useState<RevisionEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Revision | null>(null);
  const [restoring, setRestoring] = useState<RevisionEntry | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRevisions(await apiGet<RevisionEntry[]>(`/campuses/${id}/revisions`));
      setError(null);
    } catch (err) {
      setError(message(err, "No se pudo cargar el historial."));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function view(entry: RevisionEntry) {
    try {
      setViewing(await apiGet<Revision>(`/campuses/${id}/revisions/${entry.version}`));
    } catch (err) {
      toast.show({ tone: "error", message: message(err, "No se pudo abrir la versión.") });
    }
  }

  async function restore() {
    if (!restoring) return;
    setBusy(true);
    try {
      const updated = await apiPost<CampusDetail>(
        `/campuses/${id}/revisions/${restoring.version}/restore`,
      );
      setCampusData(id, updated);
      toast.show({ tone: "success", message: `Se restauró la versión ${restoring.version}.` });
      setRestoring(null);
      await load();
    } catch (err) {
      toast.show({ tone: "error", message: message(err, "No se pudo restaurar la versión.") });
    } finally {
      setBusy(false);
    }
  }

  if (error) return <EmptyState title="No se pudo cargar el historial" description={error} />;
  if (!revisions) return <Spinner />;

  const canRestore = campus?.access === "manage";
  const latest = revisions[0]?.version;

  return (
    <Card title="Historial de versiones">
      <ul className="cm-revisions">
        {revisions.map((rev) => (
          <li key={rev.id} className="cm-revision">
            <div>
              <strong>Versión {rev.version}</strong> <Badge>{VIA_LABELS[rev.via] ?? rev.via}</Badge>{" "}
              {rev.version === latest && <Badge tone="success">Actual</Badge>}
              <div>{rev.summary}</div>
              <div className="cm-revision__meta">
                {rev.created_by_name ?? "Usuario"} · {formatDate(rev.created_at)}
              </div>
            </div>
            <div className="au-row">
              <Button variant="secondary" size="sm" onClick={() => void view(rev)}>
                Ver
              </Button>
              {canRestore && rev.version !== latest && (
                <Button size="sm" onClick={() => setRestoring(rev)}>
                  Restaurar
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>

      <Modal
        open={viewing !== null}
        title={viewing ? `Versión ${viewing.version}` : ""}
        onClose={() => setViewing(null)}
        footer={
          <Button variant="secondary" onClick={() => setViewing(null)}>
            Cerrar
          </Button>
        }
      >
        {viewing && <DocumentView document={viewing.document} showHidden />}
      </Modal>

      <Modal
        open={restoring !== null}
        title="Restaurar versión"
        onClose={() => setRestoring(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRestoring(null)}>
              Cancelar
            </Button>
            <Button loading={busy} onClick={() => void restore()}>
              Restaurar
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>
          El campus va a volver al contenido de la versión {restoring?.version}. Se guarda como una
          versión nueva y no se pierde el historial.
        </p>
      </Modal>
    </Card>
  );
}
