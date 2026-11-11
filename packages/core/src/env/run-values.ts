import { createHash } from "node:crypto";
import { UnresolvedPlaceholder } from "./placeholders.ts";

export interface CaseRunValues {
  /**
   * The value of `id`, `time` or `random(min, max, decimals)`. The same expression gives the same value
   * for the rest of the case. Throws UnresolvedPlaceholder for any other expression.
   */
  value(expression: string): string;
  /** Every value given so far, by expression. */
  recorded(): Record<string, string>;
}

const RANDOM = /^random\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(\d+)\s*\)$/;

export class RunValues {
  readonly #runId: string;
  readonly #time: string;
  readonly #seed: number;

  constructor(runId: string, startedAt: Date, seed: number) {
    this.#runId = runId;
    // separators keep the digit runs short, so the redactor's long digit pattern leaves it readable
    this.#time = startedAt.toISOString().replace(/\.\d{3}Z$/, "Z");
    this.#seed = seed;
  }

  /** Each case draws from its own stream, so its values do not depend on which other cases run. */
  forCase(caseId: string): CaseRunValues {
    const next = mulberry32(streamSeed(this.#seed, caseId));
    const values = new Map<string, string>();
    return {
      value: (expression) => {
        if (expression === "id" || expression === "time") {
          const fixed = expression === "id" ? this.#runId : this.#time;
          values.set(expression, fixed);
          return fixed;
        }
        const range = parseRandom(expression);
        if (range === undefined) throw new UnresolvedPlaceholder(`\${run.${expression}}`);
        let drawn = values.get(range.key);
        if (drawn === undefined) {
          drawn = unscaled(
            range.min + Math.floor(next() * (range.max - range.min + 1)),
            range.decimals,
          );
          values.set(range.key, drawn);
        }
        return drawn;
      },
      recorded: () => Object.fromEntries(values),
    };
  }
}

// min and max are scaled by 10^decimals
interface RandomRange {
  key: string;
  min: number;
  max: number;
  decimals: number;
}

function parseRandom(expression: string): RandomRange | undefined {
  const match = RANDOM.exec(expression);
  if (match === null) return undefined;
  const [, minText = "", maxText = "", decimalsText = ""] = match;
  const decimals = Number(decimalsText);
  const min = scaled(minText, decimals);
  const max = scaled(maxText, decimals);
  if (min === undefined || max === undefined || min > max) return undefined;
  // spacing differences in the call do not change the key
  return { key: `random(${minText}, ${maxText}, ${decimals})`, min, max, decimals };
}

// "1.5" with 2 decimals is 150; scaling the text keeps the bounds exact
function scaled(text: string, decimals: number): number | undefined {
  const [whole = "", fraction = ""] = text.split(".");
  if (fraction.length > decimals) return undefined;
  const n = Number(whole + fraction.padEnd(decimals, "0"));
  return Number.isSafeInteger(n) ? n : undefined;
}

function unscaled(n: number, decimals: number): string {
  if (decimals === 0) return String(n);
  const digits = String(Math.abs(n)).padStart(decimals + 1, "0");
  return `${n < 0 ? "-" : ""}${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

function streamSeed(seed: number, caseId: string): number {
  return createHash("sha256").update(`${seed}\0${caseId}`).digest().readUInt32LE(0);
}

// mulberry32: a 32-bit seeded generator returning floats in [0, 1)
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
