import { BRAND } from "@bazam/core/brand";
import { definePlugin, PLUGIN_API_VERSION } from "@bazam/core/plugin";
import { jiraClient } from "./client.ts";
import { jiraTracker } from "./render.ts";

export default definePlugin({
  name: `${BRAND.scope}/tracker-jira`,
  apiVersion: PLUGIN_API_VERSION,
  trackers: [jiraTracker],
  trackerClients: [jiraClient],
});
