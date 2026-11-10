import { BRAND } from "@bazam/core/brand";
import { definePlugin, PLUGIN_API_VERSION } from "@bazam/core/plugin";
import { playwrightDriver } from "./driver.ts";
import { virtualPasskeyResolver } from "./passkey.ts";

export { playwrightDriver } from "./driver.ts";
export { pageFor } from "./page.ts";
export { virtualPasskeyResolver } from "./passkey.ts";

export default definePlugin({
  name: `${BRAND.scope}/driver-web`,
  apiVersion: PLUGIN_API_VERSION,
  drivers: [playwrightDriver],
  resolvers: [virtualPasskeyResolver],
});
