import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../../shared/ui";
import { NotesPanel } from "./NotesPanel";

function mockFetch() {
  const calls: { method: string; url: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url });
      const body = method === "GET" ? [{ page: 1, body: "hola", updated_at: "x" }] : null;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("NotesPanel", () => {
  it("shows the saved note and saves an edit on blur", async () => {
    const calls = mockFetch();
    render(
      <ToastProvider>
        <NotesPanel presentationId={7} page={1} />
      </ToastProvider>,
    );
    const field = (await screen.findByLabelText(/Mis notas de la página 1/)) as HTMLTextAreaElement;
    await waitFor(() => expect(field.value).toBe("hola"));
    fireEvent.change(field, { target: { value: "hola mundo" } });
    fireEvent.blur(field);
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "PUT" && c.url.endsWith("/presentations/7/notes/1")),
      ).toBe(true),
    );
    expect(screen.getByText("Solo vos ves estas notas.")).toBeTruthy();
  });
});
