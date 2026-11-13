import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, type Role } from "../shared/auth";
import { appRoutes, routerFuture } from "./routes";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Mocks the backend: /auth/me answers with the given role (or 401), everything else 404. */
function mockBackend(role: Role | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/auth/me") {
        return role
          ? json(200, { id: 1, email: "demo@demo.test", full_name: "Demo Persona", role })
          : json(401, { error: "unauthorized" });
      }
      if (url === "/api/health") return json(200, { status: "ok", database: "ok" });
      if (url === "/api/campuses/4" && role) {
        return json(200, {
          id: 4,
          name: "Campus de prueba",
          owner_id: 1,
          created_at: "2026-11-10 10:00:00",
          access: role === "student" ? "view" : "manage",
          member_role: role === "student" ? "student" : "professor",
          template_key: "workshop",
          version: 1,
          updated_at: "2026-11-10 10:00:00",
          document: { schema: 1, sections: [] },
        });
      }
      return json(404, { error: "not found" });
    }),
  );
}

function renderAt(path: string) {
  const router = createMemoryRouter(appRoutes, { initialEntries: [path], future: routerFuture });
  render(
    <AuthProvider>
      <RouterProvider router={router} future={{ v7_startTransition: true }} />
    </AuthProvider>,
  );
  return router;
}

beforeEach(() => vi.unstubAllGlobals());

describe("app routes", () => {
  it("sends an anonymous visitor to the login page", async () => {
    mockBackend(null);
    const router = renderAt("/campuses/4/grades");
    expect(await screen.findByRole("button", { name: "Ingresar" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search).toBe(`?next=${encodeURIComponent("/campuses/4/grades")}`);
  });

  it("shows the student home and hides staff navigation", async () => {
    mockBackend("student");
    renderAt("/");
    expect(await screen.findByText("Mis cursos")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Mis notas" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Campus" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Usuarios" })).toBeNull();
  });

  it("shows the secretary every navigation item", async () => {
    mockBackend("secretary");
    renderAt("/");
    const nav = await screen.findByRole("navigation", { name: "Navegación principal" });
    const labels = Array.from(nav.querySelectorAll("a")).map((a) => a.textContent);
    expect(labels).toEqual(["Inicio", "Campus", "Usuarios"]);
  });

  it("renders campus tabs filtered by access", async () => {
    mockBackend("student");
    renderAt("/campuses/4");
    const tabs = await screen.findByRole("navigation", { name: "Secciones del campus" });
    const labels = Array.from(tabs.querySelectorAll("a")).map((a) => a.textContent);
    expect(labels).toEqual(["Inicio", "Clases", "Presentaciones", "Calificaciones"]);
  });

  it("does not open a manage-only tab for a student who types its URL", async () => {
    mockBackend("student");
    renderAt("/campuses/4/students");
    expect(await screen.findByText("No tenés acceso a esta sección")).toBeTruthy();
  });

  it("shows every campus tab to a professor", async () => {
    mockBackend("professor");
    renderAt("/campuses/4/students");
    expect(await screen.findByText("Estudiantes del campus")).toBeTruthy();
    const tabs = screen.getByRole("navigation", { name: "Secciones del campus" });
    expect(tabs.querySelectorAll("a")).toHaveLength(7);
    expect(screen.getByRole("link", { name: "Configuración" })).toBeTruthy();
  });

  it("does not show the settings tab to a student, even by URL", async () => {
    mockBackend("student");
    renderAt("/campuses/4/settings");
    expect(await screen.findByText("No tenés acceso a esta sección")).toBeTruthy();
  });

  it("stays signed in and shows an error when logout fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/auth/me")
          return json(200, {
            id: 1,
            email: "p@demo.test",
            full_name: "Prof Demo",
            role: "professor",
          });
        if (url === "/api/auth/logout") return json(500, { error: "boom" });
        return json(404, { error: "not found" });
      }),
    );
    const router = renderAt("/");
    await userEvent.click(await screen.findByRole("button", { name: "Cerrar sesión" }));
    expect(await screen.findByText(/No se pudo cerrar la sesión/)).toBeTruthy();
    expect(router.state.location.pathname).toBe("/");
    expect(screen.getByText("Prof Demo")).toBeTruthy();
  });

  it("goes to the login page after a successful logout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/auth/me")
          return json(200, {
            id: 1,
            email: "p@demo.test",
            full_name: "Prof Demo",
            role: "professor",
          });
        if (url === "/api/auth/logout") return new Response(null, { status: 204 });
        return json(404, { error: "not found" });
      }),
    );
    const router = renderAt("/");
    await userEvent.click(await screen.findByRole("button", { name: "Cerrar sesión" }));
    expect(await screen.findByRole("button", { name: "Ingresar" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/login");
  });
});
