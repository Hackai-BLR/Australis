import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthContext, type AuthContextValue, type AuthStatus, type Role } from "./context";
import { RequireAuth, RequireRole } from "./guards";
import { platformUrl } from "./mode";

afterEach(() => vi.unstubAllGlobals());

function modeResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function authValue(status: AuthStatus, role: Role | null = null): AuthContextValue {
  return {
    status,
    user: role ? { id: 1, email: "x@demo.test", full_name: "Ana Demo", role } : null,
    login: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
  };
}

function LoginProbe() {
  const location = useLocation();
  return <p>login page {location.search}</p>;
}

function renderAt(path: string, value: AuthContextValue, roles?: Role[]) {
  const page = <p>secret page</p>;
  return render(
    <AuthContext.Provider value={value}>
      <MemoryRouter
        initialEntries={[path]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <Routes>
          <Route path="/login" element={<LoginProbe />} />
          <Route element={<RequireAuth />}>
            <Route
              path="/campuses/:id"
              element={roles ? <RequireRole roles={roles}>{page}</RequireRole> : page}
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe("RequireAuth", () => {
  it("shows a spinner while the session is checked", () => {
    renderAt("/campuses/1", authValue("loading"));
    expect(screen.getByRole("status").textContent).toContain("Verificando sesión");
    expect(screen.queryByText("secret page")).toBeNull();
  });

  it("sends an anonymous visitor to /login with the return path in password mode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => modeResponse(200, { mode: "password" })),
    );
    renderAt("/campuses/1?tab=grades", authValue("anonymous"));
    expect((await screen.findByText(/login page/)).textContent).toContain(
      `?next=${encodeURIComponent("/campuses/1?tab=grades")}`,
    );
  });

  it("falls back to /login when the mode cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => modeResponse(404, { error: "not found" })),
    );
    renderAt("/campuses/1", authValue("anonymous"));
    expect(await screen.findByText(/login page/)).toBeTruthy();
  });

  it("sends an anonymous visitor to the platform in header mode, never to /login", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => modeResponse(200, { mode: "header" })),
    );
    const assign = vi.fn();
    vi.stubGlobal("location", {
      protocol: "https:",
      host: "campus.campusia.tech",
      pathname: "/campuses/1",
      search: "",
      assign,
    });
    renderAt("/campuses/1", authValue("anonymous"));
    expect(await screen.findByText("Tu sesión terminó")).toBeTruthy();
    expect(assign).toHaveBeenCalledWith("https://campusia.tech/");
    expect(screen.queryByText(/login page/)).toBeNull();
  });

  it("treats a 401 on the mode route as header mode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => modeResponse(401, { error: "no_autenticado" })),
    );
    vi.stubGlobal("location", {
      protocol: "http:",
      host: "campus.localhost:8080",
      pathname: "/",
      search: "",
      assign: vi.fn(),
    });
    renderAt("/campuses/1", authValue("anonymous"));
    expect(await screen.findByText("Tu sesión terminó")).toBeTruthy();
  });

  it("finds the platform address from the campus address", () => {
    expect(platformUrl({ protocol: "https:", host: "campus.campusia.tech" })).toBe(
      "https://campusia.tech/",
    );
    expect(platformUrl({ protocol: "http:", host: "localhost:5173" })).toBe("/");
  });

  it("renders the page for a signed-in user", () => {
    renderAt("/campuses/1", authValue("authenticated", "student"));
    expect(screen.getByText("secret page")).toBeTruthy();
  });
});

describe("RequireRole", () => {
  it("blocks a role that is not listed", () => {
    renderAt("/campuses/1", authValue("authenticated", "student"), ["professor"]);
    expect(screen.queryByText("secret page")).toBeNull();
    expect(screen.getByText("No tenés acceso a esta página")).toBeTruthy();
  });

  it("admits a listed role", () => {
    renderAt("/campuses/1", authValue("authenticated", "professor"), ["professor"]);
    expect(screen.getByText("secret page")).toBeTruthy();
  });

  it("admits the secretary wherever a professor is admitted", () => {
    renderAt("/campuses/1", authValue("authenticated", "secretary"), ["professor"]);
    expect(screen.getByText("secret page")).toBeTruthy();
  });

  it("keeps secretary-only pages from professors", () => {
    renderAt("/campuses/1", authValue("authenticated", "professor"), ["secretary"]);
    expect(screen.queryByText("secret page")).toBeNull();
  });
});
