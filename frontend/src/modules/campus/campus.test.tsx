import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext, type AuthContextValue } from "../../shared/auth/context";
import { ToastProvider } from "../../shared/ui";
import { DocumentView } from "./DocumentView";
import { CampusOverviewTab, NewCampusPage } from "./pages";
import { resetCampusStore } from "./store";
import type { CampusDetail, CampusDocument, Template } from "./types";

const future = { v7_startTransition: true, v7_relativeSplatPath: true } as const;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const document: CampusDocument = {
  schema: 1,
  sections: [
    {
      id: "s1",
      title: "Bienvenida",
      kind: "info",
      visible: true,
      blocks: [
        { type: "text", id: "b1", text: "<b>no soy negrita</b> **ni markdown**" },
        { type: "widget", id: "b2", widget: "grades" },
        { type: "link", id: "b3", label: "Sitio", url: "https://example.org" },
      ],
    },
    { id: "s2", title: "Borrador", kind: "general", visible: false, blocks: [] },
  ],
};

const auth: AuthContextValue = {
  status: "authenticated",
  user: { id: 1, email: "a@demo.test", full_name: "Ana", role: "professor" },
  login: vi.fn(),
  logout: vi.fn(),
  refresh: vi.fn(),
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetCampusStore();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("DocumentView", () => {
  it("renders block text as plain text and widgets as neutral placeholders", () => {
    const { container } = render(<DocumentView document={document} />);
    expect(screen.getByText("<b>no soy negrita</b> **ni markdown**")).toBeTruthy();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText("Calificaciones")).toBeTruthy();
    expect(screen.getByText("Próximamente")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sitio" }).getAttribute("rel")).toContain("noopener");
  });

  it("hides hidden sections unless asked to show them", () => {
    const { rerender } = render(<DocumentView document={document} />);
    expect(screen.queryByText("Borrador")).toBeNull();
    rerender(<DocumentView document={document} showHidden />);
    expect(screen.getByText("Borrador")).toBeTruthy();
    expect(screen.getByText("Oculta para estudiantes")).toBeTruthy();
  });
});

describe("CampusOverviewTab", () => {
  function detail(access: CampusDetail["access"]): CampusDetail {
    return {
      id: 7,
      name: "Seminario",
      owner_id: 1,
      created_at: "2026-11-10 10:00:00",
      access,
      member_role: access === "view" ? "student" : "professor",
      template_key: "workshop",
      version: 1,
      updated_at: "2026-11-10 10:00:00",
      document,
    };
  }

  function renderTab(access: CampusDetail["access"]) {
    fetchMock.mockResolvedValue(json(200, detail(access)));
    render(
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={["/campuses/7"]} future={future}>
          <Routes>
            <Route path="/campuses/:id" element={<CampusOverviewTab />} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    );
  }

  it("gives a student the read-only document without the shaping panel", async () => {
    renderTab("view");
    expect(await screen.findByText("Bienvenida")).toBeTruthy();
    expect(screen.queryByText("Asistente de IA")).toBeNull();
    expect(screen.queryByText("Borrador")).toBeNull();
  });

  it("gives a professor the shaping slot", async () => {
    renderTab("manage");
    expect(await screen.findByText("Asistente de IA")).toBeTruthy();
    expect(screen.getByText("Borrador")).toBeTruthy();
  });
});

describe("NewCampusPage", () => {
  it("creates a campus from the chosen template", async () => {
    const templates: Template[] = [
      { key: "workshop", name: "Taller", description: "Con entregas", document },
      { key: "thesis_group", name: "Grupo de tesis", description: "Hitos", document },
    ];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/campus-templates") return json(200, templates);
      if (url === "/api/campuses" && init?.method === "POST") {
        return json(201, { id: 9, name: "Mi campus", access: "manage", document });
      }
      return json(404, { error: "no" });
    });
    render(
      <AuthContext.Provider value={auth}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/campuses/new"]} future={future}>
            <Routes>
              <Route path="/campuses/new" element={<NewCampusPage />} />
              <Route path="/campuses/:id" element={<p>campus creado</p>} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </AuthContext.Provider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Grupo de tesis/ }));
    await user.click(screen.getByRole("button", { name: "Crear campus" }));
    expect(await screen.findByText("Escribí un nombre para el campus.")).toBeTruthy();
    await user.type(screen.getByLabelText("Nombre del campus"), "Mi campus");
    await user.click(screen.getByRole("button", { name: "Crear campus" }));
    expect(await screen.findByText("campus creado")).toBeTruthy();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    await waitFor(() => expect(post).toBeTruthy());
    expect(JSON.parse(post![1].body as string)).toEqual({
      name: "Mi campus",
      template_key: "thesis_group",
    });
  });
});
