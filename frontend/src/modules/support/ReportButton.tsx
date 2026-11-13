import { useState, type FormEvent } from "react";
import { useLocation } from "react-router-dom";
import { ApiError } from "../../shared/api";
import { Button, Modal } from "../../shared/ui";
import { sendReport } from "./api";
import { campusIdOf } from "./campusId";
import "./support.css";

/** Floating button on every page; opens a form that files a report about the current page. */
export function ReportButton() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const campusId = campusIdOf(location.pathname);

  const close = () => {
    setOpen(false);
    setText("");
    setError(null);
    setSent(false);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) {
      setError("Contanos qué pasó.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await sendReport({ page: location.pathname, campus_id: campusId, text });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo enviar el reporte.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className="au-report-fab" onClick={() => setOpen(true)}>
        Reportar un problema
      </button>
      <Modal
        open={open}
        title="Reportar un problema"
        onClose={close}
        footer={
          sent ? (
            <Button onClick={close}>Cerrar</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={close}>
                Cancelar
              </Button>
              <Button type="submit" form="au-report-form" loading={busy}>
                Enviar
              </Button>
            </>
          )
        }
      >
        {sent ? (
          <p role="status">
            Gracias, el reporte se envió.{" "}
            {campusId !== null
              ? "Lo van a ver los profesores de este campus."
              : "Lo va a ver la secretaría."}
          </p>
        ) : (
          <form id="au-report-form" onSubmit={submit} className="au-report-form">
            <p className="au-report-form__page">
              Página: <code>{location.pathname}</code>
            </p>
            <label htmlFor="au-report-text">¿Qué pasó?</label>
            <textarea
              id="au-report-text"
              className="au-input"
              rows={5}
              maxLength={4000}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            {error && <p role="alert">{error}</p>}
          </form>
        )}
      </Modal>
    </>
  );
}
