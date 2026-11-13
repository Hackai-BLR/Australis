import { ReportButton } from "./ReportButton";

/** The F16 seam of the app shell: the "Reportar un problema" button, mounted on every page. */
export function ReportProblemSlot() {
  return (
    <div data-slot="report-problem">
      <ReportButton />
    </div>
  );
}
