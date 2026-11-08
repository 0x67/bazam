import { AsyncLocalStorage } from "node:async_hooks";
import type { BrowserLogin, BrowserLoginRequest, StorageState } from "../auth/index.ts";
import { expandFlows, type FlowSpec } from "../case/index.ts";
import type { HumanChannel, PersonAnswer, PersonPrompt } from "../challenge/index.ts";
import type { DriverSession } from "../driver/index.ts";
import type { Redactor } from "../redact/index.ts";
import { CaseBlocked } from "./outcome.ts";

export interface LoginScope {
  runId: string;
  flows: ReadonlyMap<string, FlowSpec>;
  /** Fills the placeholders in the login flow. */
  resolve<T>(value: T): Promise<T>;
  channel: HumanChannel;
  redactor: Redactor;
  /** Aborts every login when the run is cancelled. */
  signal: AbortSignal;
}

type LoginResult = { state: StorageState; finalUrl: URL };

type SessionProvider = () => Promise<DriverSession>;

/**
 * The one BrowserLogin a run gives Identities. Each login runs in the driver session the runner points it at:
 * the session of the case whose async context starts the login, else the preflight session.
 */
export class RunBrowserLogin implements BrowserLogin {
  readonly #scope: LoginScope;
  readonly #caseSession = new AsyncLocalStorage<SessionProvider>();
  #session: SessionProvider | undefined;

  constructor(scope: LoginScope) {
    this.#scope = scope;
  }

  /** Points later logins outside `within` at a session; the function may launch it on first use. */
  use(session: SessionProvider | undefined): void {
    this.#session = session;
  }

  /** Runs `fn` with the logins started in its async context pointed at `session`. */
  within<T>(session: SessionProvider, fn: () => Promise<T>): Promise<T> {
    return this.#caseSession.run(session, fn);
  }

  /** Expands and resolves the flow, then shows the prompt while the driver waits; a refusal aborts the login. */
  async login(request: BrowserLoginRequest): Promise<LoginResult> {
    const session = this.#caseSession.getStore() ?? this.#session;
    const browserLogin = (await session?.())?.browserLogin;
    if (browserLogin === undefined) throw new Error("no open driver session offers browser.login");
    const stop = new AbortController();
    const signals = [stop.signal, this.#scope.signal, ...(request.signal === undefined ? [] : [request.signal])];
    const forDriver: BrowserLoginRequest = {
      url: request.url,
      until: request.until,
      timeoutMs: request.timeoutMs,
      signal: AbortSignal.any(signals),
    };
    if (request.flow !== undefined)
      forDriver.flow = await this.#scope.resolve(expandFlows(request.flow, this.#scope.flows));
    if (request.prompt === undefined) return browserLogin.login(forDriver);
    // the driver never shows the prompt, but learns from it that a person acts and needs a visible browser
    forDriver.prompt = maskPrompt({ ...request.prompt, runId: this.#scope.runId }, this.#scope.redactor);
    return this.#withPerson(browserLogin.login(forDriver), forDriver.prompt, stop);
  }

  /** `prompt` is already masked. */
  async #withPerson(login: Promise<LoginResult>, prompt: PersonPrompt, stop: AbortController): Promise<LoginResult> {
    const asked = new AbortController();
    const answer = this.#scope.channel.ask(prompt, AbortSignal.any([asked.signal, this.#scope.signal]));
    try {
      const first = await Promise.race([login.then((done) => ({ done })), answer.then((reply) => ({ reply }))]);
      if ("done" in first) return first.done;
      const refusal = refusalOf(first.reply);
      if (refusal === undefined) return await login;
      stop.abort();
      // the driver stops acting before the next login or case uses the session
      await login.then(
        () => undefined,
        () => undefined,
      );
      throw new CaseBlocked(`login prompt ${prompt.id}: ${refusal}`);
    } catch (error) {
      stop.abort();
      throw error;
    } finally {
      // a login that ended before the person answered drops its prompt
      asked.abort();
    }
  }
}

/** The prompt with every registered secret masked in its text, since channels write prompts to disk. */
export function maskPrompt(prompt: PersonPrompt, redactor: Redactor): PersonPrompt {
  const masked: PersonPrompt = {
    ...prompt,
    title: redactor.text(prompt.title),
    steps: prompt.steps.map((step) => redactor.text(step)),
  };
  if (prompt.expected !== undefined) masked.expected = redactor.text(prompt.expected);
  return masked;
}

/** Why the person's answer ends the login, or undefined when the login goes on. */
function refusalOf(answer: PersonAnswer): string | undefined {
  if (answer.kind === "timeout") return "no answer from a person in time";
  if (answer.kind !== "verdict" || answer.verdict === "pass") return undefined;
  return `the person answered ${answer.verdict}${answer.note === "" ? "" : `: ${answer.note}`}`;
}
