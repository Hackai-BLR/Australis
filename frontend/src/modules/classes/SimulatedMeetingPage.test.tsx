import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { routes } from "./routes";

function renderAt(url: string) {
  const route = routes.find((r) => r.path === "/simulado/zoom/:id");
  expect(route).toBeTruthy();
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path={route!.path} element={route!.element} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("simulated Zoom meeting route", () => {
  it("renders for a participant", () => {
    renderAt("/simulado/zoom/abc123");
    expect(screen.getByText("Simulado")).toBeTruthy();
    expect(screen.getByText("abc123")).toBeTruthy();
    expect(screen.getByText("Participante")).toBeTruthy();
  });

  it("renders for a host", () => {
    renderAt("/simulado/zoom/abc123?anfitrion=1");
    expect(screen.getByText("Anfitrión")).toBeTruthy();
  });
});
