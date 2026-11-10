import { useCallback, useEffect, useState } from "react";
import { ApiError, apiGet, apiPost } from "../../../shared/api";
import { Badge, Button, Card, SimulatedBadge } from "../../../shared/ui";
import { DocumentView } from "../DocumentView";
import type { CampusDocument } from "../types";
import type { Proposal, ProposalStatus, ShapingUsage } from "./types";
import "./shaping.css";

export type ShapingPanelProps = {
  campusId: number;
  /** The document version the panel works on; an accepted change must name it. */
  version: number;
  document: CampusDocument;
  /** Call after the campus changed so the page reloads it. */
  onChanged: () => void;
};

const EXAMPLES = [
  "Agregá una semana sobre ética antes del examen",
  "Agregá la bibliografía",
  "Agregá un aviso de bienvenida",
  "Agregá las entregas",
  "Agregá el cronograma",
];

const STATUS_LABELS: Record<
  ProposalStatus,
  { label: string; tone: "neutral" | "success" | "warning" | "danger" }
> = {
  pending: { label: "Pendiente", tone: "warning" },
  empty: { label: "Sin cambios", tone: "neutral" },
  accepted: { label: "Aceptada", tone: "success" },
  rejected: { label: "Rechazada", tone: "neutral" },
  stale: { label: "Desactualizada", tone: "danger" },
};

function formatDate(value: string): string {
  const date = new Date(value.replace(" ", "T") + "Z");
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("es-AR");
}

/** The API's messages are in English; the screen speaks Spanish. */
function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return "Llegaste al límite de pedidos de hoy.";
    if (err.status === 409) return "El campus cambió después de esta propuesta. Pedila de nuevo.";
  }
  return fallback;
}

/**
 * The AI assistant of the campus page (professors and the secretary only): describe a change,
 * review the proposal next to the current campus, then accept or reject it. Nothing changes
 * until it is accepted, and every accepted change is a revision in the history.
 */
