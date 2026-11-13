/** Seam for F12: replace the body with the grades status bar. Mounted above the gradebook. */
export function SubmissionSlot({ campusId }: { campusId: number }) {
  return <div data-slot="grades-submission" data-campus-id={campusId} hidden />;
}
