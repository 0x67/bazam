import type { z } from "zod";
import type { BrowserLogin, BrowserSession, Identities, JsonValue } from "../auth/index.ts";
import type { Environment } from "../env/index.ts";
import type { Redactor } from "../redact/index.ts";
import type { CaseOutcome, EvidenceStore } from "../result/index.ts";
import type { GuardedHttp } from "./http.ts";

/** An open name for what a driver can do on its device, such as "webauthn.virtual" or "camera.inject". */
export type Capability = string;

export interface StepContext {
  session: DriverSession;
  /** The identity the step runs as; undefined when neither the step nor its flow names one. */
  identity?: string;
  env: Environment;
  evidence: EvidenceStore;
  identities: Identities;
  /** What `${case.<name>}` reads: the case id and title, plus what steps save, such as a request step's `save:`. */
  values: Map<string, string>;
  /** The run's HTTP client, which sends as an identity when asked. */
  http: GuardedHttp;
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
  env: Environment;
  target: string;
  /** The target's entry in config, such as browser and headless. */
  settings: Record<string, JsonValue>;
  runDir: string;
  redactor: Redactor;
}

export interface DriverSession {
  capabilities: ReadonlySet<Capability>;
  /** The browser context the identity acts in, on a driver that has one. */
  browserFor?(identity: string): Promise<BrowserSession>;
  /** Present when the driver offers browser.login. */
  browserLogin?: BrowserLogin;
  /** Keeps the trace when the case did not pass. */
  close(outcome: CaseOutcome): Promise<void>;
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
