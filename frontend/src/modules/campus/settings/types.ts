export type SettingEntry = {
  key: string;
  value: Record<string, unknown>;
  source: "campus" | "global";
  global_value: Record<string, unknown>;
  unconfirmed: boolean;
};

export type SettingChange = {
  id: number;
  actor_name: string | null;
  action: string;
  key: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  created_at: string;
};

export type SettingsOverview = { settings: SettingEntry[]; changes: SettingChange[] };
