import { apiGet, apiPost, apiUpload } from "../../shared/api";
import type { LiveState } from "./follower";

export type Presentation = {
  id: number;
  campus_id: number;
  class_id: number | null;
  title: string;
  source_filename: string;
  page_count: number;
  created_at: string;
};

export const listPresentations = (campusId: string) =>
  apiGet<Presentation[]>(`/campuses/${campusId}/presentations`);

export function uploadPresentation(campusId: string, file: File, title: string) {
  const form = new FormData();
  form.append("title", title);
  form.append("file", file);
  return apiUpload<Presentation>(`/campuses/${campusId}/presentations`, form);
}

export const campusLive = (campusId: string) =>
  apiGet<LiveState | null>(`/campuses/${campusId}/live`);

export const liveState = (liveId: number) => apiGet<LiveState>(`/live/${liveId}/state`);

export const startLive = (presentationId: number) =>
  apiPost<LiveState>(`/presentations/${presentationId}/live`);

export const gotoPage = (liveId: number, page: number) =>
  apiPost<LiveState>(`/live/${liveId}/goto`, { page });

export const endLive = (liveId: number) => apiPost<LiveState>(`/live/${liveId}/end`);

export const presentationFileUrl = (presentationId: number) =>
  `/api/presentations/${presentationId}/file`;
