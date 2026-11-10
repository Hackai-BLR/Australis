import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../shared/api";
import { AuthContext, type AuthContextValue } from "../../shared/auth/context";
import { InvitePage } from "./InvitePage";
import { LoginPage } from "./LoginPage";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const future = { v7_startTransition: true, v7_relativeSplatPath: true } as const;

function auth(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    status: "anonymous",
    user: null,
    login: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("LoginPage", () => {
  function renderLogin(value: AuthContextValue) {
    render(
      <AuthContext.Provider value={value}>
        <MemoryRouter initialEntries={["/login"]} future={future}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<p>inicio</p>} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    );
  }

  it("submits the trimmed email and the password, then goes home", async () => {
    const login = vi.fn().mockResolvedValue({});
    renderLogin(auth({ login }));
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Correo electrónico"), " ana@demo.test ");
    await user.type(screen.getByLabelText("Contraseña"), "secreta123");
    await user.click(screen.getByRole("button", { name: "Ingresar" }));
    expect(login).toHaveBeenCalledWith("ana@demo.test", "secreta123");
    expect(await screen.findByText("inicio")).toBeTruthy();
  });

  it("shows the server's error and stays on the form", async () => {
    const login = vi.fn().mockRejectedValue(new ApiError(401, "not signed in"));
    renderLogin(auth({ login }));
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Correo electrónico"), "ana@demo.test");
    await user.type(screen.getByLabelText("Contraseña"), "mala");
    await user.click(screen.getByRole("button", { name: "Ingresar" }));
    expect((await screen.findByRole("alert")).textContent).toBeTruthy();
    expect(screen.queryByText("inicio")).toBeNull();
  });
});

describe("InvitePage", () => {
  function renderInvite(value = auth()) {
    render(
      <AuthContext.Provider value={value}>
        <MemoryRouter initialEntries={["/invite/tok123"]} future={future}>
          <Routes>
            <Route path="/invite/:token" element={<InvitePage />} />
            <Route path="/" element={<p>inicio</p>} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    );
    return value;
  }

  it("says the invite is not valid when the token is unknown", async () => {
    fetchMock.mockResolvedValue(json(404, { error: "not found" }));
    renderInvite();
    expect(await screen.findByText("Invitación no válida")).toBeTruthy();
  });

  it("checks the passwords, accepts the invite and signs in", async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve(json(200, { id: 2 }));
      }
      return Promise.resolve(
        json(200, { email: "nuevo@demo.test", full_name: "Nuevo Docente", role: "professor" }),
      );
    });
    const value = renderInvite();
    const user = userEvent.setup();
    expect(await screen.findByText("nuevo@demo.test")).toBeTruthy();

    await user.type(screen.getByLabelText("Contraseña"), "una-clave-larga");
    await user.type(screen.getByLabelText("Repetir contraseña"), "otra-distinta");
    await user.click(screen.getByRole("button", { name: "Guardar y entrar" }));
    expect((await screen.findByRole("alert")).textContent).toContain("no coinciden");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.clear(screen.getByLabelText("Repetir contraseña"));
    await user.type(screen.getByLabelText("Repetir contraseña"), "una-clave-larga");
    await user.click(screen.getByRole("button", { name: "Guardar y entrar" }));
    await waitFor(() => expect(value.refresh).toHaveBeenCalled());
    const post = fetchMock.mock.calls.find((c) => c[1]?.method === "POST");
    expect(post?.[0]).toBe("/api/auth/invites/tok123/accept");
    expect(JSON.parse(post?.[1].body as string)).toEqual({ password: "una-clave-larga" });
    expect(await screen.findByText("inicio")).toBeTruthy();
  });
});
