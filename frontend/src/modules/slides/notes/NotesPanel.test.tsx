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

describe("NotesPanel page and presentation changes", () => {
  function mockNotes(notes: Record<number, { page: number; body: string; updated_at: string }[]>) {
    const puts: { url: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "PUT") puts.push({ url, body: JSON.parse(String(init?.body)).body });
        const m = /presentations\/(\d+)\/notes$/.exec(url);
        const body = method === "GET" && m ? (notes[Number(m[1])] ?? []) : null;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    return puts;
  }
  const wrap = (pid: number, page: number) => (
    <ToastProvider>
      <NotesPanel presentationId={pid} page={page} />
    </ToastProvider>
  );

  it("does not write one page's text over another page's note", async () => {
    const puts = mockNotes({
      7: [
        { page: 1, body: "a", updated_at: "x" },
        { page: 2, body: "b", updated_at: "x" },
      ],
    });
    const { rerender } = render(wrap(7, 1));
    const field = (await screen.findByLabelText(/página 1/)) as HTMLTextAreaElement;
    await waitFor(() => expect(field.value).toBe("a"));
    rerender(wrap(7, 2));
    await waitFor(() => expect(field.value).toBe("b"));
    expect(puts).toEqual([]);
  });

  it("does not delete the next page's note when the left page has none", async () => {
    const puts = mockNotes({ 7: [{ page: 2, body: "b", updated_at: "x" }] });
    const { rerender } = render(wrap(7, 1));
    const field = (await screen.findByLabelText(/página 1/)) as HTMLTextAreaElement;
    await waitFor(() => expect(field.disabled).toBe(false));
    rerender(wrap(7, 2));
    await waitFor(() => expect(field.value).toBe("b"));
    expect(puts).toEqual([]);
  });

  it("does not carry a draft into another presentation", async () => {
    const puts = mockNotes({ 8: [{ page: 1, body: "real", updated_at: "x" }] });
    const { rerender } = render(wrap(7, 1));
    let field = (await screen.findByLabelText(/página 1/)) as HTMLTextAreaElement;
    await waitFor(() => expect(field.disabled).toBe(false));
    fireEvent.change(field, { target: { value: "x" } });
    rerender(wrap(8, 1));
    field = (await screen.findByLabelText(/página 1/)) as HTMLTextAreaElement;
    await waitFor(() => expect(field.value).toBe("real"));
    fireEvent.blur(field);
    expect(puts.filter((p) => p.url.includes("/presentations/8/"))).toEqual([]);
  });
});
