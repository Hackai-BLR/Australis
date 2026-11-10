import { apiGet } from "../../shared/api";

export type Health = { status: string; database: string };

export const getHealth = () => apiGet<Health>("/health");
