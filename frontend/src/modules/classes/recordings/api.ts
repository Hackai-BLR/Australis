import type { BadgeTone } from "../../../shared/ui";
import { apiDownload, apiGet, apiPost } from "../../../shared/api";

export type RecordingStatus = "none" | "pending" | "available" | "transcript_ready";

export type Recording = {
  status: RecordingStatus;
  /** True when the recording comes from the placeholder provider. */
  simulated: boolean;
  play_url: string | null;
  duration_s: number | null;
  transcript_text: string | null;
  published_at: string | null;
  /** Seconds from the end of the class to the publication of the recording. */
  delay_seconds: number | null;
};

/** Baseline: how long the university currently takes to publish a recording. */
export const BASELINE_HOURS = 72;

export const getRecording = (classId: number) => apiGet<Recording>(`/classes/${classId}/recording`);
export const syncRecording = (classId: number) =>
  apiPost<Recording>(`/classes/${classId}/recording/sync`, {});
export const downloadTranscript = (classId: number, format: "txt" | "vtt") =>
  apiDownload(
    `/classes/${classId}/transcript?format=${format}`,
    `transcripcion-clase-${classId}.${format}`,
  );

export function statusLabel(status: RecordingStatus): string {
  switch (status) {
    case "pending":
      return "Pendiente";
    case "available":
      return "Disponible";
    case "transcript_ready":
      return "Transcripción lista";
    default:
      return "Sin grabación";
  }
}

/** "3 min", "2 h 5 min" or "menos de 1 min". */
export function formatDelay(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return "menos de 1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** Splits text into parts, marking the pieces that match the query (case-insensitive). */
export function splitMatches(text: string, query: string): { text: string; match: boolean }[] {
  const needle = query.trim();
  if (!needle) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  const parts: { text: string; match: boolean }[] = [];
  let at = 0;
  for (;;) {
    const found = lower.indexOf(target, at);
    if (found < 0) break;
    if (found > at) parts.push({ text: text.slice(at, found), match: false });
    parts.push({ text: text.slice(found, found + target.length), match: true });
    at = found + target.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false });
  return parts;
}

export function statusTone(status: RecordingStatus): BadgeTone {
  if (status === "transcript_ready") return "success";
  if (status === "available") return "info";
  if (status === "pending") return "warning";
  return "neutral";
}
