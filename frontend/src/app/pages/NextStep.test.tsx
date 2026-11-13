import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../shared/auth";
import { pickStep } from "./nextStepLogic";
import { StudentHome } from "./StudentHome";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const today = {
  id: 7,
  campus_name: "Seminario A",
  title: "Clase 1",
  starts_at: "2099-11-13 21:00:00",
  duration_min: 90,
  simulated: true,
  join_url: "http://x.test/join",
  ended_at: null,
};
const recorded = {
  id: 9,
  campus_name: "Seminario A",
  title: "Clase 0",
  recording_status: "available",
  ended_at: "2026-11-12 22:00:00",
};
const grades = {
  scale: { pass: 6 },
  courses: [
    { campus_id: 1, campus_name: "Seminario A", final: 8, items: [{ item_id: 3, score: 8 }] },
  ],
};

function mock(opts: { today?: unknown[]; classes?: unknown[]; grades?: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/auth/me")
        return json(200, { id: 1, email: "a@b.test", full_name: "Ada", role: "student" });
      if (url === "/api/campuses") return json(200, [{ id: 1, name: "Seminario A" }]);
      if (url === "/api/campuses/1/classes") return json(200, opts.classes ?? []);
      if (url === "/api/classes/today") return json(200, opts.today ?? []);
      if (url === "/api/grades/mine")
        return json(200, opts.grades ?? { scale: { pass: 6 }, courses: [] });
      return json(404, { error: "no" });
    }),
  );
}

function renderHome() {
  render(
    <AuthProvider>
      <MemoryRouter>
        <StudentHome />
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("pickStep", () => {
  it("prefers a class today over a recording and a grade", () => {
    expect(pickStep([today], [recorded], grades, [], []).kind).toBe("class");
  });
  it("ignores a class that already ended", () => {
    const s = pickStep([{ ...today, ended_at: "2026-11-13 22:30:00" }], [recorded], grades, [], []);
    expect(s.kind).toBe("recording");
  });
  it("ignores a class past its duration that nobody ended, and shows the next one", () => {
    const over = { ...today, id: 1, starts_at: "2026-11-13 09:00:00" };
    const later = { ...today, id: 2, title: "Clase 2", starts_at: "2026-11-13 19:00:00" };
    const now = new Date("2026-11-13T16:00:00Z");
    const s = pickStep([over, later], [recorded], grades, [], [], now);
    expect(s.kind === "class" && s.item.id).toBe(2);
    expect(pickStep([over], [recorded], grades, [], [], now).kind).toBe("recording");
  });
  it("prefers a recording over a grade, and skips a seen recording", () => {
    expect(pickStep([], [recorded], grades, [], []).kind).toBe("recording");
    expect(pickStep([], [recorded], grades, [9], []).kind).toBe("grade");
  });
  it("skips seen grades and says nothing is pending", () => {
    expect(pickStep([], [], grades, [], [3]).kind).toBe("none");
  });
});

describe("NextStep card", () => {
  it("shows the class today with a join button", async () => {
    mock({ today: [today], classes: [recorded], grades });
    renderHome();
    expect(await screen.findByRole("button", { name: "Unirme a la clase" })).toBeTruthy();
  });

  it("shows a new recording when there is no class today", async () => {
    mock({ classes: [recorded], grades });
    renderHome();
    expect(await screen.findByText(/Ya está la grabación de Clase 0/)).toBeTruthy();
  });

  it("shows a new grade when nothing else is pending", async () => {
    mock({ grades });
    renderHome();
    expect(await screen.findByText(/Tenés una nota nueva/)).toBeTruthy();
  });

  it("says the student is up to date", async () => {
    mock({});
    renderHome();
    expect(await screen.findByText(/Estás al día/)).toBeTruthy();
  });
});