export function ShapingPanel({ campusId, version, document, onChanged }: ShapingPanelProps) {
  const base = `/campuses/${campusId}/ai`;
  const [instruction, setInstruction] = useState("");
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [usage, setUsage] = useState<ShapingUsage | null>(null);
  const [asking, setAsking] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [showCurrent, setShowCurrent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, counter] = await Promise.all([
        apiGet<Proposal[]>(`${base}/proposals`),
        apiGet<ShapingUsage>(`${base}/usage`),
      ]);
      setProposals(list);
      setUsage(counter);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, "No se pudo cargar el asistente."));
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  // The proposal under review: the newest one that is still open.
  const open = proposals.find((p) => p.status === "pending") ?? null;
  const outdated = open !== null && open.base_version !== version;
  const latest = proposals[0] ?? null;
  const simulated = usage?.simulated ?? latest?.simulated ?? true;

  async function ask() {
    const text = instruction.trim();
    if (!text) return;
    setAsking(true);
    setNotice(null);
    try {
      const created = await apiPost<Proposal>(`${base}/proposals`, { instruction: text });
      setShowCurrent(false);
      setInstruction("");
      if (created.status === "empty") setNotice("El asistente no propuso cambios.");
    } catch (err) {
      setNotice(errorMessage(err, "No se pudo pedir la propuesta."));
    } finally {
      setAsking(false);
      await load();
    }
  }

  async function decide(proposal: Proposal, action: "accept" | "reject") {
    setDeciding(true);
    setNotice(null);
    try {
      await apiPost(`${base}/proposals/${proposal.id}/${action}`);
      setNotice(action === "accept" ? "Se aplicaron los cambios." : "Se rechazó la propuesta.");
      if (action === "accept") onChanged();
    } catch (err) {
      setNotice(errorMessage(err, "No se pudo completar la acción."));
      // A stale proposal changed state on the server.
      onChanged();
    } finally {
      setDeciding(false);
      await load();
    }
  }

  return (
    <Card title="Asistente de IA" actions={simulated ? <SimulatedBadge /> : undefined}>
      <div className="cm-stack">
        <p className="sh-quota">
          {usage
            ? `Pedidos de hoy: ${usage.used_today} de ${usage.quota}.`
            : "Cargando el uso del día…"}
          {usage && (
            <> Costo estimado acumulado: US$ {usage.estimated_cost_usd.toFixed(4)} (estimación).</>
          )}
        </p>

        <div>
          <label htmlFor="sh-instruction" className="au-field__label">
            ¿Qué querés cambiar en el campus?
          </label>
          <textarea
            id="sh-instruction"
            className="au-input sh-textarea"
            value={instruction}
            maxLength={1000}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="Por ejemplo: agregá la bibliografía"
          />
        </div>
        <div className="sh-examples" aria-label="Ejemplos de pedidos">
          {EXAMPLES.map((example) => (
            <Button key={example} variant="ghost" size="sm" onClick={() => setInstruction(example)}>
              {example}
            </Button>
          ))}
        </div>
        <div className="sh-actions">
          <Button
            loading={asking}
            disabled={!instruction.trim() || (usage !== null && usage.remaining <= 0)}
            onClick={() => void ask()}
          >
            Pedir propuesta
          </Button>
        </div>
        {usage !== null && usage.remaining <= 0 && (
          <p role="alert" style={{ margin: 0 }}>
            Llegaste al límite de pedidos de hoy. Podés seguir editando el campus a mano.
          </p>
        )}
        {notice && (
          <p role="status" style={{ margin: 0 }}>
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" style={{ margin: 0 }}>
            {error}
          </p>
        )}

        {latest && latest.status === "empty" && (
          <div role="status" className="cm-callout">
            {latest.message}
          </div>
        )}

        {open && (
          <section className="sh-preview" aria-label="Propuesta">
            <h3 style={{ margin: 0 }}>Propuesta</h3>
            <p>{open.message}</p>
            {outdated && (
              <p role="alert">
                El campus cambió después de esta propuesta, así que ya no se puede aceptar. Pedila
                de nuevo.
              </p>
            )}
            <h4>Cambios</h4>
            <ul className="sh-changes">
              {open.changes.map((change, i) => (
                <li key={i}>{change}</li>
              ))}
            </ul>
            <div className="sh-actions" style={{ margin: "var(--space-3) 0" }}>
              <Button
                variant={showCurrent ? "secondary" : "primary"}
                size="sm"
                aria-pressed={!showCurrent}
                onClick={() => setShowCurrent(false)}
              >
                Ver propuesta
              </Button>
              <Button
                variant={showCurrent ? "primary" : "secondary"}
                size="sm"
                aria-pressed={showCurrent}
                onClick={() => setShowCurrent(true)}
              >
                Ver campus actual
              </Button>
            </div>
            {showCurrent ? (
              <DocumentView document={document} showHidden />
            ) : (
              open.preview && <DocumentView document={open.preview} showHidden />
            )}
            <div className="sh-actions" style={{ marginTop: "var(--space-3)" }}>
              <Button
                loading={deciding}
                disabled={outdated}
                onClick={() => void decide(open, "accept")}
              >
                Aceptar
              </Button>
              <Button
                variant="secondary"
                disabled={deciding}
                onClick={() => void decide(open, "reject")}
              >
                Rechazar
              </Button>
            </div>
          </section>
        )}

        {proposals.length > 0 && (
          <section aria-label="Historial de propuestas">
            <h3 style={{ margin: "0 0 var(--space-2)" }}>Propuestas anteriores</h3>
            <ul className="sh-history">
              {proposals.map((p) => (
                <li key={p.id}>
                  <Badge tone={STATUS_LABELS[p.status].tone}>{STATUS_LABELS[p.status].label}</Badge>{" "}
                  {p.instruction}
                  <div className="sh-history__meta">
                    {p.user_name ?? "Usuario"} · {formatDate(p.created_at)}
                    {p.revision_version !== null && ` · versión ${p.revision_version}`}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Card>
  );
}
