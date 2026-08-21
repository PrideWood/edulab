import { ExperimentWorkspace } from "./workspace";
import { experiment } from "@/config/experiment";
import { getExperimentSettings } from "@/lib/experiment-settings";
import { getAuthenticatedSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function Home() {
  let configured = experiment;
  try {
    const session = await getAuthenticatedSession();
    configured = session?.configSnapshot?.experiment ?? (await getExperimentSettings(experiment.id)).experiment;
  } catch { configured = experiment; }
  return <ExperimentWorkspace experiment={configured} />;
}
