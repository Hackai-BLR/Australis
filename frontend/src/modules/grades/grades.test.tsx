import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { GradeGrid } from "./GradeGrid";
import { moveCell } from "./nav";
import {
  formatScore,
  itemHasGrades,
  parseCsv,
  parseScore,
  parseTable,
  planChanges,
  planPaste,
  type Scale,
} from "./paste";
import type { Item, Student } from "./types";

const scale: Scale = { min: 1, max: 10, pass: 4 };

describe("parseScore", () => {
  it("accepts dots and decimal commas, and treats blank as no score", () => {
    expect(parseScore("7,5")).toEqual({ ok: true, value: 7.5 });
    expect(parseScore(" 7.25 ")).toEqual({ ok: true, value: 7.25 });
    expect(parseScore("10")).toEqual({ ok: true, value: 10 });
    expect(parseScore("")).toEqual({ ok: true, value: null });
    expect(parseScore("abc")).toEqual({ ok: false });
    expect(parseScore("1,2,3")).toEqual({ ok: false });
  });

  it("formats with a decimal comma", () => {
    expect(formatScore(7.5)).toBe("7,5");
    expect(formatScore(null)).toBe("");
  });
});

describe("parseTable and parseCsv", () => {
  it("splits tabs and drops the trailing newline Excel adds", () => {
    expect(parseTable("7,5\t8\r\n9\t6,5\r\n")).toEqual([
      ["7,5", "8"],
      ["9", "6,5"],
    ]);
  });

  it("keeps ragged rows as they are", () => {
    expect(parseTable("1\t2\t3\n4\n\t5")).toEqual([["1", "2", "3"], ["4"], ["", "5"]]);
  });

  it("detects the CSV delimiter and honours quotes", () => {
    expect(parseCsv('email;nota\na@x.com;7,5\n"b@x.com";8')).toEqual([
      ["email", "nota"],
      ["a@x.com", "7,5"],
      ["b@x.com", "8"],
    ]);
    expect(parseCsv('nombre,nota\n"Pérez, Ana",9')).toEqual([
      ["nombre", "nota"],
      ["Pérez, Ana", "9"],
    ]);
  });
});

const students = [{ email: "ana@x.com" }, { email: "beto@x.com" }, { email: "carla@x.com" }];

describe("planPaste", () => {
  it("places rows by position from the anchor", () => {
    const plan = planPaste(
      [
        ["7", "8"],
        ["9", "6"],
      ],
      students,
      3,
      { row: 1, col: 1 },
    );
    expect(plan.mode).toBe("position");
    expect(plan.cells).toEqual([
      { studentIndex: 1, itemIndex: 1, raw: "7" },
      { studentIndex: 1, itemIndex: 2, raw: "8" },
      { studentIndex: 2, itemIndex: 1, raw: "9" },
      { studentIndex: 2, itemIndex: 2, raw: "6" },
    ]);
  });

  it("skips blanks and short rows, and counts what falls outside", () => {
    const plan = planPaste([["7", "", "8"], ["9"], ["1"], ["2"]], students, 2, { row: 0, col: 0 });
    expect(plan.cells.map((c) => c.raw)).toEqual(["7", "9", "1"]);
    expect(plan.truncated).toBe(2); // "8" is past the last item, "2" past the last student
  });

  it("matches by email when a column has one, in any order, skipping the header", () => {
    const plan = planPaste(
      [
        ["Nombre", "Email", "Parcial"],
        ["Carla", "CARLA@x.com", "10"],
        ["Ana", "ana@x.com", "7,5"],
        ["Zoe", "zoe@x.com", "5"],
      ],
      students,
      2,
      { row: 0, col: 0 },
    );
    expect(plan.mode).toBe("email");
    expect(plan.cells).toEqual([
      { studentIndex: 2, itemIndex: 0, raw: "10" },
      { studentIndex: 0, itemIndex: 0, raw: "7,5" },
    ]);
    expect(plan.unmatched).toEqual(["zoe@x.com"]);
  });
});

describe("planChanges", () => {
  const current = (s: number, i: number) => (s === 1 && i === 1 ? 6 : null);

  it("drops unchanged cells, counts overwrites and flags invalid ones", () => {
    const plan = planChanges(
      { "1:1": "8", "2:1": "5,5", "3:1": "11", "4:1": "x", "5:1": "" },
      current,
      scale,
    );
    expect(plan.changes).toEqual([
      { item_id: 1, student_id: 1, score: 8 },
      { item_id: 1, student_id: 2, score: 5.5 },
    ]);
    expect(plan.overwrites).toBe(1);
    expect(plan.invalid).toEqual(["3:1", "4:1"]);
  });

  it("treats clearing an existing score as an overwrite", () => {
    const plan = planChanges({ "1:1": "" }, current, scale);
    expect(plan.changes).toEqual([{ item_id: 1, student_id: 1, score: null }]);
    expect(plan.overwrites).toBe(1);
  });
});

