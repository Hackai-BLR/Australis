import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AuthContext, type AuthContextValue, type AuthStatus, type Role } from "./context";
import { RequireAuth, RequireRole } from "./guards";

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

  it("sends an anonymous visitor to /login with the return path", () => {
    renderAt("/campuses/1?tab=grades", authValue("anonymous"));
    expect(screen.getByText(/login page/).textContent).toContain(
      `?next=${encodeURIComponent("/campuses/1?tab=grades")}`,
    );
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
