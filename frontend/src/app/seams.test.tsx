// The phase 2 kickoff mounts an empty slot where each later feature will show. These tests
// prove each slot is mounted in its page, so a feature only fills in its own folder.
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, RouterProvider, createMemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, type Role } from "../shared/auth";
import { ToastProvider } from "../shared/ui";
import { AppLayout } from "./AppLayout";
import { appRoutes, routerFuture } from "./routes";

// pdf.js does not run in jsdom and the slot sits next to the viewer, not inside it.
vi.mock("../modules/slides/PdfViewer", () => ({ PdfViewer: () => null }));

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const LIVE = {
  id: 9,
  presentation_id: 3,
  campus_id: 4,
  status: "live",
  current_page: 2,
  page_count: 5,
  seq: 1,
};

const CLASS_ITEM = {
  id: 7,
  campus_id: 4,
  campus_name: "Campus de prueba",
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

class QuietEventSource {
  static CLOSED = 2;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener() {}
  close() {}
}

function mockBackend(role: Role) {
  vi.stubGlobal("EventSource", QuietEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/auth/me")
        return json(200, { id: 1, email: "demo@demo.test", full_name: "Demo Persona", role });
      if (url === "/api/health") return json(200, { status: "ok", database: "ok" });
      if (url === "/api/campuses/4") {
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
      if (url === "/api/classes/7") return json(200, CLASS_ITEM);
      if (url === "/api/campuses/4/live") return json(200, LIVE);
      if (url === "/api/live/9/state") return json(200, LIVE);
      return json(404, { error: "not found" });
    }),
  );
}

function renderAt(path: string) {
  const router = createMemoryRouter(appRoutes, { initialEntries: [path], future: routerFuture });
  render(
    <AuthProvider>
      <ToastProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </ToastProvider>
    </AuthProvider>,
  );
}

const slot = (name: string) => document.querySelector(`[data-slot="${name}"]`);

beforeEach(() => vi.unstubAllGlobals());

describe("kickoff slots", () => {
  it("mounts the attendance and summary slots on the class page", async () => {
    mockBackend("student");
    renderAt("/classes/7");
    expect(await screen.findByText("Clase 1")).toBeTruthy();
    expect(slot("class-attendance")).not.toBeNull();
    expect(slot("class-summary")).not.toBeNull();
  });

  it("mounts the grades submission slot above the gradebook for a teacher", async () => {
    mockBackend("professor");
    renderAt("/campuses/4/grades");
    await screen.findByRole("navigation", { name: "Secciones del campus" });
    expect(slot("grades-submission")).not.toBeNull();
  });

  it("does not mount the submission slot in a student's own grades", async () => {
    mockBackend("student");
    renderAt("/campuses/4/grades");
    await screen.findByRole("navigation", { name: "Secciones del campus" });
    expect(slot("grades-submission")).toBeNull();
  });

  it("mounts the notes slot under the presentation a student follows", async () => {
    mockBackend("student");
    renderAt("/campuses/4/slides");
    expect(await screen.findByText("Presentación en vivo")).toBeTruthy();
    const notes = slot("slide-notes");
    expect(notes).not.toBeNull();
    expect(notes?.getAttribute("data-presentation-id")).toBe("3");
    expect(notes?.getAttribute("data-page")).toBe("2");
  });

  it("mounts the settings tab for a manager", async () => {
    mockBackend("professor");
    renderAt("/campuses/4/settings");
    expect(await screen.findByText("Configuración del campus")).toBeTruthy();
  });

  it("shows the global widget of the support module on every signed-in page", async () => {
    mockBackend("student");
    renderAt("/");
    await screen.findByRole("navigation", { name: "Navegación principal" });
    expect(slot("report-problem")).not.toBeNull();
  });
});

describe("global widgets", () => {
  it("renders every widget a module exports next to the page", async () => {
    mockBackend("professor");
    render(
      <MemoryRouter>
        <AuthProvider>
          <AppLayout
            navItems={[]}
            globalWidgets={[
              { id: "a", element: <p>Widget A</p> },
              { id: "b", element: <p>Widget B</p> },
            ]}
          />
          <Outlet />
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Widget A")).toBeTruthy();
    expect(screen.getByText("Widget B")).toBeTruthy();
  });

  it("renders no widgets when none are given", async () => {
    mockBackend("professor");
    render(
      <MemoryRouter>
        <AuthProvider>
          <AppLayout navItems={[]} />
        </AuthProvider>
      </MemoryRouter>,
    );
    await screen.findByRole("navigation", { name: "Navegación principal" });
    expect(document.querySelector(".au-global-widgets")?.childElementCount).toBe(0);
  });
});
