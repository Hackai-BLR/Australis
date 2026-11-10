// Pure helpers for the grade grid: parsing pasted blocks and CSV files, and planning where the
// pasted cells land. No React, so they are easy to test.

export type Scale = { min: number; max: number; pass: number };

export type ScoreParse = { ok: true; value: number | null } | { ok: false };

/** Parses one typed or pasted cell. Accepts decimal commas ("7,5"). Empty means "no score". */
export function parseScore(raw: string): ScoreParse {
  const text = raw.trim().replace(/\s+/g, "");
  if (text === "") return { ok: true, value: null };
  if (!/^[+-]?(\d+([.,]\d*)?|[.,]\d+)$/.test(text)) return { ok: false };
  const value = Number(text.replace(",", "."));
  return Number.isFinite(value) ? { ok: true, value } : { ok: false };
}

export function inScale(value: number, scale: Scale): boolean {
  return value >= scale.min && value <= scale.max;
}

/** Shows a score the way an Argentine teacher writes it ("7,5"). */
export function formatScore(value: number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(Math.round(value * 100) / 100).replace(".", ",");
}

/** Splits delimited text into rows of cells, honouring double quotes. Drops trailing blank rows. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === "") {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c.trim() === "")) rows.pop();
  return rows;
}

/** A block copied from Excel or Google Sheets: tab-separated. */
export function parseTable(text: string): string[][] {
  return parseDelimited(text, "\t");
}

/** A CSV file: the delimiter is a tab, a semicolon or a comma, whichever the first line uses. */
export function parseCsv(text: string): string[][] {
  const first = text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
  const delimiter = first.includes("\t") ? "\t" : first.includes(";") ? ";" : ",";
  return parseDelimited(text, delimiter);
}

export type Anchor = { row: number; col: number };

export type PastedCell = { studentIndex: number; itemIndex: number; raw: string };

export type PastePlan = {
  cells: PastedCell[];
  /** Emails in the pasted block that match no student of the campus. */
  unmatched: string[];
  /** Non-blank cells that fall outside the grid. */
  truncated: number;
  mode: "email" | "position";
};

const EMAIL = /^\S+@\S+$/;

/**
 * Decides which grid cell each pasted cell goes to.
 *
 * - If any row has an email cell, rows are matched to students by that email and the cells to
 *   its right fill the items from `anchor.col`. Rows without an email (a header) are skipped.
 * - Otherwise rows are placed by position from `anchor.row`, cells from `anchor.col`.
 *
 * Blank pasted cells and cells missing from short rows leave the grid untouched.
 */
export function planPaste(
  rows: string[][],
  students: { email: string }[],
  itemCount: number,
  anchor: Anchor,
): PastePlan {
  const emailCell = (row: string[]) => row.findIndex((c) => EMAIL.test(c.trim()));
  const mode = rows.some((r) => emailCell(r) >= 0) ? "email" : "position";
  const cells: PastedCell[] = [];
  const unmatched: string[] = [];
  let truncated = 0;

  const place = (studentIndex: number, values: string[]) => {
    values.forEach((raw, k) => {
      if (raw.trim() === "") return;
      const itemIndex = anchor.col + k;
      if (studentIndex < 0 || studentIndex >= students.length || itemIndex >= itemCount) {
        truncated++;
        return;
      }
      cells.push({ studentIndex, itemIndex, raw });
    });
  };

  if (mode === "email") {
    const byEmail = new Map(students.map((s, i) => [s.email.trim().toLowerCase(), i]));
    for (const row of rows) {
      const at = emailCell(row);
      if (at < 0) continue;
      const email = row[at].trim().toLowerCase();
      const index = byEmail.get(email);
      if (index === undefined) {
        unmatched.push(row[at].trim());
        continue;
      }
      place(index, row.slice(at + 1));
    }
  } else {
    rows.forEach((row, i) => place(anchor.row + i, row));
  }
  return { cells, unmatched, truncated, mode };
}

export type Change = { item_id: number; student_id: number; score: number | null };

export type ChangePlan = {
  changes: Change[];
  /** Cells whose text is not a number, or is outside the scale. */
  invalid: string[];
  /** Changes that replace an existing score (they need a reason). */
  overwrites: number;
};

/** Turns the typed drafts (keyed `studentId:itemId`) into the changes to send. */
export function planChanges(
  drafts: Record<string, string>,
  current: (studentId: number, itemId: number) => number | null,
  scale: Scale,
): ChangePlan {
  const changes: Change[] = [];
  const invalid: string[] = [];
  let overwrites = 0;
  for (const [key, raw] of Object.entries(drafts)) {
    const [studentId, itemId] = key.split(":").map(Number);
    const parsed = parseScore(raw);
    if (!parsed.ok || (parsed.value !== null && !inScale(parsed.value, scale))) {
      invalid.push(key);
      continue;
    }
    const before = current(studentId, itemId);
    if (before === parsed.value) continue;
    if (before !== null) overwrites++;
    changes.push({ item_id: itemId, student_id: studentId, score: parsed.value });
  }
  return { changes, invalid, overwrites };
}

/** Changing or archiving an item that already has scores moves every final, so it needs a reason. */
export function itemHasGrades(
  entries: { item_id: number; score: number | null }[],
  itemId: number,
): boolean {
  return entries.some((e) => e.item_id === itemId && e.score !== null);
}
