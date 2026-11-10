import { apiGet, apiPatch, apiPost } from "../../shared/api";

/** A class as the backend returns it. `starts_at` is UTC, "YYYY-MM-DD HH:MM:SS". */
export type ClassItem = {
  id: number;
  campus_id: number;
  campus_name: string;
  title: string;
  starts_at: string;
  duration_min: number;
  source: "placeholder" | "manual";
  /** True for a simulated meeting: show the "Simulado" badge. */
  simulated: boolean;
  join_url: string;
  /** Host link; only present for people who can teach the campus. */
  start_url: string | null;
  can_teach: boolean;
  recording_status: string;
  ended_at: string | null;
};

export type ZoomConnection = {
  connected: boolean;
  provider: string;
  simulated: boolean;
  connected_at: string | null;
};

export type NewClass = {
  title: string;
  starts_at: string;
  duration_min: number;
  join_url?: string;
};

export const listClasses = (campusId: string) =>
  apiGet<ClassItem[]>(`/campuses/${encodeURIComponent(campusId)}/classes`);
export const createClass = (campusId: string, body: NewClass) =>
  apiPost<ClassItem>(`/campuses/${encodeURIComponent(campusId)}/classes`, body);
export const getClass = (id: string) => apiGet<ClassItem>(`/classes/${encodeURIComponent(id)}`);
export const updateClass = (id: number, body: { ended?: boolean }) =>
  apiPatch<ClassItem>(`/classes/${id}`, body);
export const classesToday = () => apiGet<ClassItem[]>("/classes/today");
export const getZoomConnection = () => apiGet<ZoomConnection>("/zoom/connection");
export const connectZoom = () => apiPost<ZoomConnection>("/zoom/connection", {});

/** Parses the backend's UTC timestamp. */
export function parseUtc(value: string): Date {
  return new Date(value.replace(" ", "T") + "Z");
}

export function formatStart(value: string): string {
  return parseUtc(value).toLocaleString("es-AR", { dateStyle: "full", timeStyle: "short" });
}

export function formatTime(value: string): string {
  return parseUtc(value).toLocaleTimeString("es-AR", { timeStyle: "short" });
}

/** Turns a local date ("2026-11-13") and time ("18:00") from the form into a UTC ISO string. */
export function localToUtcIso(date: string, time: string): string {
  return new Date(`${date}T${time}`).toISOString();
}
