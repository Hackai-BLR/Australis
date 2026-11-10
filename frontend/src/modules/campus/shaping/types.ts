import type { CampusDocument } from "../types";

export type ProposalStatus = "pending" | "empty" | "accepted" | "rejected" | "stale";

export type Proposal = {
  id: number;
  user_id: number;
  user_name: string | null;
  instruction: string;
  status: ProposalStatus;
  /** What the assistant said. */
  message: string;
  base_version: number;
  /** One line per change, in Spanish. */
  changes: string[];
  /** The campus as it would be after accepting; only while the proposal is pending. */
  preview: CampusDocument | null;
  simulated: boolean;
  revision_version: number | null;
  created_at: string;
  decided_at: string | null;
};

export type ShapingUsage = {
  used_today: number;
  quota: number;
  remaining: number;
  logged_calls: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
  cost_is_estimate: boolean;
  simulated: boolean;
};
