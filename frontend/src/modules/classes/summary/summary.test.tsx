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

  it("sends the text the professor saw when approving", async () => {
    const draft = { ...base, status: "draft", body: "Texto visto" };
    vi.mocked(fetch)
      .mockResolvedValueOnce(reply(draft))
      .mockResolvedValueOnce(reply({ ...draft, status: "approved" }));
    render(<SummarySlot classItem={item} />);
    fireEvent.click(await screen.findByText("Aprobar y publicar"));
    await screen.findByText(/Aprobado: los estudiantes lo ven/);
    const call = vi.mocked(fetch).mock.calls[1];
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ body: "Texto visto" });
  });

  it("reloads the draft and explains when approving finds the text changed", async () => {
    const draft = { ...base, status: "draft", body: "Texto viejo" };
    vi.mocked(fetch)
      .mockResolvedValueOnce(reply(draft))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "the summary changed" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(reply({ ...draft, body: "Texto nuevo" }));
    render(<SummarySlot classItem={item} />);
    fireEvent.click(await screen.findByText("Aprobar y publicar"));
    expect(await screen.findByText(/El resumen cambió mientras lo mirabas/)).toBeTruthy();
    expect((screen.getByLabelText("Texto del resumen") as HTMLTextAreaElement).value).toBe(
      "Texto nuevo",
    );
  });

  it("hides the Simulado badge once the professor edited the text", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      reply({
        ...base,
        status: "draft",
        body: "Mío",
        simulated: false,
        edited_at: "2026-11-01 10:00:00",
      }),
    );
    render(<SummarySlot classItem={item} />);
    await screen.findByText("Aprobar y publicar");
    expect(screen.queryByText("Simulado")).toBeNull();
  });

  it("shows a clear Spanish message when the daily quota is used up", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(reply(base))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "daily quota used up" }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(reply({ ...base, quota: { limit: 20, used: 20, remaining: 0 } }));
    render(<SummarySlot classItem={item} />);
    fireEvent.click(await screen.findByText("Generar borrador"));
    expect(await screen.findByText(/Alcanzaste el límite diario de resúmenes/)).toBeTruthy();
    expect(screen.queryByText(/daily quota/)).toBeNull();
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
