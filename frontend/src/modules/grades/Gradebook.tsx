import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, apiGet, apiPatch, apiPost, apiPut } from "../../shared/api";
import { Button, Card, EmptyState, Input, Modal, Spinner, useToast } from "../../shared/ui";
import { GradeGrid } from "./GradeGrid";
import type { Cell } from "./nav";
import {
  formatScore,
  parseCsv,
  parseScore,
  parseTable,
  itemHasGrades,
  planChanges,
  planPaste,
  type Scale,
} from "./paste";
import type { AuditRow, Gradebook as GradebookData, Item } from "./types";

const ACTIONS: Record<string, string> = {
  set: "cargó",
  update: "cambió",
  clear: "borró",
  create: "creó",
  archive: "archivó",
};

function errorMessage(e: unknown): string {
  return e instanceof ApiError ? e.message : "No se pudo completar la operación.";
}

/** Asks for the reason of a change to a graded item; empty when cancelled or left blank. */
function askItemReason(question: string): string {
  return (window.prompt(question) ?? "").trim();
}

type ItemForm = { id: number | null; title: string; weight: string } | null;

/** The teacher's gradebook: grid with fast entry, evaluations, and the change history. */
export function Gradebook({ campusId }: { campusId: string }) {
  const toast = useToast();
  const [book, setBook] = useState<GradebookData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [anchor, setAnchor] = useState<Cell>({ row: 0, col: 0 });
  const [saving, setSaving] = useState(false);
  const [askReason, setAskReason] = useState(false);
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [form, setForm] = useState<ItemForm>(null);
  const [audit, setAudit] = useState<AuditRow[] | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setBook(await apiGet<GradebookData>(`/campuses/${campusId}/gradebook`));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [campusId]);

  const loadAudit = useCallback(async () => {
    try {
      setAudit(await apiGet<AuditRow[]>(`/campuses/${campusId}/gradebook/audit`));
    } catch (e) {
      toast.show({ message: errorMessage(e), tone: "error" });
    }
  }, [campusId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (auditOpen) void loadAudit();
  }, [auditOpen, loadAudit]);

  const activeItems = useMemo(() => (book?.items ?? []).filter((i) => !i.archived_at), [book]);

  const savedScores = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const e of book?.entries ?? []) map.set(`${e.student_id}:${e.item_id}`, e.score);
    return map;
  }, [book]);
  const saved = useCallback(
    (studentId: number, itemId: number) => savedScores.get(`${studentId}:${itemId}`) ?? null,
    [savedScores],
  );
  const finals = useMemo(
    () => new Map((book?.finals ?? []).map((f) => [f.student_id, f.final])),
    [book],
  );

  if (error && !book)
    return <EmptyState title="No se pudo cargar la planilla" description={error} />;
  if (!book) return <Spinner />;

  const scale: Scale = book.scale;
  const dirtyCount = Object.keys(drafts).length;

  const setDraft = (studentId: number, itemId: number, raw: string) => {
    const key = `${studentId}:${itemId}`;
    const parsed = parseScore(raw);
    const same = parsed.ok && parsed.value === saved(studentId, itemId);
    setDrafts((prev) => {
      const next = { ...prev };
      if (same) delete next[key];
      else next[key] = raw;
      return next;
    });
    setAskReason(false);
    setProblem(null);
  };

  const applyRows = (rows: string[][], at: Cell) => {
    const plan = planPaste(rows, book.students, activeItems.length, at);
    setDrafts((prev) => {
      const next = { ...prev };
      for (const c of plan.cells) {
        const student = book.students[c.studentIndex];
        const item = activeItems[c.itemIndex];
        const key = `${student.user_id}:${item.id}`;
        const parsed = parseScore(c.raw);
        if (parsed.ok && parsed.value === saved(student.user_id, item.id)) delete next[key];
        else next[key] = c.raw;
      }
      return next;
    });
    setAskReason(false);
    const notes: string[] = [`Se pegaron ${plan.cells.length} celdas (sin guardar).`];
    if (plan.mode === "email") notes.push("Se emparejó por email.");
    if (plan.unmatched.length) notes.push(`Sin coincidencia: ${plan.unmatched.join(", ")}.`);
    if (plan.truncated) notes.push(`${plan.truncated} celdas quedaron fuera de la planilla.`);
    setProblem(plan.unmatched.length || plan.truncated ? notes.join(" ") : null);
    toast.show({ message: notes.join(" "), tone: plan.cells.length ? "info" : "error" });
  };

  const copyStudents = async () => {
    const text = book.students.map((s) => `${s.full_name}\t${s.email}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.show({
        message:
          "Lista copiada. Pegala en Excel, sumá las notas a la derecha y volvé a pegar todo acá.",
        tone: "success",
      });
    } catch {
      toast.show({ message: "No se pudo copiar la lista.", tone: "error" });
    }
  };

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    applyRows(parseCsv(await file.text()), anchor);
    if (fileInput.current) fileInput.current.value = "";
  };

  const save = async () => {
    const plan = planChanges(drafts, saved, scale);
    if (plan.invalid.length) {
      setProblem(
        `Hay ${plan.invalid.length} celdas inválidas (marcadas en rojo). Corregilas antes de guardar.`,
      );
      return;
    }
    if (plan.changes.length === 0) {
      setDrafts({});
      return;
    }
    if (plan.overwrites > 0 && !askReason) {
      setAskReason(true);
      return;
    }
    if (plan.overwrites > 0 && !reason.trim()) return;
    setSaving(true);
    try {
      await apiPut(`/campuses/${campusId}/gradebook/entries`, {
        entries: plan.changes,
        reason: plan.overwrites > 0 ? reason.trim() : undefined,
      });
      toast.show({ message: `Se guardaron ${plan.changes.length} notas.`, tone: "success" });
      setDrafts({});
      setAskReason(false);
      setReason("");
      setProblem(null);
      await load();
      if (auditOpen) await loadAudit();
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const saveItem = async () => {
    if (!form) return;
    const weight = parseScore(form.weight);
    if (!form.title.trim() || !weight.ok || weight.value === null || weight.value < 0) {
      toast.show({ message: "Poné un nombre y un peso numérico.", tone: "error" });
      return;
    }
    try {
      if (form.id === null) {
        await apiPost(`/campuses/${campusId}/gradebook/items`, {
          title: form.title,
          weight: weight.value,
        });
      } else {
        const editing = book.items.find((i) => i.id === form.id);
        const changed =
          editing && (editing.title !== form.title.trim() || editing.weight !== weight.value);
        let reason: string | undefined;
        if (changed && itemHasGrades(book.entries, form.id)) {
          const given = askItemReason(
            "Esta evaluación ya tiene notas. ¿Cuál es el motivo del cambio?",
          );
          if (!given) return;
          reason = given;
        }
        await apiPatch(`/gradebook/items/${form.id}`, {
          title: form.title,
          weight: weight.value,
          reason,
        });
      }
      setForm(null);
      await load();
      if (auditOpen) await loadAudit();
    } catch (e) {
      toast.show({ message: errorMessage(e), tone: "error" });
    }
  };

  const archive = async (item: Item) => {
    if (!window.confirm(`¿Archivar "${item.title}"? Sus notas se conservan en el historial.`)) {
      return;
    }
    let reason: string | undefined;
    if (itemHasGrades(book.entries, item.id)) {
      const given = askItemReason(
        "Esta evaluación ya tiene notas. ¿Cuál es el motivo para archivarla?",
      );
      if (!given) return;
      reason = given;
    }
    try {
      await apiPost(`/gradebook/items/${item.id}/archive`, { reason });
      await load();
      if (auditOpen) await loadAudit();
    } catch (e) {
      toast.show({ message: errorMessage(e), tone: "error" });
    }
  };

  const itemTitle = (id: number) => book.items.find((i) => i.id === id)?.title ?? `#${id}`;
  const studentName = (id: number | null) =>
    book.students.find((s) => s.user_id === id)?.full_name ?? "";

  return (
    <div className="au-stack">
      <Card
        title="Evaluaciones"
        actions={
          <Button size="sm" onClick={() => setForm({ id: null, title: "", weight: "1" })}>
            Agregar evaluación
          </Button>
        }
      >
        {activeItems.length === 0 ? (
          <p style={{ margin: 0 }}>
            Todavía no hay evaluaciones. Agregá la primera (por ejemplo, &quot;Parcial 1&quot;) para
            empezar a cargar notas.
          </p>
        ) : (
          <ul className="grades-items">
            {activeItems.map((item) => (
              <li key={item.id}>
                <strong>{item.title}</strong> <span>peso {formatScore(item.weight)}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setForm({ id: item.id, title: item.title, weight: formatScore(item.weight) })
                  }
                >
                  Editar
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void archive(item)}>
                  Archivar
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className="grades-hint">
          La nota final es el promedio ponderado de las notas cargadas (escala{" "}
          {formatScore(scale.min)} a {formatScore(scale.max)}, aprobación {formatScore(scale.pass)}
          ).{" "}
          {book.scale.confirmed === false && "La escala todavía no fue confirmada por el programa."}
        </p>
      </Card>

      {activeItems.length > 0 && book.students.length > 0 ? (
        <Card
          title="Planilla"
          actions={
            <>
              <Button size="sm" variant="secondary" onClick={() => void copyStudents()}>
                Copiar lista de alumnos
              </Button>
              <Button size="sm" variant="secondary" onClick={() => fileInput.current?.click()}>
                Cargar archivo CSV
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept=".csv,.tsv,.txt,text/csv"
                hidden
                aria-label="Archivo CSV de notas"
                onChange={(e) => void loadFile(e.target.files?.[0])}
              />
            </>
          }
        >
          <p className="grades-hint">
            Escribí una nota y apretá Enter para bajar a la siguiente (Tab para ir a la derecha, las
            flechas también). Podés pegar un bloque copiado de Excel: se acepta la coma decimal, y
            si incluye una columna de email se empareja por email.
          </p>
          <GradeGrid
            students={book.students}
            items={activeItems}
            scale={scale}
            saved={saved}
            drafts={drafts}
            finals={finals}
            onEdit={setDraft}
            onPasteBlock={(text, at) => applyRows(parseTable(text), at)}
            onFocusCell={setAnchor}
          />
          <div className="grades-savebar" role="group" aria-label="Guardar notas">
            <span aria-live="polite">
              {dirtyCount === 0 ? "Sin cambios pendientes." : `${dirtyCount} cambios sin guardar.`}
            </span>
            {askReason && (
              <Input
                label="Motivo del cambio (obligatorio al reemplazar notas)"
                value={reason}
                autoFocus
                onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void save();
                }}
              />
            )}
            <Button
              loading={saving}
              disabled={dirtyCount === 0 || (askReason && !reason.trim())}
              onClick={() => void save()}
            >
              {askReason ? "Confirmar y guardar" : "Guardar"}
            </Button>
            {dirtyCount > 0 && (
              <Button
                variant="ghost"
                onClick={() => {
                  setDrafts({});
                  setAskReason(false);
                  setProblem(null);
                }}
              >
                Descartar
              </Button>
            )}
          </div>
          {problem && (
            <p className="grades-problem" role="alert">
              {problem}
            </p>
          )}
        </Card>
      ) : (
        activeItems.length > 0 && (
          <EmptyState
            title="Todavía no hay estudiantes en este curso"
            description="Importá la lista de estudiantes para poder cargar notas."
          />
        )
      )}

      <Card title="Historial de cambios">
        <details onToggle={(e) => setAuditOpen(e.currentTarget.open)}>
          <summary>Ver quién cambió qué y cuándo</summary>
          {audit === null ? (
            <Spinner />
          ) : audit.length === 0 ? (
            <p>Todavía no hay cambios.</p>
          ) : (
            <ul className="grades-audit">
              {audit.map((row) => (
                <li key={row.id}>
                  <time>{row.created_at}</time> {row.actor_name ?? "Sistema"}{" "}
                  {ACTIONS[row.action] ?? row.action}{" "}
                  {row.entity === "grades.entry" ? (
                    <>
                      la nota de {studentName(row.subject_user_id)} en {itemTitle(row.entity_id)}:{" "}
                      {formatScore(row.before?.score) || "—"} →{" "}
                      {formatScore(row.after?.score) || "—"}
                    </>
                  ) : (
                    <>la evaluación {itemTitle(row.entity_id)}</>
                  )}
                  {row.reason && <em> (motivo: {row.reason})</em>}
                </li>
              ))}
            </ul>
          )}
        </details>
      </Card>

      <Modal
        open={form !== null}
        title={form?.id === null ? "Agregar evaluación" : "Editar evaluación"}
        onClose={() => setForm(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setForm(null)}>
              Cancelar
            </Button>
            <Button onClick={() => void saveItem()}>Guardar</Button>
          </>
        }
      >
        {form && (
          <div className="au-stack">
            <Input
              label="Nombre"
              value={form.title}
              autoFocus
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
            <Input
              label="Peso"
              hint="Importancia en el promedio final."
              value={form.weight}
              inputMode="decimal"
              onChange={(e) => setForm({ ...form, weight: e.target.value })}
            />
          </div>
        )}
      </Modal>
    </div>
  );
}
