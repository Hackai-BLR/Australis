import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, type Role } from "../../shared/auth";
import { HomePage } from "./HomePage";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const classToday = {
  id: 7,
  campus_id: 1,
  campus_name: "Seminario A",
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

function mock(
  role: Role,
  opts: { today?: unknown[]; campuses?: unknown[]; courseScale?: { pass: number } } = {},
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/auth/me")
        return json(200, { id: 1, email: "a@b.test", full_name: "Ada Demo", role });
      if (url === "/api/campuses")
        return json(
          200,
          opts.campuses ?? [
            { id: 1, name: "Seminario A" },
            { id: 2, name: "Taller B" },
          ],
        );
      if (url === "/api/classes/today") return json(200, opts.today ?? []);
      if (url === "/api/grades/mine")
        return json(200, {
          scale: { pass: 6 },
          courses: [
            {
              campus_id: 1,
              campus_name: "Seminario A",
              final: 8.4,
              items: [],
              scale: opts.courseScale,
            },
          ],
        });
      return json(404, { error: "no" });
    }),
  );
}

function renderHome() {
  render(
    <AuthProvider>
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => vi.unstubAllGlobals());

describe("HomePage", () => {
  it("student: shows courses, the grades entry and final grades", async () => {
    mock("student");
    renderHome();
    expect(await screen.findByText("Taller B")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Entrar al campus" })).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Ver todas mis notas" }).getAttribute("href")).toBe(
      "/grades",
    );
    expect(await screen.findByText("Final: 8,4")).toBeTruthy();
  });

  it("student: colours the final against the course's own scale", async () => {
    mock("student", { courseScale: { pass: 9 } });
    renderHome();
    const badge = await screen.findByText("Final: 8,4");
    expect(badge.className).toContain("danger");
  });

  it("student: no join button when there is no class today", async () => {
    mock("student");
    renderHome();
    expect(await screen.findByText("Hoy no hay clases")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /clase de hoy/ })).toBeNull();
  });

  it("student: shows the join button when a class is today", async () => {
    mock("student", { today: [classToday] });
    renderHome();
    expect(await screen.findByRole("button", { name: /clase de hoy/ })).toBeTruthy();
  });

  it("student: says so when there are no courses", async () => {
    mock("student", { campuses: [] });
    renderHome();
    expect(await screen.findByText("Todavía no estás inscripto en ningún curso")).toBeTruthy();
  });

  it("professor: shows own campuses and Crear campus, not the grades entry", async () => {
    mock("professor");
    renderHome();
    expect(await screen.findByText("Mis campus")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Crear campus" })).toBeTruthy();
    expect(screen.queryByText("Mis notas")).toBeNull();
    expect(screen.queryByText("Administrar usuarios")).toBeNull();
  });

  it("secretary: shows all campuses and the user admin link", async () => {
    mock("secretary");
    renderHome();
    expect(await screen.findByText("Todos los campus")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Administrar usuarios" }).getAttribute("href")).toBe(
      "/admin/users",
    );
  });
});
