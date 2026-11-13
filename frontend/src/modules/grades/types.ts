import type { Scale } from "./paste";

export type Item = {
  id: number;
  campus_id: number;
  title: string;
  weight: number;
  position: number;
  archived_at: string | null;
};

export type Student = { user_id: number; full_name: string; email: string; suspended: boolean };

export type Entry = { item_id: number; student_id: number; score: number | null };

export type Gradebook = {
  items: Item[];
  students: Student[];
  entries: Entry[];
  finals: { student_id: number; final: number | null }[];
  scale: Scale & { confirmed?: boolean };
  final_rule: { kind: string; confirmed?: boolean };
};

export type AuditRow = {
  id: number;
  actor_name: string | null;
  entity: string;
  entity_id: number;
  subject_user_id: number | null;
  action: string;
  before: { score?: number | null } | null;
  after: { score?: number | null } | null;
  reason: string | null;
  created_at: string;
};

export type MyCourse = {
  campus_id: number;
  campus_name: string;
  /** The course's own scale (a campus may override the program default). */
  scale?: Scale & { confirmed?: boolean };
  final: number | null;
  items: { item_id: number; title: string; weight: number; score: number | null }[];
};

export type MyGradesData = { scale: Scale & { confirmed?: boolean }; courses: MyCourse[] };
