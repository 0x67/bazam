import { z } from "zod";
import { definePlugin, PLUGIN_API_VERSION } from "../../../src/plugin/index.ts";

export default definePlugin({
  name: "fixture-mail",
  apiVersion: PLUGIN_API_VERSION,
  steps: [{ kind: "wait-for-mail", schema: z.strictObject({ to: z.string() }), run: async () => {} }],
});
