import { z } from "zod";
import { defineAuthStrategy, type ApplyTarget } from "../strategy.ts";

const Key = z.string().min(1);
const ApiKeyConfig = z.union([
  z.strictObject({ key: Key, header: z.string().min(1) }),
  z.strictObject({ key: Key, query: z.string().min(1) }),
]);
type ApiKeyConfig = z.infer<typeof ApiKeyConfig>;

type ApiKeyCredential = { key: string };

/** Sets the header on an HTTP request, or on every request a browser session sends. */
export async function applyHeader(target: ApplyTarget, name: string, value: string): Promise<void> {
  if (target.kind === "http") target.request.headers.set(name, value);
  else await target.session.setExtraHeaders({ [name]: value });
}

export const apiKeyStrategy = defineAuthStrategy<ApiKeyConfig, ApiKeyCredential>({
  name: "api-key",
  config: ApiKeyConfig,
  cacheable: false,
  acquire: async (config) => ({ key: config.key }),
  apply: async (credential, target, config) => {
    if ("header" in config) return applyHeader(target, config.header, credential.key);
    if (target.kind === "browser") throw new Error(`an api key in the query parameter ${config.query} cannot apply to a browser`);
    target.request.url.searchParams.set(config.query, credential.key);
  },
  secrets: (credential) => [credential.key],
});
