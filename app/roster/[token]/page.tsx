import { notFound } from "next/navigation";
import { ExperimentWorkspace } from "@/app/workspace";
import { getExperimentEntry } from "@/lib/experiment-entry";
import { getAuthenticatedSession } from "@/lib/session";
import { getExperimentSettings } from "@/lib/experiment-settings";
import { rosterClasses } from "@/lib/roster";
import { ApiError } from "@/lib/http";

export const dynamic = "force-dynamic";
export default async function RosterPage({params}:{params:Promise<{token:string}>}) {
  const {token}=await params;
  let entry;
  try {entry=await getExperimentEntry(token);}
  catch(error) {if(error instanceof ApiError && error.status===404) notFound();throw error;}
  if(entry.assignmentMode!=="roster") notFound();
  const session=await getAuthenticatedSession(entry);
  const config=session?.configSnapshot?.experiment ?? entry.snapshot?.experiment ?? (await getExperimentSettings(entry.experimentId,false)).experiment;
  return <ExperimentWorkspace key={entry.token} experiment={config} entryToken={entry.token}
    rosterClasses={await rosterClasses(entry.runId)} />;
}
