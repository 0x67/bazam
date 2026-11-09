import type { z } from "zod";
import type { BrowserLogin, BrowserSession, Identities, JsonValue } from "../auth/index.ts";
import type { Environment } from "../env/index.ts";
import type { Redactor } from "../redact/index.ts";
import type { EvidenceStore, Status } from "../result/index.ts";
import type { GuardedHttp } from "./http.ts";

/** An open name for what a driver can do on its device, such as "webauthn.virtual" or "camera.inject". */
export type Capability = string;

/** The part of a case's evidence that steps and `close` use, which a process plugin can also offer. */
export type StepEvidence = Pick<EvidenceStore, "record" | "note" | "followup" | "attach">;

export interface StepContext {
  session: DriverSession;
  /** The identity the step runs as, its own or one inherited from a `use`, challenge or guided step; else undefined. */
  identity?: string;
  env: Environment;
  evidence: StepEvidence;
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
  /** The target's entry in config without `driver`, such as browser and headless. */
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
  /** Ends the session; a driver that records traces attaches them to `ending.evidence` unless `ending.status` is pass. */
  close(ending: CaseEnding): Promise<void>;
}

/** How the case ended, decided before the session closes. */
export interface CaseEnding {
  status: Status;
  evidence: StepEvidence;
}

export interface Driver {
  /** What `targets.<t>.driver` names in config, such as "playwright". */
  name: string;
  /** The identity surface its sessions authorize, such as "web". */
  surface: string;
  /** Reports the capabilities of this device before any case runs. */
  probe(options: LaunchOptions): Promise<ReadonlySet<Capability>>;
  launch(options: LaunchOptions): Promise<DriverSession>;
  steps: readonly StepHandler[];
}

export function defineDriver(driver: Driver): Driver {
  return driver;
}
