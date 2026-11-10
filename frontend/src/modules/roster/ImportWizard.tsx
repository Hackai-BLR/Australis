import { useRef, useState } from "react";
import { ApiError, apiPost, apiUpload } from "../../shared/api";
import { Badge, Button, Card, Input, Table } from "../../shared/ui";
import {
  FLAG_LABELS,
  INFO_FLAGS,
  type ConfirmResult,
  type Flag,
  type InviteLink,
  type Preview,
} from "./types";

type Step =
  | { name: "input" }
  | { name: "preview"; preview: Preview }
  | { name: "done"; result: ConfirmResult };

function message(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label = "Copiar" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={async () => setState((await copy(text)) ? "copied" : "failed")}
    >
      {state === "copied" ? "Copiado" : state === "failed" ? "No se pudo copiar" : label}
    </Button>
  );
}

/** Table of invite links with a copy button each. Links are shown on screen; no email is sent. */
export function InviteLinks({ invites }: { invites: InviteLink[] }) {
  if (invites.length === 0) return null;
  return (
    <>
      <p>
        Los enlaces se muestran solo ahora y no se envían por correo: copialos y compartilos con
        cada estudiante. Cada uno sirve una vez, para crear la contraseña.
      </p>
      <Table caption="Enlaces de invitación">
        <thead>
          <tr>
            <th>Nombre</th>
            <th>Correo</th>
            <th>Enlace</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {invites.map((i) => (
            <tr key={i.user_id}>
              <td>{i.full_name}</td>
              <td>{i.email}</td>
              <td>
                <code>{i.invite_url}</code>
              </td>
              <td>
                <CopyButton text={i.invite_url} />
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {invites.length > 1 && (
        <p>
          <CopyButton
            text={invites.map((i) => `${i.full_name}\t${i.email}\t${i.invite_url}`).join("\n")}
            label="Copiar todos"
          />
        </p>
      )}
    </>
  );
}

/** Upload or paste -> preview with flags -> confirm -> invite links. */
export function ImportWizard({
  campusId,
  onClose,
  onImported,
}: {
  campusId: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const base = `/campuses/${campusId}/roster/imports`;
  const [step, setStep] = useState<Step>({ name: "input" });
  const [mode, setMode] = useState<"file" | "text">("file");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const run = async (action: () => Promise<void>, fallback: string) => {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (err) {
      setError(message(err, fallback));
    } finally {
      setBusy(false);
    }
  };

  const parse = () =>
    run(async () => {
      let preview: Preview;
      if (mode === "file") {
        const file = fileRef.current?.files?.[0];
        if (!file) {
          setError("Elegí un archivo .xlsx o .csv.");
          return;
        }
        const form = new FormData();
        form.append("file", file);
        preview = await apiUpload<Preview>(base, form);
      } else {
        if (!text.trim()) {
          setError("Pegá la lista de estudiantes.");
          return;
        }
        preview = await apiPost<Preview>(base, { text });
      }
      setStep({ name: "preview", preview });
    }, "No se pudo leer la lista.");

  const confirm = (preview: Preview) =>
    run(async () => {
      const result = await apiPost<ConfirmResult>(`${base}/${preview.id}/confirm`);
      setStep({ name: "done", result });
      onImported();
    }, "No se pudo confirmar la importación.");

  const discard = (preview: Preview) =>
    run(async () => {
      await apiPost(`${base}/${preview.id}/discard`);
      setStep({ name: "input" });
    }, "No se pudo descartar la importación.");

  return (
    <Card
      title="Importar estudiantes"
      actions={
        step.name !== "preview" ? (
          <Button variant="ghost" onClick={onClose}>
            {step.name === "done" ? "Listo" : "Cancelar"}
          </Button>
        ) : undefined
      }
    >
      {error && (
        <p className="au-field__error" role="alert">
          {error}
        </p>
      )}

      {step.name === "input" && (
        <div className="au-stack">
          <div className="au-row">
            <Button
              size="sm"
              variant={mode === "file" ? "primary" : "secondary"}
              onClick={() => setMode("file")}
            >
              Subir archivo
            </Button>
            <Button
              size="sm"
              variant={mode === "text" ? "primary" : "secondary"}
              onClick={() => setMode("text")}
            >
              Pegar lista
            </Button>
          </div>
          {mode === "file" ? (
            <Input
              ref={fileRef}
              label="Archivo de Excel o CSV"
              hint="Se usan solo las columnas de nombre y correo; el resto se descarta."
              type="file"
              accept=".xlsx,.csv,.txt"
            />
          ) : (
            <div className="au-field">
              <label className="au-field__label" htmlFor="roster-text">
                Lista de estudiantes
              </label>
              <textarea
                id="roster-text"
                className="au-input"
                rows={8}
                value={text}
                placeholder={"Ana Pérez <ana@ejemplo.com>\nLuis Gómez; luis@ejemplo.com"}
                onChange={(e) => setText(e.target.value)}
              />
              <span className="au-field__hint">Una persona por línea: nombre y correo.</span>
            </div>
          )}
          <div>
            <Button loading={busy} onClick={parse}>
              Ver vista previa
            </Button>
          </div>
        </div>
      )}

      {step.name === "preview" && <PreviewStep step={step} busy={busy} {...{ confirm, discard }} />}

      {step.name === "done" && (
        <div className="au-stack">
          <p>
            Se crearon {step.result.created} cuentas nuevas y se sumaron{" "}
            {step.result.added_existing} estudiantes que ya tenían cuenta.
            {step.result.skipped > 0 && ` Se omitieron ${step.result.skipped} filas con problemas.`}
          </p>
          <InviteLinks invites={step.result.invites} />
        </div>
      )}
    </Card>
  );
}

function PreviewStep({
  step,
  busy,
  confirm,
  discard,
}: {
  step: { preview: Preview };
  busy: boolean;
  confirm: (p: Preview) => void;
  discard: (p: Preview) => void;
}) {
  const { preview } = step;
  const flagged = Object.entries(preview.counts) as [Flag, number][];
  return (
    <div className="au-stack">
      <p>
        {preview.total} filas leídas, {preview.importable} se pueden importar.
      </p>
      {flagged.length > 0 && (
        <p className="au-row">
          {flagged.map(([flag, n]) => (
            <Badge key={flag} tone={INFO_FLAGS.includes(flag) ? "info" : "warning"}>
              {FLAG_LABELS[flag]}: {n}
            </Badge>
          ))}
        </p>
      )}
      <Table caption="Vista previa de la importación">
        <thead>
          <tr>
            <th>Fila</th>
            <th>Nombre</th>
            <th>Correo</th>
            <th>Estado</th>
          </tr>
        </thead>
        <tbody>
          {preview.rows.map((row) => (
            <tr key={row.line}>
              <td>{row.line}</td>
              <td>{row.full_name || "—"}</td>
              <td>{row.email || "—"}</td>
              <td className="au-row">
                {row.importable && row.flags.length === 0 && <Badge tone="success">Nuevo</Badge>}
                {row.flags.map((flag) => (
                  <Badge
                    key={flag}
                    tone={INFO_FLAGS.includes(flag) ? "info" : "danger"}
                    title={INFO_FLAGS.includes(flag) ? undefined : "Esta fila no se importa."}
                  >
                    {FLAG_LABELS[flag]}
                  </Badge>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      <div className="au-row">
        <Button loading={busy} disabled={preview.importable === 0} onClick={() => confirm(preview)}>
          Confirmar importación
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => discard(preview)}>
          Descartar
        </Button>
      </div>
    </div>
  );
}
