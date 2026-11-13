import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ role: "professor" }));
const api = vi.hoisted(() => ({ status: "draft", note: null as string | null }));

vi.mock("../../../shared/auth", () => ({
  useAuth: () => ({ user: { id: 1, role: auth.role } }),
}));
vi.mock("../../../shared/api", () => ({
  ApiError: class extends Error {},
  apiGet: () => Promise.resolve({ campus_id: 1, status: api.status, note: api.note }),
  apiPost: vi.fn(),
}));

import { SubmissionSlot } from "./SubmissionSlot";

beforeEach(() => {
  auth.role = "professor";
  api.status = "draft";
  api.note = null;
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
});
