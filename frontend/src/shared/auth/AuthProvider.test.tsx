import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiGet } from "../api";
import { AuthProvider } from "./AuthProvider";
import { useAuth, type User } from "./context";

const ANA: User = { id: 1, email: "ana@demo.test", full_name: "Ana Demo", role: "professor" };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
let auth: ReturnType<typeof useAuth>;

function Probe() {
  auth = useAuth();
  return (
    <p data-testid="probe">
      {auth.status}:{auth.user?.email ?? "none"}
    </p>
  );
}

function renderProvider() {
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  return () => screen.getByTestId("probe").textContent;
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("AuthProvider bootstrap", () => {
  it("starts loading and becomes authenticated when /auth/me returns the user", async () => {
    fetchMock.mockResolvedValue(json(200, ANA));
    const text = renderProvider();
    expect(text()).toBe("loading:none");
    await waitFor(() => expect(text()).toBe("authenticated:ana@demo.test"));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/me");
  });

  it("becomes anonymous when /auth/me answers 401", async () => {
    fetchMock.mockResolvedValue(json(401, { error: "unauthorized" }));
    const text = renderProvider();
    await waitFor(() => expect(text()).toBe("anonymous:none"));
  });

  it("becomes anonymous when the backend is unreachable", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const text = renderProvider();
    await waitFor(() => expect(text()).toBe("anonymous:none"));
  });
});

describe("AuthProvider actions", () => {
  it("logs in with the frozen contract and stores the user", async () => {
    fetchMock.mockResolvedValueOnce(json(401, { error: "unauthorized" }));
    const text = renderProvider();
    await waitFor(() => expect(text()).toBe("anonymous:none"));

    fetchMock.mockResolvedValueOnce(json(200, ANA));
    await act(() => auth.login("ana@demo.test", "secreta"));
    expect(text()).toBe("authenticated:ana@demo.test");
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("/api/auth/login");
    expect(JSON.parse(init.body)).toEqual({ email: "ana@demo.test", password: "secreta" });
  });

  it("rejects a bad login with the server message and stays anonymous", async () => {
    fetchMock.mockResolvedValueOnce(json(401, { error: "unauthorized" }));
    const text = renderProvider();
    await waitFor(() => expect(text()).toBe("anonymous:none"));

    fetchMock.mockResolvedValueOnce(json(401, { error: "Correo o contraseña incorrectos" }));
    await act(async () => {
      await expect(auth.login("ana@demo.test", "mal")).rejects.toEqual(
        new ApiError(401, "Correo o contraseña incorrectos"),
      );
    });
    expect(text()).toBe("anonymous:none");
  });

  it("logs out through POST /auth/logout (204)", async () => {
    fetchMock.mockResolvedValueOnce(json(200, ANA));
    const text = renderProvider();
    await waitFor(() => expect(text()).toBe("authenticated:ana@demo.test"));

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await act(() => auth.logout());
    expect(text()).toBe("anonymous:none");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/auth/logout");
    expect(fetchMock.mock.calls[1][1].method).toBe("POST");
  });

  it("clears the user when any API call returns 401", async () => {
    fetchMock.mockResolvedValueOnce(json(200, ANA));
    const text = renderProvider();
    await waitFor(() => expect(text()).toBe("authenticated:ana@demo.test"));

    fetchMock.mockResolvedValueOnce(json(401, { error: "session expired" }));
    await act(async () => {
      await expect(apiGet("/campuses")).rejects.toBeInstanceOf(ApiError);
    });
    expect(text()).toBe("anonymous:none");
  });
});
