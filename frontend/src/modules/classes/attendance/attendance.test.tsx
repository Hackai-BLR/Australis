import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClassItem } from "../api";
import { needsReason, pendingEntries, type AttendanceRow } from "./api";
import { AttendancePanel } from "./AttendancePanel";

const item = {
  id: 7,
  campus_id: 1,
  campus_name: "Campus A",
  title: "Clase 1",
  starts_at: "2026-11-13 21:00:00",
  duration_min: 90,
  source: "placeholder",
  simulated: true,
  join_url: "http://x.test/join",
  start_url: null,
  can_teach: true,
  recording_status: "none",
  ended_at: null,
} as ClassItem;

const row = (user_id: number, full_name: string, status: AttendanceRow["status"]) => ({
  user_id,
  full_name,
  status,
  source: status ? ("manual" as const) : null,
  reason: null,
  updated_at: null,
});

function sheet(can_teach: boolean, rows: unknown[]) {
  return {
    class_id: 7,
    can_teach,
    simulated: true,
    rule: { min_percent: 75, confirmed: false },
    late_after_minutes: 15,
    late_after_confirmed: false,
    rows,
  };
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

describe("attendance helpers", () => {
  const rows = [row(1, "Ana", "present"), row(2, "Beto", null)];

  it("lists only the entries that differ from what is saved", () => {
    expect(pendingEntries(rows, { 1: "present", 2: "late" })).toEqual([
      { user_id: 2, status: "late" },
    ]);
  });

  it("asks for a reason only when a saved record changes", () => {
    expect(needsReason(rows, [{ user_id: 2, status: "late" }])).toBe(false);
    expect(needsReason(rows, [{ user_id: 1, status: "absent" }])).toBe(true);
  });
});

describe("AttendancePanel", () => {
  it("shows a student only their own record, with the unconfirmed rule", async () => {
    vi.mocked(fetch).mockResolvedValue(json(sheet(false, [row(1, "Ana", "late")])));
    render(<AttendancePanel classItem={{ ...item, can_teach: false }} />);
    expect(await screen.findByText("Tarde")).toBeTruthy();
    expect(screen.getByText("Sin confirmar")).toBeTruthy();
    expect(screen.queryByText("Guardar asistencia")).toBeNull();
  });

  it("requires a reason to change a saved record", async () => {
    vi.mocked(fetch).mockResolvedValue(json(sheet(true, [row(1, "Ana", "present")])));
    render(<AttendancePanel classItem={item} />);
    const select = await screen.findByLabelText("Estado de Ana");
    fireEvent.change(select, { target: { value: "absent" } });
    const save = screen.getByText("Guardar asistencia").closest("button") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Motivo del cambio"), {
      target: { value: "Error de carga" },
    });
    await waitFor(() => expect(save.disabled).toBe(false));
  });
});
