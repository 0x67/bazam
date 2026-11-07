import { BRAND } from "@bazam/core/brand";
import { definePlugin, PLUGIN_API_VERSION } from "@bazam/core/plugin";
import { httpHookResolver } from "./otp-http-hook.ts";
import { mailpitResolver } from "./otp-mailpit.ts";
import { totpResolver } from "./totp.ts";

export default definePlugin({
  name: `${BRAND.scope}/resolvers`,
  apiVersion: PLUGIN_API_VERSION,
  resolvers: [totpResolver, mailpitResolver, httpHookResolver],
});
