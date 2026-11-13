import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { ApiError, apiGet, apiPost, apiPut } from "../../../shared/api";
import { Badge, Button, Card, EmptyState, Input, Modal, Spinner } from "../../../shared/ui";
import type { SettingChange, SettingEntry, SettingsOverview } from "./types";
import "../campus.css";

const TITLES: Record<string, string> = {
  "grading.scale": "Escala de calificaciones",
  "grading.final_rule": "Regla de la nota final",
  "attendance.rule": "Regla de asistencia",
};

const ACTIONS: Record<string, string> = {
  update: "Cambio",
  clear: "Vuelta al valor general",
};

function num(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

/** A one-line description of a setting value, for the list and the history. */
function describe(key: string, value: Record<string, unknown> | null): string {
  if (!value) return "";
  if (key === "grading.scale") {
    return `De ${num(value.min)} a ${num(value.max)}, aprueba con ${num(value.pass)}`;
  }
  if (key === "grading.final_rule") return "Promedio ponderado";
  if (key === "attendance.rule") return `Asistencia mínima del ${num(value.min_percent)}%`;
  return JSON.stringify(value);
}

function formatDate(value: string): string {
  const date = new Date(value.replace(" ", "T") + "Z");
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("es-AR");
}

function message(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

const ERRORS_ES: Record<string, string> = {
  "the grading scale needs min, max and pass":
    "La escala necesita nota mínima, máxima y de aprobación.",
  "the grading scale needs min < max and a pass mark inside it":
    "La nota mínima debe ser menor que la máxima, y la de aprobación debe estar dentro de la escala.",
  "the grading scale leaves scores already entered outside it":
    "La escala deja afuera notas que ya se cargaron.",
  "this setting cannot be set for one campus":
    "Esta regla no se puede definir para un solo campus.",
};

/** The save error in Spanish: known server messages are mapped, anything else is generic. */
function saveMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const known = ERRORS_ES[err.message];
    if (known) return known;
    if (err.status === 403) return "No tenés permiso para cambiar esta configuración.";
  }
  return "No se pudo guardar el cambio. Revisá los valores e intentá de nuevo.";
}

const FIELD_NAMES: Record<string, string[]> = {
  "grading.scale": ["min", "max", "pass"],
  "attendance.rule": ["min_percent"],
};

type Editing = { entry: SettingEntry; mode: "edit" | "reset" };