describe("moveCell", () => {
  it("moves with arrows and stops at the edges", () => {
    expect(moveCell({ row: 0, col: 0 }, "ArrowUp", false, 3, 2)).toEqual({ row: 0, col: 0 });
    expect(moveCell({ row: 0, col: 0 }, "ArrowDown", false, 3, 2)).toEqual({ row: 1, col: 0 });
    expect(moveCell({ row: 1, col: 1 }, "ArrowRight", false, 3, 2)).toEqual({ row: 1, col: 1 });
    expect(moveCell({ row: 1, col: 1 }, "ArrowLeft", false, 3, 2)).toEqual({ row: 1, col: 0 });
  });

  it("Enter goes down and wraps to the next column", () => {
    expect(moveCell({ row: 0, col: 0 }, "Enter", false, 3, 2)).toEqual({ row: 1, col: 0 });
    expect(moveCell({ row: 2, col: 0 }, "Enter", false, 3, 2)).toEqual({ row: 0, col: 1 });
    expect(moveCell({ row: 0, col: 1 }, "Enter", true, 3, 2)).toEqual({ row: 2, col: 0 });
  });

  it("Tab goes right and wraps, and lets the browser leave at the end", () => {
    expect(moveCell({ row: 0, col: 0 }, "Tab", false, 3, 2)).toEqual({ row: 0, col: 1 });
    expect(moveCell({ row: 0, col: 1 }, "Tab", false, 3, 2)).toEqual({ row: 1, col: 0 });
    expect(moveCell({ row: 2, col: 1 }, "Tab", false, 3, 2)).toBeNull();
    expect(moveCell({ row: 1, col: 0 }, "Tab", true, 3, 2)).toEqual({ row: 0, col: 1 });
    expect(moveCell({ row: 0, col: 0 }, "a", false, 3, 2)).toBeNull();
  });
});

describe("GradeGrid", () => {
  const people: Student[] = [
    { user_id: 1, full_name: "Ana", email: "ana@x.com", suspended: false },
    { user_id: 2, full_name: "Beto", email: "beto@x.com", suspended: true },
  ];
  const items: Item[] = [
    { id: 10, campus_id: 1, title: "Parcial", weight: 1, position: 1, archived_at: null },
    { id: 11, campus_id: 1, title: "TP", weight: 1, position: 2, archived_at: null },
  ];

  function Harness({ onPasteBlock }: { onPasteBlock?: (t: string) => void }) {
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    return (
      <GradeGrid
        students={people}
        items={items}
        scale={scale}
        saved={(s, i) => (s === 1 && i === 10 ? 6 : null)}
        drafts={drafts}
        finals={new Map()}
        onEdit={(s, i, raw) => setDrafts((d) => ({ ...d, [`${s}:${i}`]: raw }))}
        onPasteBlock={(t) => onPasteBlock?.(t)}
      />
    );
  }

  it("moves focus with Enter, Tab and arrows, and types over the selected value", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const first = screen.getByLabelText<HTMLInputElement>("Ana, Parcial");
    await user.click(first);
    await user.keyboard("8{Enter}");
    expect(document.activeElement).toBe(screen.getByLabelText("Beto, Parcial"));
    expect(first.value).toBe("8");
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByLabelText("Ana, TP"));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByLabelText("Beto, TP"));
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(screen.getByLabelText("Beto, Parcial"));
  });

  it("marks unsaved and invalid cells, and suspended students", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByText("Suspendido")).not.toBeNull();
    const cell = screen.getByLabelText("Ana, TP");
    await user.type(cell, "12");
    expect(cell.getAttribute("aria-invalid")).toBe("true");
    expect(cell.closest("td")?.classList.contains("is-dirty")).toBe(true);
  });

  it("sends a pasted block to the handler instead of the cell", () => {
    const onPasteBlock = vi.fn();
    render(<Harness onPasteBlock={onPasteBlock} />);
    fireEvent.paste(screen.getByLabelText("Ana, Parcial"), {
      clipboardData: { getData: () => "7,5\t8\n9\t6" },
    });
    expect(onPasteBlock).toHaveBeenCalledWith("7,5\t8\n9\t6");
  });
});

describe("itemHasGrades", () => {
  it("is true only when the item has a score", () => {
    const entries = [
      { item_id: 1, score: 7 },
      { item_id: 2, score: null },
    ];
    expect(itemHasGrades(entries, 1)).toBe(true);
    expect(itemHasGrades(entries, 2)).toBe(false);
    expect(itemHasGrades(entries, 3)).toBe(false);
  });
});
