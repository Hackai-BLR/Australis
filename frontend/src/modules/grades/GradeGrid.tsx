import { useRef, type ClipboardEvent, type KeyboardEvent } from "react";
import { Badge } from "../../shared/ui";
import { moveCell, type Cell } from "./nav";
import { formatScore, inScale, parseScore, type Scale } from "./paste";
import type { Item, Student } from "./types";

type Props = {
  students: Student[];
  items: Item[];
  scale: Scale;
  /** The saved score of a cell. */
  saved: (studentId: number, itemId: number) => number | null;
  /** Typed but unsaved text, keyed `studentId:itemId`. */
  drafts: Record<string, string>;
  finals: Map<number, number | null>;
  onEdit: (studentId: number, itemId: number, raw: string) => void;
  /** A multi-cell paste landed on a cell. */
  onPasteBlock: (text: string, anchor: Cell) => void;
  onFocusCell?: (cell: Cell) => void;
};

/** The spreadsheet-like grid: one input per cell, keyboard navigation, paste of whole blocks. */
export function GradeGrid({
  students,
  items,
  scale,
  saved,
  drafts,
  finals,
  onEdit,
  onPasteBlock,
  onFocusCell,
}: Props) {
  const root = useRef<HTMLTableElement>(null);

  const focusCell = (cell: Cell) => {
    const input = root.current?.querySelector<HTMLInputElement>(
      `[data-cell="${cell.row}-${cell.col}"]`,
    );
    input?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>, cell: Cell) => {
    const next = moveCell(cell, event.key, event.shiftKey, students.length, items.length);
    if (!next) return;
    event.preventDefault();
    focusCell(next);
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>, cell: Cell) => {
    const text = event.clipboardData.getData("text");
    // A single value pastes like normal typing; a block goes to the grid.
    if (!/[\t\r\n]/.test(text.replace(/[\r\n]+$/, ""))) return;
    event.preventDefault();
    onPasteBlock(text, cell);
  };

  return (
    <div className="au-table-wrap grades-grid-wrap">
      <table className="au-table grades-grid" ref={root}>
        <thead>
          <tr>
            <th scope="col">Estudiante</th>
            {items.map((item) => (
              <th scope="col" key={item.id} className="grades-grid__score">
                {item.title}
                <span className="grades-grid__weight">peso {formatScore(item.weight)}</span>
              </th>
            ))}
            <th scope="col" className="grades-grid__score">
              Final
            </th>
          </tr>
        </thead>
        <tbody>
          {students.map((student, row) => (
            <tr key={student.user_id} className={student.suspended ? "grades-grid__suspended" : ""}>
              <th scope="row">
                {student.full_name}
                {student.suspended && (
                  <>
                    {" "}
                    <Badge tone="warning" title="Dado de baja: sigue visible con sus notas.">
                      Suspendido
                    </Badge>
                  </>
                )}
              </th>
              {items.map((item, col) => {
                const key = `${student.user_id}:${item.id}`;
                const draft = drafts[key];
                const dirty = draft !== undefined;
                const value = dirty ? draft : formatScore(saved(student.user_id, item.id));
                const parsed = dirty ? parseScore(draft) : null;
                const invalid =
                  parsed !== null &&
                  (!parsed.ok || (parsed.value !== null && !inScale(parsed.value, scale)));
                return (
                  <td
                    key={item.id}
                    className={`grades-grid__cell${dirty ? " is-dirty" : ""}${invalid ? " is-invalid" : ""}`}
                  >
                    <input
                      data-cell={`${row}-${col}`}
                      className="grades-grid__input"
                      inputMode="decimal"
                      autoComplete="off"
                      aria-label={`${student.full_name}, ${item.title}`}
                      aria-invalid={invalid || undefined}
                      title={
                        invalid
                          ? `Ingresá un número entre ${formatScore(scale.min)} y ${formatScore(scale.max)}.`
                          : dirty
                            ? "Sin guardar"
                            : undefined
                      }
                      value={value}
                      onFocus={(e) => {
                        e.currentTarget.select();
                        onFocusCell?.({ row, col });
                      }}
                      onChange={(e) => onEdit(student.user_id, item.id, e.target.value)}
                      onKeyDown={(e) => onKeyDown(e, { row, col })}
                      onPaste={(e) => onPaste(e, { row, col })}
                    />
                  </td>
                );
              })}
              <td className="grades-grid__final">
                {formatScore(finals.get(student.user_id)) || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
