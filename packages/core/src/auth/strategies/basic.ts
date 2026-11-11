import { z } from "zod";
import { defineAuthStrategy } from "../strategy.ts";
import { applyHeader } from "./api-key.ts";

const BasicConfig = z.strictObject({
  user: z.string().min(1),
  // some APIs take the key as the user and an empty password
  password: z.string(),
});
type BasicConfig = z.infer<typeof BasicConfig>;

type BasicCredential = { user: string; password: string };

/** The value of an `Authorization: Basic` header. */
export function basicAuthorization(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}

export const basicStrategy = defineAuthStrategy<BasicConfig, BasicCredential>({
  name: "basic",
  config: BasicConfig,
  cacheable: false,
  acquire: async (config) => ({ user: config.user, password: config.password }),
  apply: async (credential, target) => {
    // a header set on the browser would miss the hops of a redirect, while an answered challenge covers them
    if (target.kind === "browser")
      return target.session.setHttpCredentials({
        username: credential.user,
        password: credential.password,
      });
    return applyHeader(
      target,
      "authorization",
      basicAuthorization(credential.user, credential.password),
    );
  },
  // the joined pair, so the redactor also masks its base64 form, which is what the header carries
  secrets: (credential) => [credential.password, `${credential.user}:${credential.password}`],
});
