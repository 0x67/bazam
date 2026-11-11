import type { CaseSpec } from "../case/index.ts";
import type { ProjectConfig } from "../project.ts";
import type { TicketState } from "./client.ts";
import { ticketRef, trackerProject } from "./post-plan.ts";

export type TicketVerdict = { ready: true } | { ready: false; reason: string };

/**
 * Ready when the case has a link and every linked ticket's status is in its project's `promoteOn`, ignoring
 * letter case. `states` is keyed by link, as `jira:DEMO-12`. The reason names the first link that is not ready.
 */
export function ticketsReadyForPromotion(
  spec: CaseSpec,
  states: ReadonlyMap<string, TicketState>,
  config: ProjectConfig,
): TicketVerdict {
  if (spec.links.length === 0) return { ready: false, reason: "no linked tickets" };
  for (const link of spec.links) {
    const { tracker, key } = ticketRef(link);
    const project = trackerProject(key);
    const trackerConfig = Object.hasOwn(config.trackers, tracker)
      ? config.trackers[tracker]
      : undefined;
    const projectConfig =
      trackerConfig !== undefined && Object.hasOwn(trackerConfig.projects, project)
        ? trackerConfig.projects[project]
        : undefined;
    if (projectConfig === undefined)
      return {
        ready: false,
        reason: `project ${project} is not listed under trackers.${tracker}.projects`,
      };
    const state = states.get(link);
    if (state === undefined) return { ready: false, reason: `${key} was not read` };
    const { promoteOn } = projectConfig;
    if (!promoteOn.some((status) => status.toLowerCase() === state.status.toLowerCase())) {
      const listed =
        promoteOn.length === 0
          ? `trackers.${tracker}.projects.${project}.promoteOn lists no status`
          : `promoteOn lists ${promoteOn.join(", ")}`;
      return { ready: false, reason: `${key} is ${state.status}; ${listed}` };
    }
  }
  return { ready: true };
}
