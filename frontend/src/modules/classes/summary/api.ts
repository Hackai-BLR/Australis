import { apiGet, apiPost, apiPut } from "../../../shared/api";

export type ClassSummary = {
  /** A student only ever gets "none" or "approved". */
  status: "none" | "draft" | "approved";
  body: string | null;
  /** True while the saved text is still the placeholder AI's draft; false once the professor edited it. */
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
export const generateSummary = (classId: number, overwrite = false) =>
  apiPost<ClassSummary>(`${base(classId)}/generate`, { overwrite });
export const saveSummary = (classId: number, body: string) =>
  apiPut<ClassSummary>(base(classId), { body });
/** `body` is the exact text the professor saw; the server answers 409 if it changed since. */
export const approveSummary = (classId: number, body: string) =>
  apiPost<ClassSummary>(`${base(classId)}/approve`, { body });
