import { apiGet, apiPost, apiPut } from "../../../shared/api";

export type ClassSummary = {
  /** A student only ever gets "none" or "approved". */
  status: "none" | "draft" | "approved";
  body: string | null;
  /** True when the text came from a placeholder AI: show the "Simulado" badge. */
  simulated: boolean;
  generated_at: string | null;
  edited_at: string | null;
  approved_at: string | null;
  can_teach: boolean;
  transcript_ready: boolean;
  quota: { limit: number; used: number; remaining: number } | null;
};

const base = (classId: number) => `/classes/${classId}/summary`;

export const getSummary = (classId: number) => apiGet<ClassSummary>(base(classId));
export const generateSummary = (classId: number) =>
  apiPost<ClassSummary>(`${base(classId)}/generate`, {});
export const saveSummary = (classId: number, body: string) =>
  apiPut<ClassSummary>(base(classId), { body });
export const approveSummary = (classId: number) =>
  apiPost<ClassSummary>(`${base(classId)}/approve`, {});
