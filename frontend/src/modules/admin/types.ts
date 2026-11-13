import type { Role } from "../../shared/auth";

export type CampusSummary = {
  id: number;
  name: string;
  university: string | null;
  created_at: string;
  professors: number;
  guests: number;
  students: number;
  suspended: number;
};

export type UserStatus = "invited" | "active" | "suspended";

export type Person = {
  id: number;
  email: string;
  full_name: string;
  role: Role;
  status: UserStatus;
  created_at: string;
};

export type Membership = {
  campus_id: number;
  campus_name: string;
  role: "professor" | "guest" | "student";
  status: "active" | "suspended";
  suspended_reason: string | null;
};

export type PersonDetail = Person & { memberships: Membership[] };
