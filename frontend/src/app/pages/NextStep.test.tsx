import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
function ago(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
}
const recorded = {
  id: 9,
  campus_name: "Seminario A",
  title: "Clase 0",
  recording_status: "available",
  starts_at: ago(1.1),
  simulated: true,
  ended_at: ago(1),
};
const grades = {
  courses: [
    {
      campus_id: 1,
      campus_name: "Seminario A",
      final: 8,
      scale: { pass: 6 },
      items: [{ item_id: 3, score: 8 }],
    },
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
      if (url === "/api/grades/mine") return json(200, opts.grades ?? { courses: [] });
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
    expect(pickStep([], [], grades, [], ["3:8"]).kind).toBe("none");
  });
});

describe("pickStep details", () => {
  const multi = {
    courses: [
      { campus_name: "Curso A", items: [{ item_id: 1, score: 5 }] },
      {
        campus_name: "Seminario de investigación",
        items: [
          { item_id: 2, score: 7 },
          { item_id: 3, score: 9 },
          { item_id: 4, score: null },
        ],
      },
    ],
  };
  it("names the course with most new grades and counts the other courses", () => {
    const s = pickStep([], [], multi, [], []);
    expect(s).toMatchObject({
      kind: "grade",
      count: 3,
      campus: "Seminario de investigación",
      otherCourses: 1,
    });
  });
  it("counts a corrected score as new again", () => {
    expect(pickStep([], [], grades, [], ["3:7"]).kind).toBe("grade");
  });
  it("does not offer a recording older than a week", () => {
    const old = { ...recorded, starts_at: ago(10.1), ended_at: ago(10) };
    expect(pickStep([], [old], { courses: [] }, [], []).kind).toBe("none");
  });
  it("sorts a never-ended class by its start time", () => {
    const unended = { ...recorded, id: 20, starts_at: ago(0.5), ended_at: null };
    const ended = { ...recorded, id: 21, starts_at: ago(3.1), ended_at: ago(3) };
    const s = pickStep([], [ended, unended], null, [], []);
    expect(s.kind === "recording" && s.item.id).toBe(20);
  });
});

describe("NextStep card", () => {
  it("shows the Simulado badge on a placeholder recording", async () => {
    mock({ classes: [recorded] });
    renderHome();
    await screen.findByText(/Ya está la grabación/);
    expect(screen.getAllByText("Simulado").length).toBeGreaterThan(0);
  });

  it("marks a recording seen when opened and moves on to the grade", async () => {
    mock({
      classes: [recorded],
      grades: { ...grades, courses: [{ ...grades.courses[0], items: [{ item_id: 3, score: 8 }] }] },
    });
    localStorage.setItem("australis.next.grades.1", "[]");
    renderHome();
    fireEvent.click(await screen.findByRole("link", { name: "Ver la grabación" }));
    expect(JSON.parse(localStorage.getItem("australis.next.rec.1") ?? "[]")).toEqual([9]);
    cleanup();
    renderHome();
    expect(await screen.findByText(/Tenés una nota nueva/)).toBeTruthy();
  });

  it("marks grades seen when opened and then says the student is up to date", async () => {
    mock({ grades });
    localStorage.setItem("australis.next.grades.1", "[]");
    renderHome();
    fireEvent.click(await screen.findByRole("link", { name: "Ver mis notas" }));
    expect(JSON.parse(localStorage.getItem("australis.next.grades.1") ?? "[]")).toEqual(["3:8"]);
    cleanup();
    renderHome();
    expect(await screen.findByText(/Estás al día/)).toBeTruthy();
  });

  it("baselines existing grades on a browser with no stored state", async () => {
    mock({ grades });
    renderHome();
    expect(await screen.findByText(/Estás al día/)).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("australis.next.grades.1") ?? "[]")).toEqual(["3:8"]);
  });

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
    localStorage.setItem("australis.next.grades.1", "[]");
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