/** "Configuración" tab: per-campus overrides of the grading and attendance rules. */
export function SettingsTab() {
  const { id = "" } = useParams();
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [data, setData] = useState<SettingsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiGet<SettingsOverview>(`/campuses/${id}/settings`));
      setError(null);
    } catch (err) {
      setError(message(err, "No se pudo cargar la configuración."));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  function open(entry: SettingEntry, mode: Editing["mode"]) {
    const value = entry.value;
    setFields({
      min: String(value.min ?? ""),
      max: String(value.max ?? ""),
      pass: String(value.pass ?? ""),
      min_percent: String(value.min_percent ?? ""),
    });
    setReason("");
    setSaveError(null);
    setEditing({ entry, mode });
  }

  function buildValue(key: string): Record<string, unknown> {
    if (key === "grading.scale") {
      return {
        min: Number(fields.min),
        max: Number(fields.max),
        pass: Number(fields.pass),
      };
    }
    if (key === "attendance.rule") {
      return { min_percent: Number(fields.min_percent) };
    }
    return { kind: "weighted_mean" };
  }

  async function save() {
    if (!editing) return;
    const { entry, mode } = editing;
    if (mode === "edit" && (FIELD_NAMES[entry.key] ?? []).some((f) => !fields[f]?.trim())) {
      setSaveError("Completá todos los valores numéricos antes de guardar.");
      return;
    }
    setSaveError(null);
    setBusy(true);
    try {
      if (mode === "edit") {
        await apiPut(`/campuses/${id}/settings/${entry.key}`, {
          value: buildValue(entry.key),
          reason,
        });
      } else {
        await apiPost(`/campuses/${id}/settings/${entry.key}/reset`, { reason });
      }
      setNotice({ tone: "success", text: "Se guardó el cambio." });
      setEditing(null);
      await load();
    } catch (err) {
      setSaveError(saveMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (error) return <EmptyState title="No se pudo cargar la configuración" description={error} />;
  if (!data)
    return (
      <div className="au-stack">
        <h2 style={{ margin: 0 }}>Configuración del campus</h2>
        <Spinner />
      </div>
    );

  const key = editing?.entry.key;
  const field = (name: string, label: string) => (
    <Input
      label={label}
      type="number"
      step="any"
      value={fields[name] ?? ""}
      onChange={(e) => setFields({ ...fields, [name]: e.target.value })}
    />
  );

  return (
    <div className="au-stack">
      <h2 style={{ margin: 0 }}>Configuración del campus</h2>
      {notice && (
        <p role={notice.tone === "error" ? "alert" : "status"} style={{ margin: 0 }}>
          {notice.text}
        </p>
      )}
      <p style={{ margin: 0 }}>
        Cada regla vale para todos los campus, salvo que este campus tenga un valor propio. Las
        reglas marcadas como sin confirmar son estimaciones que el programa todavía no validó.
      </p>
      {data.settings.map((entry) => (
        <Card
          key={entry.key}
          title={TITLES[entry.key] ?? entry.key}
          actions={
            <>
              <Badge tone={entry.source === "campus" ? "info" : "neutral"}>
                {entry.source === "campus" ? "Valor de este campus" : "Heredado"}
              </Badge>
              {entry.unconfirmed && <Badge tone="warning">Sin confirmar</Badge>}
            </>
          }
        >
          <p style={{ margin: "0 0 0.75rem" }}>{describe(entry.key, entry.value)}</p>
          {entry.source === "campus" && (
            <p className="cm-revision__meta">
              Valor general: {describe(entry.key, entry.global_value)}
            </p>
          )}
          <div className="au-row">
            <Button size="sm" onClick={() => open(entry, "edit")}>
              Modificar
            </Button>
            {entry.source === "campus" && (
              <Button size="sm" variant="secondary" onClick={() => open(entry, "reset")}>
                Volver al valor general
              </Button>
            )}
          </div>
        </Card>
      ))}

      <Card title="Cambios recientes">
        {data.changes.length === 0 ? (
          <p style={{ margin: 0 }}>Todavía no hay cambios en este campus.</p>
        ) : (
          <ul className="cm-revisions">
            {data.changes.map((change: SettingChange) => (
              <li key={change.id} className="cm-revision">
                <div>
                  <strong>{ACTIONS[change.action] ?? change.action}</strong>{" "}
                  {change.key ? (TITLES[change.key] ?? change.key) : ""}
                  <div>
                    {change.before && change.key ? describe(change.key, change.before) : ""}
                    {change.after && change.key ? ` → ${describe(change.key, change.after)}` : ""}
                  </div>
                  <div>Motivo: {change.reason}</div>
                  <div className="cm-revision__meta">
                    {change.actor_name ?? "Usuario"} · {formatDate(change.created_at)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal
        open={editing !== null}
        title={
          editing
            ? `${editing.mode === "edit" ? "Modificar" : "Volver al valor general"}: ${
                TITLES[editing.entry.key] ?? editing.entry.key
              }`
            : ""
        }
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Cancelar
            </Button>
            <Button loading={busy} disabled={reason.trim() === ""} onClick={() => void save()}>
              Guardar
            </Button>
          </>
        }
      >
        <div className="au-stack">
          {saveError && (
            <p className="au-field__error" role="alert" style={{ margin: 0 }}>
              {saveError}
            </p>
          )}
          {editing?.mode === "edit" && key === "grading.scale" && (
            <>
              {field("min", "Nota mínima")}
              {field("max", "Nota máxima")}
              {field("pass", "Nota de aprobación")}
            </>
          )}
          {editing?.mode === "edit" && key === "attendance.rule" && (
            <>{field("min_percent", "Asistencia mínima (%)")}</>
          )}
          {editing?.mode === "edit" && key === "grading.final_rule" && (
            <p style={{ margin: 0 }}>Promedio ponderado (la única regla disponible).</p>
          )}
          {editing?.mode === "edit" && (
            <p style={{ margin: 0 }}>
              Un valor cargado acá queda sin confirmar hasta que el programa lo valide.
            </p>
          )}
          <Input
            label="Motivo del cambio"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      </Modal>
    </div>
  );
}
