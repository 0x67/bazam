import { createHmac } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { ChallengeResolver } from "@bazam/core/challenge";

const STEP_MS = 30_000;
const DIGITS = 6;
// a code this close to the end of its step may expire before the app checks it
const MIN_REMAINING_MS = 3_000;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** The RFC 6238 code (HMAC-SHA1, 30 second steps, 6 digits) of a base32 seed at a moment. */
export function totpCode(seed: string, at: Date): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at.getTime() / STEP_MS)));
  const mac = createHmac("sha1", base32Decode(seed)).update(counter).digest();
  const offset = mac.readUInt8(mac.length - 1) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

/**
 * Answers `totp` with the code of the base32 seed held in the secret that `params.seed` names.
 * With fewer than three seconds left in the step it waits for the next one.
 */
export const totpResolver: ChallengeResolver = {
  name: "totp",
  kinds: ["totp"],
  requires: [],
  automated: true,
  async resolve(request, ctx) {
    const seedName = request.params["seed"];
    if (seedName === undefined || seedName === "") throw new Error("totp needs params.seed, the name of the secret that holds the seed");
    const seed = await ctx.secrets(seedName);
    const now = ctx.now().getTime();
    const remaining = STEP_MS - (now % STEP_MS);
    if (remaining >= MIN_REMAINING_MS) return { kind: "value", value: totpCode(seed, new Date(now)) };
    await sleep(remaining, undefined, { signal: ctx.signal });
    return { kind: "value", value: totpCode(seed, new Date(now + remaining)) };
  },
};

/** Takes the seed as authenticator apps show it: any case, spaces and padding allowed. */
function base32Decode(seed: string): Buffer {
  const text = seed.replace(/[\s=]/g, "").toUpperCase();
  // the message leaves out the seed, which is a secret
  if (text === "" || !text.split("").every((char) => BASE32.includes(char))) throw new Error("the TOTP seed is not base32");
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of text) {
    value = ((value << 5) | BASE32.indexOf(char)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}
