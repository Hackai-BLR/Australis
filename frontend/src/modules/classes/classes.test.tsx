import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TodayClass } from "./TodayClass";
import { localToUtcIso, parseUtc } from "./api";

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const base = {
  campus_id: 1,
  campus_name: "Campus A",
  title: "Clase 1",
  starts_at: "2026-11-13 21:00:00",
  duration_min: 90,
  source: "placeholder",
  simulated: true,
  join_url: "http://x.test/join",
  start_url: null,
  can_teach: false,
  recording_status: "none",
  ended_at: null,
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

describe("TodayClass", () => {
  it("shows the join button and the Simulado badge to a student", async () => {
    vi.mocked(fetch).mockResolvedValue(json([{ id: 7, ...base }]));
    render(
      <MemoryRouter>
        <TodayClass />
      </MemoryRouter>,
    );
    const button = await screen.findByRole("button", { name: "Unirme a la clase de hoy" });
    expect(button.closest("a")?.getAttribute("href")).toBe("http://x.test/join");
    expect(screen.getByText("Simulado")).toBeTruthy();
  });

  it("uses the host link for a teacher", async () => {
    vi.mocked(fetch).mockResolvedValue(
      json([{ id: 7, ...base, can_teach: true, start_url: "http://x.test/host" }]),
    );
    render(
      <MemoryRouter>
        <TodayClass />
      </MemoryRouter>,
    );
    const button = await screen.findByRole("button", { name: "Iniciar clase" });
    expect(button.closest("a")?.getAttribute("href")).toBe("http://x.test/host");
  });

  it("says there is no class today", async () => {
    vi.mocked(fetch).mockResolvedValue(json([]));
    render(
      <MemoryRouter>
        <TodayClass />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Hoy no hay clases")).toBeTruthy();
  });
});

describe("time helpers", () => {
  it("parses the backend's UTC timestamps", () => {
    expect(parseUtc("2026-11-13 21:00:00").toISOString()).toBe("2026-11-13T21:00:00.000Z");
  });

  it("converts a local date and time to a UTC ISO string", () => {
    const iso = localToUtcIso("2026-11-13", "18:00");
    expect(new Date(iso).getHours()).toBe(18);
  });
});
