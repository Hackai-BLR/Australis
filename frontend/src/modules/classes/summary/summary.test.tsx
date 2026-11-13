import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClassItem } from "../api";
import { SummarySlot } from "./SummarySlot";

const item = { id: 7, recording_status: "transcript_ready" } as ClassItem;

const base = {
  status: "none",
  body: null,
  simulated: true,
  generated_at: null,
  edited_at: null,
  approved_at: null,
  can_teach: true,
  transcript_ready: true,
  quota: { limit: 20, used: 1, remaining: 19 },
};

function reply(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

describe("SummarySlot", () => {
  it("lets the professor generate a draft and approve it", async () => {
    const draft = { ...base, status: "draft", body: "Puntos clave\n- Uno" };
    vi.mocked(fetch)
      .mockResolvedValueOnce(reply(base))
      .mockResolvedValueOnce(reply(draft))
      .mockResolvedValueOnce(reply({ ...draft, status: "approved" }));
    render(<SummarySlot classItem={item} />);
    fireEvent.click(await screen.findByText("Generar borrador"));
    expect(await screen.findByText(/Borrador: los estudiantes todavía no lo ven/)).toBeTruthy();
    expect(screen.getByText("Simulado")).toBeTruthy();
    fireEvent.click(screen.getByText("Aprobar y publicar"));
    expect(await screen.findByText(/Aprobado: los estudiantes lo ven/)).toBeTruthy();
  });

  it("shows a student nothing until the summary is approved", async () => {
    vi.mocked(fetch).mockResolvedValue(
      reply({ ...base, can_teach: false, transcript_ready: false, quota: null }),
    );
    render(<SummarySlot classItem={item} />);
    expect(await screen.findByText("Todavía no hay resumen")).toBeTruthy();
  });

  it("shows a student the approved text", async () => {
    vi.mocked(fetch).mockResolvedValue(
      reply({ ...base, can_teach: false, status: "approved", body: "Texto aprobado", quota: null }),
    );
    render(<SummarySlot classItem={item} />);
    expect(await screen.findByText("Texto aprobado")).toBeTruthy();
  });

  it("disables generating when the daily quota is used up", async () => {
    vi.mocked(fetch).mockResolvedValue(
      reply({ ...base, quota: { limit: 2, used: 2, remaining: 0 } }),
    );
    render(<SummarySlot classItem={item} />);
    const button = await screen.findByText("Generar borrador");
    expect((button.closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Alcanzaste el límite diario/)).toBeTruthy();
  });
});
