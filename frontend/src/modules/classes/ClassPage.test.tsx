import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClassPage } from "./ClassPage";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

describe("ClassPage", () => {
  it("shows Spanish text when the server answers 403", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: "not allowed" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(
      <MemoryRouter initialEntries={["/clases/7"]}>
        <Routes>
          <Route path="/clases/:cid" element={<ClassPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("No tenés permiso para hacer esto.")).toBeTruthy();
    expect(screen.queryByText("not allowed")).toBeNull();
  });
});
