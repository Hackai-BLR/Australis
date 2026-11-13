import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportButton } from "./ReportButton";
import { campusIdOf, isInAppPath } from "./campusId";
import { ReportsInbox } from "./ReportsInbox";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("campusIdOf", () => {
  it("reads the campus from the path", () => {
    expect(campusIdOf("/campuses/7/grades")).toBe(7);
    expect(campusIdOf("/campuses/7")).toBe(7);
    expect(campusIdOf("/campuses")).toBeNull();
    expect(campusIdOf("/grades")).toBeNull();
  });
});

describe("ReportButton", () => {
  it("sends the page, the campus and the text", async () => {
    const fetchMock = vi.fn(async () => json(201, { id: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemoryRouter initialEntries={["/campuses/3/grades"]}>
        <ReportButton />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Reportar un problema" }));
    await userEvent.type(screen.getByLabelText("¿Qué pasó?"), "No veo mi nota");
    await userEvent.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await screen.findByText(/el reporte se envió/)).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/support/reports");
    expect(JSON.parse(init?.body as string)).toEqual({
      page: "/campuses/3/grades",
      campus_id: 3,
      text: "No veo mi nota",
    });
  });
});

describe("campus of a class page", () => {
  it("is read from the class, so the report reaches that campus's professors", async () => {
    const fetchMock = vi.fn(async (...args: unknown[]) =>
      String(args[0]) === "/api/classes/12"
        ? json(200, { id: 12, campus_id: 3 })
        : json(201, { id: 1 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemoryRouter initialEntries={["/classes/12"]}>
        <ReportButton />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Reportar un problema" }));
    await userEvent.type(screen.getByLabelText("¿Qué pasó?"), "No anda el botón de Zoom");
    await userEvent.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await screen.findByText(/profesores de este campus/)).toBeTruthy();
    const post = fetchMock.mock.calls.find(
      (c) => (c as unknown[])[1] && ((c as unknown[])[1] as RequestInit).method === "POST",
    ) as unknown as [string, RequestInit];
    expect(JSON.parse(post[1].body as string).campus_id).toBe(3);
  });
});

describe("isInAppPath", () => {
  it("accepts only same-origin paths", () => {
    expect(isInAppPath("/campuses/1?x=1")).toBe(true);
    for (const bad of ["javascript:alert(1)", "https://evil.example", "//evil.example", "/\\x"]) {
      expect(isInAppPath(bad)).toBe(false);
    }
  });
});

describe("ReportsInbox", () => {
  it("does not render a link for a page that is not an in-app path", async () => {
    const report = {
      id: 6,
      campus_id: null,
      reporter_id: 2,
      reporter_name: "Ana Prueba",
      page: "javascript:alert(1)",
      body: "Hola",
      status: "open",
      created_at: "2026-11-10 10:00:00",
      resolved_at: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(200, [report])),
    );
    render(
      <MemoryRouter>
        <ReportsInbox />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Hola")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /javascript/ })).toBeNull();
    expect(screen.getByText("javascript:alert(1)")).toBeTruthy();
  });

  it("lists open reports and resolves one", async () => {
    const report = {
      id: 5,
      campus_id: null,
      reporter_id: 2,
      reporter_name: "Ana Prueba",
      page: "/",
      body: "Falla la página",
      status: "open",
      created_at: "2026-11-10 10:00:00",
      resolved_at: null,
    };
    let resolved = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          resolved = true;
          return json(200, { ...report, status: "resolved" });
        }
        return json(200, resolved ? [] : [report]);
      }),
    );
    render(
      <MemoryRouter>
        <ReportsInbox />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Falla la página")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Marcar como resuelto" }));
    expect(await screen.findByText("No hay reportes abiertos")).toBeTruthy();
  });
});
