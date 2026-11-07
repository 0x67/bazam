import type { ChallengeResolver } from "@bazam/core/challenge";

/**
 * Answers `otp-email` and `otp-sms` from a test-only backend endpoint: GETs `params.url` and returns the
 * value at `params.field`, a dot path such as `code` or `data.codes[0]`. A 404 means no code is waiting.
 */
export const httpHookResolver: ChallengeResolver = {
  name: "otp-http-hook",
  kinds: ["otp-email", "otp-sms"],
  requires: [],
  automated: true,
  async resolve(request, ctx) {
    const url = request.params["url"];
    const field = request.params["field"];
    if (url === undefined || url === "" || field === undefined || field === "") {
      throw new Error("otp-http-hook needs params.url, the hook to GET, and params.field, where its answer holds the code");
    }
    const hook = new URL(url);
    const response = await ctx.http.send({ method: "GET", url: hook, headers: new Headers({ accept: "application/json" }) });
    if (response.status === 404) return undefined;
    // the query may hold the recipient, so the message names only the path
    if (response.status !== 200) throw new Error(`the hook answered ${response.status} to GET ${hook.origin}${hook.pathname}`);
    const value = valueAt(response.body, field);
    if (typeof value === "string" || typeof value === "number") return { kind: "value", value: String(value) };
    throw new Error(`the hook's answer holds no text or number at ${field}`);
  },
};

function valueAt(body: unknown, field: string): unknown {
  const keys = field.replace(/\[(\d+)\]/g, ".$1").split(".");
  return keys.reduce<unknown>((value, key) => {
    if (Array.isArray(value)) return /^\d+$/.test(key) ? value[Number(key)] : undefined;
    const isRecord = typeof value === "object" && value !== null;
    return isRecord && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
  }, body);
}
