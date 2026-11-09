import { definePlugin, PLUGIN_API_VERSION } from "@bazam/core/plugin";

/**
 * Answers `otp-email` and `otp-sms` from the demo's `/test/otp` hook, read once at `params.url`.
 * List it in `plugins:` as `./plugins/ts-resolver/manifest.ts` to load it in-process; `plugin.ts` serves it as a process.
 */
export default definePlugin({
  name: "demo-ts-resolver",
  apiVersion: PLUGIN_API_VERSION,
  resolvers: [
    {
      name: "demo-otp-hook",
      kinds: ["otp-email", "otp-sms"],
      requires: [],
      automated: true,
      async resolve(request, ctx) {
        const url = request.params["url"];
        if (url === undefined || url === "") throw new Error("demo-otp-hook needs params.url, the hook to GET");
        const response = await ctx.http.send({
          method: "GET",
          url: new URL(url),
          headers: new Headers({ accept: "application/json" }),
          signal: ctx.signal,
        });
        // no code is waiting
        if (response.status === 404) return undefined;
        // the query may hold the recipient, so the message leaves the URL out
        if (response.status !== 200) throw new Error(`the hook answered ${response.status}`);
        const body = response.body;
        const code = typeof body === "object" && body !== null && "code" in body ? body.code : undefined;
        if (typeof code !== "string") throw new Error("the hook's answer holds no code");
        return { kind: "value", value: code };
      },
    },
  ],
});
