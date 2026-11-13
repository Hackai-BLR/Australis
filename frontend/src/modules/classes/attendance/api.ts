import type { BadgeTone } from "../../../shared/ui";
import { apiGet, apiPost, apiPut } from "../../../shared/api";

export type AttendanceStatus = "present" | "absent" | "late" | "excused";

export const STATUS_LABELS: Record<AttendanceStatus, string> = {
  present: "Presente",
  absent: "Ausente",
  late: "Tarde",
  excused: "Justificado",
};

export const STATUS_TONES: Record<AttendanceStatus, BadgeTone> = {
  present: "success",
  absent: "danger",
  late: "warning",
  excused: "neutral",
};

export type AttendanceRow = {
  user_id: number;
  full_name: string;
  status: AttendanceStatus | null;
  source: "session" | "manual" | null;
  reason: string | null;
  updated_at: string | null;
};

export type AttendanceSheet = {
  class_id: number;
  can_teach: boolean;
  simulated: boolean;
  rule: { min_percent: number; confirmed: boolean };
  late_after_minutes: number;
  late_after_confirmed: boolean;
  rows: AttendanceRow[];
};

export type TakeResult = AttendanceSheet & { unmatched: string[] };

export type AttendanceEntry = { user_id: number; status: AttendanceStatus };

export const getAttendance = (classId: number) =>
  apiGet<AttendanceSheet>(`/classes/${classId}/attendance`);
export const saveAttendance = (classId: number, entries: AttendanceEntry[], reason: string) =>
  apiPut<AttendanceSheet>(`/classes/${classId}/attendance`, { entries, reason });
export const takeFromSession = (classId: number, reason: string) =>
  apiPost<TakeResult>(`/classes/${classId}/attendance/from-session`, { reason });

/** The entries whose chosen status differs from what is saved. */
export function pendingEntries(
  rows: AttendanceRow[],
  draft: Record<number, AttendanceStatus>,
): AttendanceEntry[] {
  return rows
    .filter((row) => draft[row.user_id] !== undefined && draft[row.user_id] !== row.status)
    .map((row) => ({ user_id: row.user_id, status: draft[row.user_id] }));
}

/** True when saving these entries changes a record that already exists (a reason is needed). */
export function needsReason(rows: AttendanceRow[], entries: AttendanceEntry[]): boolean {
  const saved = new Set(rows.filter((row) => row.status !== null).map((row) => row.user_id));
  return entries.some((entry) => saved.has(entry.user_id));
}
