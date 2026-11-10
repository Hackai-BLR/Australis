// Shapes returned by the roster endpoints, and the Spanish labels for them.

export type MemberRole = "professor" | "guest" | "student";
export type MemberStatus = "active" | "suspended";
export type UserStatus = "invited" | "active" | "suspended";

export type Member = {
  user_id: number;
  email: string;
  full_name: string;
  role: MemberRole;
  status: MemberStatus;
  user_status: UserStatus;
  suspended_reason: string | null;
};

export type Flag =
  | "duplicate_in_file"
  | "invalid_email"
  | "missing_name"
  | "already_member"
  | "existing_account"
  | "non_student_account"
  | "suspended_account";

export type PreviewRow = {
  line: number;
  full_name: string;
  email: string;
  flags: Flag[];
  importable: boolean;
};

export type Preview = {
  id: number;
  total: number;
  importable: number;
  counts: Partial<Record<Flag, number>>;
  rows: PreviewRow[];
};

export type InviteLink = {
  user_id: number;
  full_name: string;
  email: string;
  invite_url: string;
};

export type ConfirmResult = {
  created: number;
  added_existing: number;
  skipped: number;
  invites: InviteLink[];
};

export const FLAG_LABELS: Record<Flag, string> = {
  duplicate_in_file: "Repetido en el archivo",
  invalid_email: "Correo inválido",
  missing_name: "Falta el nombre",
  already_member: "Ya es miembro del curso",
  existing_account: "Ya tiene cuenta",
  non_student_account: "Cuenta de docente o Secretaría",
  suspended_account: "Cuenta suspendida",
};

/** Flags that only inform; every other flag keeps the row out of the import. */
export const INFO_FLAGS: Flag[] = ["existing_account"];

export const MEMBER_ROLE_LABELS: Record<MemberRole, string> = {
  professor: "Docente",
  guest: "Docente invitado",
  student: "Estudiante",
};
