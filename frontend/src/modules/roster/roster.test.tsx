import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RosterTab } from "./RosterTab";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const future = { v7_startTransition: true, v7_relativeSplatPath: true } as const;

const members = [
  {
    user_id: 1,
    email: "doc@demo.test",
    full_name: "Doc Ente",
    role: "professor",
    status: "active",
    user_status: "active",
    suspended_reason: null,
  },
  {
    user_id: 2,
    email: "ana@demo.test",
    full_name: "Ana Pérez",
    role: "student",
    status: "active",
    user_status: "invited",
    suspended_reason: null,
  },
  {
    user_id: 3,
    email: "luis@demo.test",
    full_name: "Luis Gómez",
    role: "student",
    status: "suspended",
    user_status: "active",
    suspended_reason: "Baja",
  },
];

let fetchMock: ReturnType<typeof vi.fn>;

function renderTab() {
  render(
    <MemoryRouter initialEntries={["/campuses/7/students"]} future={future}>
      <Routes>
        <Route path="/campuses/:id/students" element={<RosterTab />} />
      </Routes>
    </MemoryRouter>,
  );
}

function lastButton(name: string) {
  const all = screen.getAllByRole("button", { name });
  return all[all.length - 1];
}

function calls(path: string) {
  return fetchMock.mock.calls.filter(([url]) => url === `/api${path}`);
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("RosterTab", () => {
  it("lists members with their status", async () => {
    fetchMock.mockResolvedValue(json(200, members));
    renderTab();
    expect(await screen.findByText("Ana Pérez")).toBeTruthy();
    expect(screen.getByText("Pendiente de activar")).toBeTruthy();
    expect(screen.getByText("Suspendido")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reactivar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Nuevo enlace" })).toBeTruthy();
  });

  it("previews a pasted list with flags, then confirms and shows invite links", async () => {
    const preview = {
      id: 5,
      total: 2,
      importable: 1,
      counts: { invalid_email: 1 },
      rows: [
        { line: 1, full_name: "Nueva", email: "nueva@demo.test", flags: [], importable: true },
        {
          line: 2,
          full_name: "Rota",
          email: "rota",
          flags: ["invalid_email"],
          importable: false,
        },
      ],
    };
    const result = {
      created: 1,
      added_existing: 0,
      skipped: 1,
      invites: [
        {
          user_id: 9,
          full_name: "Nueva",
          email: "nueva@demo.test",
          invite_url: "http://app.test/invite/abc",
        },
      ],
    };
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/campuses/7/members") return Promise.resolve(json(200, members));
      if (url === "/api/campuses/7/roster/imports") return Promise.resolve(json(201, preview));
      if (url === "/api/campuses/7/roster/imports/5/confirm")
        return Promise.resolve(json(200, result));
      return Promise.resolve(json(404, { error: "x" }));
    });
    renderTab();
    const user = userEvent.setup();
    await screen.findByText("Ana Pérez");
    await user.click(screen.getByRole("button", { name: "Importar estudiantes" }));
    await user.click(screen.getByRole("button", { name: "Pegar lista" }));
    await user.type(screen.getByLabelText("Lista de estudiantes"), "Nueva nueva@demo.test");
    await user.click(screen.getByRole("button", { name: "Ver vista previa" }));

    expect(await screen.findByText("2 filas leídas, 1 se pueden importar.")).toBeTruthy();
    expect(screen.getByText("Correo inválido: 1")).toBeTruthy();
    expect(JSON.parse(calls("/campuses/7/roster/imports")[0][1].body)).toEqual({
      text: "Nueva nueva@demo.test",
    });

    await user.click(screen.getByRole("button", { name: "Confirmar importación" }));
    expect(await screen.findByText("http://app.test/invite/abc")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copiar" })).toBeTruthy();
    expect(calls("/campuses/7/roster/imports/5/confirm")).toHaveLength(1);
  });

  it("requires a reason to suspend and sends it", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/campuses/7/members") return Promise.resolve(json(200, members));
      return Promise.resolve(json(200, {}));
    });
    renderTab();
    const user = userEvent.setup();
    await screen.findByText("Ana Pérez");
    await user.click(screen.getAllByRole("button", { name: "Suspender" })[0]);
    await user.click(lastButton("Suspender"));
    expect(calls("/campuses/7/members/2/suspend")).toHaveLength(0);
    await user.type(screen.getByLabelText("Motivo"), "Cambio de curso");
    await user.click(lastButton("Suspender"));
    await waitFor(() => expect(calls("/campuses/7/members/2/suspend")).toHaveLength(1));
    expect(JSON.parse(calls("/campuses/7/members/2/suspend")[0][1].body)).toEqual({
      reason: "Cambio de curso",
    });
  });
});
