import { definePlugin, PLUGIN_API_VERSION } from "@bazam/core/plugin";

const HOLD_TAG = "hold";

/**
 * Adds the plan check `hold-tag`, which blocks every selected case that carries the tag `hold`.
 * List it in `plugins:` as `./plugins/plan-check/manifest.ts`; it runs in-process and sends no request.
 */
export default definePlugin({
  name: "demo-plan-check",
  apiVersion: PLUGIN_API_VERSION,
  planChecks: [
    {
      name: "hold-tag",
      async check({ cases }) {
        const held = cases.filter(({ spec }) => spec.tags.includes(HOLD_TAG));
        return Object.fromEntries(
          held.map(({ caseId }) => [caseId, `tagged ${HOLD_TAG}; remove the tag to run it`]),
        );
      },
    },
  ],
});
