import type { StepContext } from "@bazam/core/driver";
import { CaseBlocked } from "@bazam/core/run";
import type { Page } from "playwright";
import { WebSession } from "./driver.ts";

/** The Playwright page of the step's identity, or of the case's anonymous context when the step names none. */
export async function pageFor(ctx: StepContext): Promise<Page> {
  if (!(ctx.session instanceof WebSession)) throw new CaseBlocked("pageFor needs a session of the playwright driver");
  return ctx.session.pageFor(ctx.identity);
}
