import { apiDownload, apiGet, apiPut } from "../../../shared/api";

export type Note = { page: number; body: string; updated_at: string };

export const listNotes = (presentationId: number) =>
  apiGet<Note[]>(`/presentations/${presentationId}/notes`);

export const saveNote = (presentationId: number, page: number, body: string) =>
  apiPut<Note | null>(`/presentations/${presentationId}/notes/${page}`, { body });

export const exportNotes = (presentationId: number) =>
  apiDownload(`/presentations/${presentationId}/notes/export`, "notas.txt");
