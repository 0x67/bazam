import { z } from "zod";
import { defineDriver, type Capability, type Driver, type StepHandler } from "../../src/driver/index.ts";

export interface FakeDriverOptions {
  target?: string;
  capabilities?: readonly Capability[];
  steps?: readonly StepHandler[];
}

/** A driver with no device behind it: probe and every session report the configured capabilities. */
export function fakeDriver(options: FakeDriverOptions = {}): Driver {
  const capabilities: ReadonlySet<Capability> = new Set(options.capabilities ?? []);
  return defineDriver({
    target: options.target ?? "fake",
    probe: async () => capabilities,
    launch: async () => ({ capabilities, close: async () => {} }),
    steps: options.steps ?? [],
  });
}

/** A step handler that accepts any payload and does nothing. */
export function fakeStep(kind: string): StepHandler {
  return { kind, schema: z.unknown(), run: async () => {} };
}
