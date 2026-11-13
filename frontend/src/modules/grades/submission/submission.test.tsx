import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ role: "professor" }));
const api = vi.hoisted(() => ({
  status: "draft",
  note: null as string | null,
  post: vi.fn(),
}));

vi.mock("../../../shared/auth", () => ({
  useAuth: () => ({ user: { id: 1, role: auth.role } }),
}));
vi.mock("../../../shared/api", () => ({
  ApiError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
  apiGet: () => Promise.resolve({ campus_id: 1, status: api.status, note: api.note }),
  apiPost: api.post,
}));

import { SubmissionSlot } from "./SubmissionSlot";

beforeEach(() => {
  auth.role = "professor";
  api.status = "draft";
  api.note = null;
  api.post.mockReset();
});

describe("SubmissionSlot", () => {
  it("lets a teacher send a draft", async () => {
    render(<SubmissionSlot campusId={1} />);
    expect(await screen.findByText("Enviar notas a secretaría")).toBeTruthy();
  });

  it("shows the secretary's note after a return", async () => {
    api.note = "Falta el parcial 2";
    render(<SubmissionSlot campusId={1} />);
    expect(await screen.findByText("Falta el parcial 2")).toBeTruthy();
  });

  it("gives the secretary check and return buttons on sent grades", async () => {
    auth.role = "secretary";
    api.status = "sent";
    render(<SubmissionSlot campusId={1} />);
    expect(await screen.findByText("Marcar como verificadas")).toBeTruthy();
    expect(screen.getByText("Devolver al docente")).toBeTruthy();
  });

  it("gives a teacher no check button on sent grades", async () => {
    api.status = "sent";
    render(<SubmissionSlot campusId={1} />);
    expect(await screen.findByText("Esperando la verificación de secretaría.")).toBeTruthy();
    expect(screen.queryByText("Marcar como verificadas")).toBeNull();
  });

  it("sends the grades and shows the sent state", async () => {
    api.post.mockResolvedValue({ campus_id: 1, status: "sent", note: null });
    render(<SubmissionSlot campusId={1} />);
    fireEvent.click(await screen.findByText("Enviar notas a secretaría"));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/campuses/1/grades/submission/send", undefined),
    );
    expect(await screen.findByText("Esperando la verificación de secretaría.")).toBeTruthy();
    expect(screen.queryByText("Enviar notas a secretaría")).toBeNull();
  });

  it("lets the secretary check the grades and shows the checked state", async () => {
    auth.role = "secretary";
    api.status = "sent";
    api.post.mockResolvedValue({ campus_id: 1, status: "checked", note: null });
    render(<SubmissionSlot campusId={1} />);
    fireEvent.click(await screen.findByText("Marcar como verificadas"));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/campuses/1/grades/submission/check", undefined),
    );
    expect(await screen.findByText("Verificadas")).toBeTruthy();
    expect(screen.queryByText("Marcar como verificadas")).toBeNull();
  });

  it("returns the grades with a note and shows the note on the draft", async () => {
    auth.role = "secretary";
    api.status = "sent";
    api.post.mockResolvedValue({ campus_id: 1, status: "draft", note: "Falta el parcial 2" });
    render(<SubmissionSlot campusId={1} />);
    const button = await screen.findByText("Devolver al docente");
    expect((button.closest("button") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Nota para devolver las notas al docente"), {
      target: { value: "Falta el parcial 2" },
    });
    fireEvent.click(button);
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/campuses/1/grades/submission/return", {
        note: "Falta el parcial 2",
      }),
    );
    expect(await screen.findByText("Falta el parcial 2")).toBeTruthy();
    expect(screen.getByText("Borrador")).toBeTruthy();
  });

  it("shows the server's error and keeps the state when an action fails", async () => {
    const { ApiError } = await import("../../../shared/api");
    api.post.mockRejectedValue(new ApiError(409, "Ya enviadas"));
    render(<SubmissionSlot campusId={1} />);
    fireEvent.click(await screen.findByText("Enviar notas a secretaría"));
    expect((await screen.findByRole("alert")).textContent).toBe("Ya enviadas");
    expect(screen.getByText("Borrador")).toBeTruthy();
  });
});
