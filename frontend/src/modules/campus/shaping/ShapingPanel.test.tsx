import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../../shared/ui";
import type { CampusDocument } from "../types";
import { ShapingPanel } from "./ShapingPanel";
import type { Proposal, ShapingUsage } from "./types";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const current: CampusDocument = {
  schema: 1,
  sections: [{ id: "s1", title: "Sección actual", kind: "general", visible: true, blocks: [] }],
};

const proposed: CampusDocument = {
  schema: 1,
  sections: [
    ...current.sections,
    { id: "s2", title: "Sección propuesta", kind: "general", visible: true, blocks: [] },
  ],
};

const usage: ShapingUsage = {
  used_today: 3,
  quota: 20,
  remaining: 17,
  logged_calls: 3,
  input_tokens: 100,
  output_tokens: 50,
  estimated_cost_usd: 0.0012,
  cost_is_estimate: true,
  simulated: true,
};

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 1,
    user_id: 1,
    user_name: "Ana",
    instruction: "Agregá la bibliografía",
    status: "pending",
    message: "Propongo agregar una sección.",
    base_version: 4,
    changes: ["Agregar la sección «Sección propuesta» (0 bloques)"],
    preview: proposed,
    simulated: true,
    revision_version: null,
    created_at: "2026-11-10 10:00:00",
    decided_at: null,
    ...over,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function mount(version = 4, onChanged = vi.fn()) {
  render(
    <ToastProvider>
      <ShapingPanel campusId={7} version={version} document={current} onChanged={onChanged} />
    </ToastProvider>,
  );
  return onChanged;
}

function routes(list: Proposal[]) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.endsWith("/ai/usage")) return Promise.resolve(json(200, usage));
    if (url.endsWith("/ai/proposals") && init?.method === "POST")
      return Promise.resolve(json(201, proposal({ id: 2 })));
    if (url.endsWith("/ai/proposals")) return Promise.resolve(json(200, list));
    return Promise.resolve(json(200, {}));
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("ShapingPanel", () => {
  it("shows the simulated badge, the quota and example prompts", async () => {
    routes([]);
    mount();
    expect(await screen.findByText("Pedidos de hoy: 3 de 20.", { exact: false })).toBeTruthy();
    expect(screen.getByText("Simulado")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Agregá la bibliografía" }));
    expect((screen.getByLabelText(/qué querés cambiar/i) as HTMLTextAreaElement).value).toBe(
      "Agregá la bibliografía",
    );
  });

  it("previews a pending proposal, toggles to the current campus and accepts it", async () => {
    routes([proposal()]);
    const onChanged = mount();
    expect(await screen.findByText("Sección propuesta")).toBeTruthy();
    expect(screen.getByText(/Agregar la sección «Sección propuesta»/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Ver campus actual" }));
    expect(screen.queryByText("Sección propuesta", { selector: "h2, h3" })).toBeNull();
    expect(screen.getByText("Sección actual")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Aceptar" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const accept = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/proposals/1/accept"),
    );
    expect(accept?.[1]?.method).toBe("POST");
  });

  it("rejects a proposal without reloading the campus", async () => {
    routes([proposal()]);
    const onChanged = mount();
    await userEvent.click(await screen.findByRole("button", { name: "Rechazar" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).endsWith("/proposals/1/reject")),
      ).toBe(true),
    );
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("cannot accept a proposal made on an older version of the campus", async () => {
    routes([proposal({ base_version: 3 })]);
    mount(4);
    const accept = await screen.findByRole("button", { name: "Aceptar" });
    expect((accept as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/ya no se puede aceptar/)).toBeTruthy();
  });

  it("asks for a proposal with the written instruction", async () => {
    routes([]);
    mount();
    await userEvent.type(
      await screen.findByLabelText(/qué querés cambiar/i),
      "agregá el cronograma",
    );
    await userEvent.click(screen.getByRole("button", { name: "Pedir propuesta" }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([url, init]) => String(url).endsWith("/ai/proposals") && init?.method === "POST",
      );
      expect(JSON.parse(post?.[1]?.body as string)).toEqual({
        instruction: "agregá el cronograma",
      });
    });
  });

  it("shows the assistant's refusal when it proposed nothing", async () => {
    routes([
      proposal({ status: "empty", changes: [], preview: null, message: "No puedo cambiar notas." }),
    ]);
    mount();
    expect(await screen.findByText("No puedo cambiar notas.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Aceptar" })).toBeNull();
  });

  it("disables asking when the daily quota is used up", async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith("/ai/usage")
          ? json(200, { ...usage, used_today: 20, remaining: 0 })
          : json(200, []),
      ),
    );
    mount();
    expect(await screen.findByText(/límite de pedidos de hoy/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText(/qué querés cambiar/i), "algo");
    expect(
      (screen.getByRole("button", { name: "Pedir propuesta" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
