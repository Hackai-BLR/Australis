import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AllCampusesPage } from "./AllCampusesPage";
import { PersonPage } from "./PersonPage";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const future = { v7_startTransition: true, v7_relativeSplatPath: true } as const;

const campuses = [
  {
    id: 7,
    name: "Maestría en Datos",
    university: "uni-1",
    university_name: "Universidad Demo",
    created_at: "2026-01-01",
    professors: 1,
    guests: 0,
    students: 12,
    suspended: 1,
  },
];
const people = [
  {
    id: 3,
    email: "ana@demo.test",
    full_name: "Ana Pérez",
    role: "student",
    status: "suspended",
    created_at: "2026-01-01",
  },
];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn((url: string) =>
    Promise.resolve(
      url.startsWith("/api/admin/campuses")
        ? json(200, campuses)
        : url.startsWith("/api/admin/people/3")
          ? json(200, {
              ...people[0],
              memberships: [
                {
                  campus_id: 7,
                  campus_name: "Maestría en Datos",
                  role: "student",
                  status: "suspended",
                  suspended_reason: "Baja",
                },
              ],
            })
          : json(200, people),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
});

describe("AllCampusesPage", () => {
  it("lists campuses and people with links into each", async () => {
    render(
      <MemoryRouter future={future}>
        <AllCampusesPage />
      </MemoryRouter>,
    );
    const campus = await screen.findByRole("link", { name: "Maestría en Datos" });
    expect(campus.getAttribute("href")).toBe("/campuses/7");
    const person = await screen.findByRole("link", { name: "Ana Pérez" });
    expect(person.getAttribute("href")).toBe("/admin/people/3");
    expect(screen.getByRole("cell", { name: "Suspendido" })).toBeTruthy();
  });

  it("sends the role and status filters to the API", async () => {
    render(
      <MemoryRouter future={future}>
        <AllCampusesPage />
      </MemoryRouter>,
    );
    await screen.findByRole("link", { name: "Ana Pérez" });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Rol (personas)"), "student");
    await user.selectOptions(screen.getByLabelText("Estado (personas)"), "suspended");
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/people?q=&role=student&status=suspended",
        expect.anything(),
      ),
    );
  });
});

describe("AllCampusesPage search and filters", () => {
  const otherCampus = { ...campuses[0], id: 8, name: "Especialización en Redes" };
  const otherPerson = {
    id: 4,
    email: "luis@demo.test",
    full_name: "Luis Gómez",
    role: "professor",
    status: "active",
    created_at: "2026-01-01",
  };

  // A tiny fake server that applies the same filters as the real one.
  function serve() {
    fetchMock.mockImplementation((url: string) => {
      const query = new URL(url, "http://x").searchParams;
      const q = (query.get("q") ?? "").toLowerCase();
      if (url.startsWith("/api/admin/campuses")) {
        return Promise.resolve(
          json(
            200,
            [campuses[0], otherCampus].filter((c) => c.name.toLowerCase().includes(q)),
          ),
        );
      }
      return Promise.resolve(
        json(
          200,
          [people[0], otherPerson]
            .filter((p) => (q ? (p.full_name + p.email).toLowerCase().includes(q) : true))
            .filter((p) => !query.get("role") || p.role === query.get("role"))
            .filter((p) => !query.get("status") || p.status === query.get("status")),
        ),
      );
    });
  }

  function renderPage() {
    render(
      <MemoryRouter future={future}>
        <AllCampusesPage />
      </MemoryRouter>,
    );
  }

  it("shows the university name", async () => {
    serve();
    renderPage();
    expect((await screen.findAllByRole("cell", { name: "Universidad Demo" })).length).toBe(2);
  });

  it("filters campuses and people by the text typed in the search box", async () => {
    serve();
    renderPage();
    await screen.findByRole("link", { name: "Luis Gómez" });
    expect(screen.getByRole("link", { name: "Especialización en Redes" })).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Buscar"), "Redes");
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "Maestría en Datos" })).toBeNull(),
    );
    expect(screen.getByRole("link", { name: "Especialización en Redes" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/campuses?q=Redes", expect.anything());
    await userEvent.clear(screen.getByLabelText("Buscar"));
    await userEvent.type(screen.getByLabelText("Buscar"), "ana@");
    await waitFor(() => expect(screen.queryByRole("link", { name: "Luis Gómez" })).toBeNull());
    expect(await screen.findByRole("link", { name: "Ana Pérez" })).toBeTruthy();
  });

  it("filters people by role and by status", async () => {
    serve();
    renderPage();
    await screen.findByRole("link", { name: "Luis Gómez" });
    await userEvent.selectOptions(screen.getByLabelText("Rol (personas)"), "professor");
    await waitFor(() => expect(screen.queryByRole("link", { name: "Ana Pérez" })).toBeNull());
    expect(screen.getByRole("link", { name: "Luis Gómez" })).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("Rol (personas)"), "");
    await userEvent.selectOptions(screen.getByLabelText("Estado (personas)"), "suspended");
    await waitFor(() => expect(screen.queryByRole("link", { name: "Luis Gómez" })).toBeNull());
    expect(screen.getByRole("link", { name: "Ana Pérez" })).toBeTruthy();
  });
});

describe("PersonPage", () => {
  it("recovers after a failed load when the person changes", async () => {
    const detail = { ...people[0], memberships: [] };
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(url.endsWith("/4") ? json(500, { error: "boom" }) : json(200, detail)),
    );
    function Jump() {
      return (
        <>
          <Link to="/admin/people/4">fail</Link>
          <Link to="/admin/people/3">ok</Link>
        </>
      );
    }
    render(
      <MemoryRouter initialEntries={["/admin/people/4"]} future={future}>
        <Jump />
        <Routes>
          <Route path="/admin/people/:id" element={<PersonPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("No se pudo cargar a la persona.")).toBeTruthy();
    await userEvent.click(screen.getByRole("link", { name: "ok" }));
    expect(await screen.findByText("Ana Pérez")).toBeTruthy();
    expect(screen.queryByText("No se pudo cargar a la persona.")).toBeNull();
  });

  it("shows the campuses of the person", async () => {
    render(
      <MemoryRouter initialEntries={["/admin/people/3"]} future={future}>
        <Routes>
          <Route path="/admin/people/:id" element={<PersonPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const link = await screen.findByRole("link", { name: "Maestría en Datos" });
    expect(link.getAttribute("href")).toBe("/campuses/7");
    expect(screen.getByText("Suspendido: Baja")).toBeTruthy();
  });
});
