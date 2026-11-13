// Shapes of the campus API (schema v1 of the campus document).
import type { CampusAccess } from "../../shared/routing";

export type SectionKind = "general" | "info" | "week" | "session" | "assignment" | "resources";
export type WidgetKind = "classes" | "join_class" | "recordings" | "grades";

export type Block =
  | { type: "text"; id: string; text: string }
  | { type: "callout"; id: string; text: string }
  | { type: "link"; id: string; label: string; url: string }
  | { type: "checklist"; id: string; items: string[] }
  | { type: "widget"; id: string; widget: WidgetKind };

export type Section = {
  id: string;
  title: string;
  kind: SectionKind;
  visible: boolean;
  blocks: Block[];
};

export type CampusDocument = { schema: 1; sections: Section[] };

export type Template = {
  key: string;
  name: string;
  description: string;
  document: CampusDocument;
};

export type MemberRole = "professor" | "guest" | "student";

export type CampusDetail = {
  id: number;
  name: string;
  owner_id: number;
  created_at: string;
  access: CampusAccess;
  member_role: MemberRole | null;
  template_key: string;
  version: number;
  updated_at: string;
  document: CampusDocument;
};

export type CampusSummary = {
  id: number;
  name: string;
  owner_id: number;
  created_at: string;
  member_role: MemberRole | null;
  access: CampusAccess;
};

export type RevisionVia = "template" | "editor" | "ai" | "restore";

export type RevisionEntry = {
  id: number;
  version: number;
  summary: string;
  via: RevisionVia;
  proposal_id: number | null;
  created_by: number;
  created_by_name: string | null;
  created_at: string;
};

export type Revision = Omit<RevisionEntry, "created_by_name"> & { document: CampusDocument };
