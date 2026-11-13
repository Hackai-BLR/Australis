import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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
    university: null,
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

describe("PersonPage", () => {
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
