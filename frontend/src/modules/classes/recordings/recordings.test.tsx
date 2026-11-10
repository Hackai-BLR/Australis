import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClassItem } from "../api";
import { formatDelay, splitMatches } from "./api";
import { RecordingPanel } from "./RecordingPanel";

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
  can_teach: false,
  recording_status: "transcript_ready",
  ended_at: null,
} as ClassItem;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

describe("recording helpers", () => {
  it("splits text around case-insensitive matches", () => {
    expect(splitMatches("Hola hola", "HOLA")).toEqual([
      { text: "Hola", match: true },
      { text: " ", match: false },
      { text: "hola", match: true },
    ]);
    expect(splitMatches("abc", " ")).toEqual([{ text: "abc", match: false }]);
  });

  it("formats the delay", () => {
    expect(formatDelay(10)).toBe("menos de 1 min");
    expect(formatDelay(125 * 60)).toBe("2 h 5 min");
  });
});

describe("RecordingPanel", () => {
  it("shows status, baseline, badge and highlights the search", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "transcript_ready",
          simulated: true,
          play_url: "http://x.test/rec",
          duration_s: 180,
          transcript_text: "Buenas tardes\nHoy vemos el caso\n",
          published_at: "2026-11-13 23:00:00",
          delay_seconds: 120,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<RecordingPanel classItem={item} />);
    expect(await screen.findByText("Transcripción lista")).toBeTruthy();
    expect(screen.getByText("Simulado")).toBeTruthy();
    expect(screen.getByText(/72 h/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ver la grabación" }).getAttribute("href")).toBe(
      "http://x.test/rec",
    );
    fireEvent.change(screen.getByLabelText("Buscar en la transcripción"), {
      target: { value: "caso" },
    });
    expect(screen.getByText("1 coincidencia")).toBeTruthy();
    expect(document.querySelector("mark")?.textContent).toBe("caso");
  });
});
