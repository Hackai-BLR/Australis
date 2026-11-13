import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportButton } from "./ReportButton";
import { campusIdOf } from "./campusId";
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

describe("ReportsInbox", () => {
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
