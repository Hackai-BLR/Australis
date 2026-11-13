import { useEffect, useState } from "react";
import { ApiError } from "../../../shared/api";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  SimulatedBadge,
  Spinner,
  Table,
} from "../../../shared/ui";
import type { ClassItem } from "../api";
import {
  getAttendance,
  needsReason,
  pendingEntries,
  saveAttendance,
  STATUS_LABELS,
  STATUS_TONES,
  takeFromSession,
  type AttendanceSheet,
  type AttendanceStatus,
} from "./api";

const OPTIONS = (Object.keys(STATUS_LABELS) as AttendanceStatus[]).map((value) => ({
  value,
  label: STATUS_LABELS[value],
}));

/** Attendance of a class: the teacher takes and corrects it, a student sees their own. */
export function AttendancePanel({ classItem }: { classItem: ClassItem }) {
  const [sheet, setSheet] = useState<AttendanceSheet | null>(null);
  const [draft, setDraft] = useState<Record<number, AttendanceStatus>>({});
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let alive = true;
    getAttendance(classItem.id)
      .then((value) => alive && setSheet(value))
      .catch((e: unknown) => alive && setError(e instanceof ApiError ? e.message : "Error"));
    return () => {
      alive = false;
    };
  }, [classItem.id]);

  if (!sheet) {
    return (
      <Card title="Asistencia">
        {error ? (
          <EmptyState title="No se pudo cargar la asistencia" description={error} />
        ) : (
          <Spinner />
        )}
      </Card>
    );
  }

  const entries = pendingEntries(sheet.rows, draft);
  const reasonNeeded = needsReason(sheet.rows, entries);
  const reasonMissing = reasonNeeded && reason.trim() === "";
  const noMeeting = classItem.source === "manual";
  // Taking from the session may change records it saved before: the same rule as a manual save.
  const sessionNeedsReason = sheet.rows.some((row) => row.source === "session");
  const sessionReasonMissing = sessionNeedsReason && reason.trim() === "";

  function done(next: AttendanceSheet, message: string) {
    setSheet(next);
    setDraft({});
    setReason("");
    setNotice(message);
  }

  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      done(await saveAttendance(classItem.id, entries, reason), "Asistencia guardada.");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo guardar la asistencia.");
    } finally {
      setBusy(false);
    }
  }

  async function fromSession() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await takeFromSession(classItem.id, reason);
      const extra =
        result.unmatched.length > 0
          ? ` No coinciden con ningún alumno: ${result.unmatched.join(", ")}.`
          : "";
      done(result, `Asistencia tomada de la sesión.${extra}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo tomar la asistencia.");
    } finally {
      setBusy(false);
    }
  }

  const rule = (
    <p className="au-hint">
      Asistencia mínima: {sheet.rule.min_percent}%{" "}
      {!sheet.rule.confirmed && <Badge tone="warning">Sin confirmar</Badge>}
    </p>
  );

  if (!sheet.can_teach) {
    const own = sheet.rows[0];
    return (
      <Card title="Mi asistencia">
        <div className="au-stack">
          {own && own.status ? (
            <div className="au-row">
              <Badge tone={STATUS_TONES[own.status]}>{STATUS_LABELS[own.status]}</Badge>
              {own.source === "session" && sheet.simulated && (
                <SimulatedBadge detail="Estado tomado de una lista de participantes de ejemplo." />
              )}
              {own.reason && <span>Motivo: {own.reason}</span>}
            </div>
          ) : (
            <p>Todavía no se cargó tu asistencia a esta clase.</p>
          )}
          {rule}
        </div>
      </Card>
    );
  }

  return (
    <Card
      title="Asistencia"
      actions={
        sheet.simulated ? <SimulatedBadge detail="Lista de participantes de ejemplo." /> : undefined
      }
    >
      <div className="au-stack">
        {rule}
        <p className="au-hint">
          Al tomar la asistencia de la sesión, quien entra después de {sheet.late_after_minutes}{" "}
          minutos figura como tarde.{" "}
          {!sheet.late_after_confirmed && <Badge tone="warning">Sin confirmar</Badge>}
        </p>
        {sheet.rows.length === 0 ? (
          <EmptyState
            title="No hay alumnos activos"
            description="Importá o agregá alumnos al campus para tomar asistencia."
          />
        ) : (
          <Table caption="Asistencia por alumno">
            <thead>
              <tr>
                <th>Alumno</th>
                <th>Estado</th>
                <th>Último motivo</th>
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row) => (
                <tr key={row.user_id}>
                  <td>{row.full_name}</td>
                  <td>
                    <select
                      className="au-select"
                      aria-label={`Estado de ${row.full_name}`}
                      value={draft[row.user_id] ?? row.status ?? ""}
                      onChange={(e) =>
                        setDraft({ ...draft, [row.user_id]: e.target.value as AttendanceStatus })
                      }
                    >
                      {row.status === null && draft[row.user_id] === undefined && (
                        <option value="">Sin cargar</option>
                      )}
                      {OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>{row.reason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Input
          label="Motivo del cambio"
          hint="Obligatorio para modificar una asistencia ya guardada."
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
        />
        {noMeeting && (
          <p className="au-hint">
            Esta clase no tiene reunión de Zoom: cargá la asistencia a mano.
          </p>
        )}
        {!noMeeting && sessionReasonMissing && (
          <p className="au-hint">
            Ya hay asistencia tomada de la sesión: escribí el motivo del cambio para volver a
            tomarla.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        <div className="au-row">
          <Button loading={busy} disabled={entries.length === 0 || reasonMissing} onClick={save}>
            Guardar asistencia
          </Button>
          <Button
            variant="secondary"
            loading={busy}
            disabled={noMeeting || sessionReasonMissing}
            onClick={fromSession}
          >
            Tomar de la sesión
          </Button>
        </div>
      </div>
    </Card>
  );
}
