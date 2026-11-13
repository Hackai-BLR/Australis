import { useParams } from "react-router-dom";
import { useCampusAccess } from "../campus";
import { Gradebook } from "./Gradebook";
import { MyGradesView } from "./MyGrades";
import { SubmissionSlot } from "./submission/SubmissionSlot";
import "./grades.css";

/** Teachers get the gradebook; a student gets their own grades in this course. */
export function GradesTab() {
  const { id = "" } = useParams();
  const access = useCampusAccess(id);
  if (access === "view") return <MyGradesView campusId={Number(id)} />;
  return (
    <>
      <SubmissionSlot campusId={Number(id)} />
      <Gradebook campusId={id} />
    </>
  );
}
