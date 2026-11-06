import type { z } from "zod";
import type { Redactor } from "../redact/index.ts";

/** An open name for what a driver can do on its device, such as "webauthn.virtual" or "camera.inject". */
export type Capability = string;

export interface StepContext {
  session: DriverSession;
  /** The identity the step runs as. */
  identity: string;
  /** Fills the placeholders in a step value. */
  resolve<T>(value: T): Promise<T>;
  signal: AbortSignal;
}

export interface StepHandler<S = unknown> {
  kind: string;
  schema: z.ZodType<S>;
  run(step: S, ctx: StepContext): Promise<void>;
}

export interface LaunchOptions {
  target: string;
  runDir: string;
  redactor: Redactor;
}

export interface DriverSession {
  capabilities: ReadonlySet<Capability>;
  close(): Promise<void>;
}

export interface Driver {
  /** The case target this driver runs, such as "web". */
  target: string;
  /** Reports the capabilities of this device before any case runs. */
  probe(options: LaunchOptions): Promise<ReadonlySet<Capability>>;
  launch(options: LaunchOptions): Promise<DriverSession>;
  steps: readonly StepHandler[];
}

export function defineDriver(driver: Driver): Driver {
  return driver;
}
