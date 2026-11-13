import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../shared/ui";
import { SettingsTab } from "./SettingsTab";
import type { SettingsOverview } from "./types";

const future = { v7_startTransition: true, v7_relativeSplatPath: true } as const;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const overview: SettingsOverview = {
  settings: [
    {
      key: "grading.scale",
      value: { min: 0, max: 100, pass: 60, confirmed: true },
      source: "campus",
      global_value: { min: 1, max: 10, pass: 4, confirmed: false },
      unconfirmed: false,
    },
    {
      key: "grading.final_rule",
      value: { kind: "weighted_mean", confirmed: false },
      source: "global",
      global_value: { kind: "weighted_mean", confirmed: false },
      unconfirmed: true,
    },
    {
      key: "attendance.rule",
      value: { min_rate_percent: 75, confirmed: false },
      source: "global",
      global_value: { min_rate_percent: 75, confirmed: false },
      unconfirmed: true,
    },
  ],
  changes: [],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

function renderTab() {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={["/campuses/7/settings"]} future={future}>
        <Routes>
          <Route path="/campuses/:id/settings" element={<SettingsTab />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe("SettingsTab", () => {
  it("shows which values are inherited and which are unconfirmed", async () => {
    fetchMock.mockResolvedValue(json(200, overview));
    renderTab();
    expect(await screen.findByText("Escala de calificaciones")).toBeTruthy();
    expect(screen.getByText("Valor de este campus")).toBeTruthy();
    expect(screen.getAllByText("Heredado")).toHaveLength(2);
    expect(screen.getAllByText("Sin confirmar")).toHaveLength(2);
    expect(screen.getByText("De 0 a 100, aprueba con 60")).toBeTruthy();
  });

  it("asks for a reason before saving an override", async () => {
    fetchMock.mockResolvedValue(json(200, overview));
    renderTab();
    await screen.findByText("Regla de asistencia");
    await userEvent.click(screen.getAllByRole("button", { name: "Modificar" })[2]);
    const save = screen.getByRole("button", { name: "Guardar" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Motivo del cambio"), "Pedido del coordinador");
    expect(save.disabled).toBe(false);
    await userEvent.click(save);
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT");
      expect(call?.[0]).toContain("/campuses/7/settings/attendance.rule");
      expect(JSON.parse(call?.[1].body).reason).toBe("Pedido del coordinador");
    });
  });
});
