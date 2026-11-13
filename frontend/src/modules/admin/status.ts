import type { BadgeTone } from "../../shared/ui";
import type { UserStatus } from "./types";

export const STATUS: Record<UserStatus, { label: string; tone: BadgeTone }> = {
  invited: { label: "Invitado", tone: "info" },
  active: { label: "Activo", tone: "success" },
  suspended: { label: "Suspendido", tone: "danger" },
};
