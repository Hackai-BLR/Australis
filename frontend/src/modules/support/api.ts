import { apiGet, apiPatch, apiPost } from "../../shared/api";

export type ReportStatus = "open" | "resolved";

export type Report = {
  id: number;
  campus_id: number | null;
  reporter_id: number;
  reporter_name: string;
  page: string;
  body: string;
  status: ReportStatus;
  created_at: string;
  resolved_at: string | null;
};

export const sendReport = (data: { page: string; campus_id: number | null; text: string }) =>
  apiPost<Report>("/support/reports", data);

export const listReports = (status: ReportStatus) =>
  apiGet<Report[]>(`/support/reports?status=${status}`);

export const setReportStatus = (id: number, status: ReportStatus) =>
  apiPatch<Report>(`/support/reports/${id}`, { status });
