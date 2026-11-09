// Fails when a secret appears in any file under the project's runs folder, inside trace zips too. It looks for the
// secrets the project config registers, the secret values of the credentials in the project's credential cache,
// and the one-time codes each run could have read. It prints the file and the secret's name, never the value.
//
//   node scripts/secret-scan.ts <project root> [--totp-seed <secret name>] [--mailpit <url>]
//
// --totp-seed names the registered secret that holds the TOTP seed: the scan then looks for every code of that seed
// while a run that used TOTP lasted. --mailpit is Mailpit's base URL: the scan then looks for the codes in the mail
// Mailpit received while each run lasted.
//
// Exit codes: 0 nothing found, 1 a secret was found, 2 the scan could not run, such as when a secret has no value,
// the runs folder holds no files, or a run read codes from a source the options leave out, so a scan that checked
// nothing never passes.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import type { CachedCredential } from "../packages/core/src/auth/cache.ts";
import type { JsonValue } from "../packages/core/src/auth/strategy.ts";
import { BRAND } from "../packages/core/src/brand.ts";
import { builtinContributions } from "../packages/core/src/plugin/builtin.ts";
import { loadProjectConfig, type ProjectConfig } from "../packages/core/src/project.ts";
import { defaultRedactionRules, Redactor } from "../packages/core/src/redact/index.ts";
import type { CaseResult } from "../packages/core/src/result/evidence.ts";
import { resolveSecret, SecretMissing, type SecretProvider } from "../packages/core/src/secrets/index.ts";
import { totpCode } from "../packages/resolvers/src/totp.ts";

const USAGE = "usage: node scripts/secret-scan.ts <project root> [--totp-seed <secret name>] [--mailpit <url>]";
const repoRoot = path.resolve(import.meta.dirname, "..");
// the same unzipper the trace scrubber writes with, from the package that depends on it
const { unzipSync } = createRequire(path.join(repoRoot, "packages", "driver-web", "package.json"))("fflate") as {
  unzipSync: (zip: Uint8Array) => Record<string, Uint8Array>;
};

// the redactor ignores shorter values, so they may show up anywhere
const MIN_SCANNED = 4;
// A shorter form can occur by chance: inside a number a trace keeps (a timestamp that holds a 4-digit PIN), or as
// random bytes in an image, whose compressed pixels never hold drawn text anyway. Elsewhere it counts only as a
// whole token, and images are searched only for longer forms.
const MIN_ANYWHERE = 8;
const RUN_ID = /\d{8}-\d{6}-[\da-f]{4}/g;
// the evidence store writes these result.json fields unmasked, since the harness makes them
// (see packages/core/src/result/evidence.ts::EvidenceStore.finish)
const HARNESS_FIELDS = ["seed", "values", "durationMs"];
const ZIP_MAGIC = Buffer.from("PK\x03\x04", "latin1");
// PNG and JPEG, the screenshots and screencast frames a run writes
const IMAGE_MAGIC = [Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from([0xff, 0xd8, 0xff])];
// a JSON string escape, and a percent escape of an ASCII character
const JSON_ESCAPE = /\\(?:u[\da-fA-F]{4}|["\\/bfnrt])/g;
const JSON_ESCAPED: Readonly<Record<string, string>> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const PERCENT_ESCAPE = /%[0-7][\da-fA-F]/g;
// enough for JSON inside a JSON string and for a URL encoded twice
const MAX_DECODE_ROUNDS = 3;
// the web driver keeps passkeys in the credential cache under its resolver's name and registers their private keys
// (see packages/driver-web/src/passkey.ts::virtualPasskeyResolver)
const PASSKEY_RESOLVER = "passkey-virtual";
// a case reads its codes between its startedAt and finishedAt; the margin covers a clock that differs from Mailpit's
const CODE_MARGIN_MS = 30_000;
const TOTP_STEP_MS = 30_000;
// the otp-mailpit resolver's default pattern, which the example cases use
const MAILED_CODE = /\b\d{6}\b/g;
const MAILPIT_PAGE = 250;

class ScanError extends Error {}

interface Options {
  projectRoot: string;
  totpSeed: string | undefined;
  mailpit: string | undefined;
}

interface Secret {
  name: string;
  /** Forms of MIN_ANYWHERE or more characters, searched for anywhere. */
  long: string[];
  /** Shorter forms, searched for as whole tokens outside images. */
  short: RegExp[];
}

interface Hit {
  where: string;
  secret: string;
}

/** The time a run's cases took, from their result.json files, and the challenges they recorded. */
interface RunSpan {
  from: number;
  to: number;
  kinds: Set<string>;
  resolvers: Set<string>;
}

interface Mail {
  id: string;
  /** Epoch milliseconds on Mailpit's clock. */
  created: number;
}

async function main(): Promise<number> {
  const options = parsedOptions();
  const config = await projectConfig(options.projectRoot);
  const values = await secretValues(config, options.projectRoot);
  const secrets = [...registered(values), ...cachedCredentials(config, options.projectRoot)];
  const runsDir = path.join(options.projectRoot, "runs");
  const files = filesUnder(runsDir);
  const codes = await runCodes(runSpans(runsDir, files), options, values);
  const hits = files.flatMap((file) => {
    const where = path.relative(options.projectRoot, file);
    const scanned = [...secrets, ...(codes.get(runOf(runsDir, file)) ?? [])];
    return [...nameHits(where, where, scanned), ...contentHits(where, readFileSync(file), scanned)];
  });
  for (const hit of hits) console.log(`${hit.where}: ${hit.secret}`);
  const names = new Set([...secrets, ...[...codes.values()].flat()].map((secret) => secret.name));
  console.error(
    `${hits.length} hits in ${files.length} files under ${path.relative(process.cwd(), runsDir) || "."}, ` +
      `scanned for ${[...names].join(", ")}`,
  );
  return hits.length === 0 ? 0 : 1;
}

function parsedOptions(): Options {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: { "totp-seed": { type: "string" }, mailpit: { type: "string" } },
    });
  } catch (error) {
    throw new ScanError(`${(error as Error).message}\n${USAGE}`);
  }
  const [projectArg, ...rest] = parsed.positionals;
  if (projectArg === undefined || rest.length > 0) throw new ScanError(USAGE);
  return {
    projectRoot: path.resolve(projectArg),
    totpSeed: parsed.values["totp-seed"],
    mailpit: parsed.values.mailpit,
  };
}

async function projectConfig(projectRoot: string): Promise<ProjectConfig> {
  const { config, issues } = await loadProjectConfig(projectRoot);
  if (config === undefined) {
    const lines = issues.map((issue) => `${issue.file}:${issue.line}: ${issue.message}`);
    throw new ScanError(`the project config does not load:\n${lines.join("\n")}`);
  }
  return config;
}

async function secretValues(config: ProjectConfig, projectRoot: string): Promise<Map<string, string>> {
  if (config.secrets.names.length === 0) throw new ScanError("the project config registers no secrets");
  // the providers the core plugin registers; a plugin's own provider would need the plugin registry
  const builtin = builtinContributions(config, projectRoot).secretProviders ?? [];
  const providers = config.secrets.providers.map((name): SecretProvider => {
    const provider = builtin.find((candidate) => candidate.name === name);
    if (provider === undefined)
      throw new ScanError(
        `secret provider ${name} is not one the scan can read; the scan reads only the providers the core plugin registers`,
      );
    return provider;
  });
  const redactor = new Redactor(defaultRedactionRules());
  const values = new Map<string, string>();
  for (const name of config.secrets.names) values.set(name, await resolveSecret(name, providers, redactor));
  return values;
}

function registered(values: ReadonlyMap<string, string>): Secret[] {
  return [...values].flatMap(([name, value]) => {
    if (value.length < MIN_SCANNED) {
      console.error(`${name} is shorter than ${MIN_SCANNED} characters, which the redactor leaves alone; not scanned`);
      return [];
    }
    const secret = secretOf(name, [value]);
    if (secret.short.length > 0)
      console.error(`${name}: forms shorter than ${MIN_ANYWHERE} characters count only as whole tokens`);
    return [secret];
  });
}

/**
 * One secret per file in the credential cache, holding the values a run registers with its redactor when it uses
 * the credential: those its auth strategy names, or a passkey's private key.
 */
function cachedCredentials(config: ProjectConfig, projectRoot: string): Secret[] {
  const dir = path.join(projectRoot, BRAND.stateDir, "credentials");
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new ScanError(`cannot read ${dir}: ${(error as Error).message}`);
  }
  const strategies = builtinContributions(config, projectRoot).authStrategies ?? [];
  // CredentialCache.save names a file <env>+<identity>+<surface>+<strategy>.json; one it is writing ends in .tmp
  return files
    .filter((file) => file.endsWith(".json"))
    .toSorted()
    .map((file) => {
      const stem = file.slice(0, -".json".length);
      const owner = decodeURIComponent(stem.split("+").at(-1) ?? "");
      const { credential } = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as CachedCredential;
      const strategy = strategies.find((candidate) => candidate.cacheable && candidate.name === owner);
      const values: string[] | undefined =
        strategy !== undefined
          ? strategy.secrets(credential)
          : owner === PASSKEY_RESOLVER
            ? passkeyKeys(credential)
            : undefined;
      if (values === undefined) throw new ScanError(`cannot tell which values of the cached ${file} are secret`);
      return secretOf(`credential ${stem}`, values);
    });
}

function passkeyKeys(credential: JsonValue): string[] | undefined {
  if (!Array.isArray(credential)) return undefined;
  const keys = credential.map((passkey) =>
    typeof passkey === "object" && passkey !== null && !Array.isArray(passkey) ? passkey["privateKey"] : undefined,
  );
  return keys.every((key) => typeof key === "string") ? keys : undefined;
}

function runSpans(runsDir: string, files: readonly string[]): Map<string, RunSpan> {
  const spans = new Map<string, RunSpan>();
  for (const file of files) {
    const [run, caseDir, name, ...rest] = path.relative(runsDir, file).split(path.sep);
    if (run === undefined || caseDir === undefined || name !== "result.json" || rest.length > 0) continue;
    const result = parsedJson(readFileSync(file, "utf8")) as Partial<CaseResult> | null | undefined;
    const from = Date.parse(result?.startedAt ?? "");
    const to = Date.parse(result?.finishedAt ?? "");
    if (Number.isNaN(from) || Number.isNaN(to)) continue;
    const span = spans.get(run) ?? { from, to, kinds: new Set(), resolvers: new Set() };
    span.from = Math.min(span.from, from);
    span.to = Math.max(span.to, to);
    for (const challenge of result?.challenges ?? []) {
      span.kinds.add(challenge.kind);
      span.resolvers.add(challenge.resolver);
    }
    spans.set(run, span);
  }
  return spans;
}

/** The codes each run could have read, by run id. */
async function runCodes(
  spans: ReadonlyMap<string, RunSpan>,
  options: Options,
  values: ReadonlyMap<string, string>,
): Promise<Map<string, Secret[]>> {
  const { totpSeed } = options;
  const seed = totpSeed === undefined ? undefined : values.get(totpSeed);
  if (totpSeed !== undefined && seed === undefined)
    throw new ScanError(`--totp-seed ${totpSeed} is not a secret the project config registers`);
  const mailpit =
    options.mailpit === undefined ? undefined : { base: options.mailpit, mail: await mailpitMail(options.mailpit) };
  const codes = new Map<string, Secret[]>();
  for (const [run, span] of spans) {
    const from = span.from - CODE_MARGIN_MS;
    const to = span.to + CODE_MARGIN_MS;
    const secrets: Secret[] = [];
    if (span.kinds.has("totp")) {
      if (seed === undefined)
        throw new ScanError(`run ${run} used TOTP codes; give --totp-seed the name of the secret that holds the seed`);
      secrets.push(secretOf(`TOTP code of ${totpSeed}`, totpCodes(seed, from, to)));
    }
    const readMailpit = span.resolvers.has("otp-mailpit");
    if (readMailpit && mailpit === undefined)
      throw new ScanError(`run ${run} read codes from Mailpit; give --mailpit its URL`);
    if (mailpit !== undefined) {
      // every mail Mailpit received while the run lasted, also mail no resolver read,
      // such as a code a test hook returned
      const received = mailpit.mail.filter((mail) => mail.created >= from && mail.created <= to);
      if (readMailpit && received.length === 0)
        throw new ScanError(`run ${run} read codes from Mailpit, which holds no mail from that time`);
      secrets.push(secretOf("code mailed to Mailpit", await mailedCodes(mailpit.base, received)));
    }
    codes.set(run, secrets);
  }
  return codes;
}

function totpCodes(seed: string, from: number, to: number): string[] {
  const codes: string[] = [];
  for (let step = Math.floor(from / TOTP_STEP_MS); step <= Math.floor(to / TOTP_STEP_MS); step++)
    codes.push(totpCode(seed, new Date(step * TOTP_STEP_MS)));
  return codes;
}

/** Every message Mailpit holds. */
async function mailpitMail(base: string): Promise<Mail[]> {
  const mail: Mail[] = [];
  for (;;) {
    const page = (await mailpitJson(base, `/api/v1/messages?start=${mail.length}&limit=${MAILPIT_PAGE}`)) as {
      total: number;
      messages: { ID: string; Created: string }[];
    };
    mail.push(...page.messages.map((message) => ({ id: message.ID, created: Date.parse(message.Created) })));
    if (page.messages.length === 0 || mail.length >= page.total) return mail;
  }
}

async function mailedCodes(base: string, mail: readonly Mail[]): Promise<string[]> {
  const codes: string[] = [];
  for (const { id } of mail) {
    const message = (await mailpitJson(base, `/api/v1/message/${encodeURIComponent(id)}`)) as { Text?: string };
    codes.push(...((message.Text ?? "").match(MAILED_CODE) ?? []));
  }
  return codes;
}

async function mailpitJson(base: string, pathAndQuery: string): Promise<unknown> {
  const url = `${base.replace(/\/+$/, "")}${pathAndQuery}`;
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "application/json" } });
  } catch (error) {
    throw new ScanError(`cannot reach Mailpit at ${url}: ${(error as Error).message}`);
  }
  if (!response.ok) throw new ScanError(`Mailpit answered ${response.status} to ${url}`);
  return response.json();
}

function secretOf(name: string, values: readonly string[]): Secret {
  const forms = [...new Set(values.filter((value) => value.length >= MIN_SCANNED).flatMap(encodedForms))];
  return {
    name,
    long: forms.filter((form) => form.length >= MIN_ANYWHERE),
    short: forms.filter((form) => form.length < MIN_ANYWHERE).map(asToken),
  };
}

// the forms the redactor masks (see packages/core/src/redact/redactor.ts::Redactor.register)
function encodedForms(value: string): string[] {
  const formEncoded = new URLSearchParams({ value }).toString().slice("value=".length);
  return [value, encodeURIComponent(value), formEncoded, Buffer.from(value, "utf8").toString("base64")];
}

function filesUnder(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  } catch (error) {
    throw new ScanError(`cannot read ${dir}: ${(error as Error).message}`);
  }
  const files = entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
  if (files.length === 0) throw new ScanError(`${dir} holds no files; run the cases before the scan`);
  return files.sort();
}

// the run folder a file sits in; a file directly in the runs folder gets its own name, which no run has
function runOf(runsDir: string, file: string): string {
  return path.relative(runsDir, file).split(path.sep)[0] ?? "";
}

// a file path or a zip entry name
function nameHits(where: string, name: string, secrets: readonly Secret[]): Hit[] {
  return textHits(name.replaceAll(RUN_ID, " "), secrets).map((secret) => ({ where, secret }));
}

function contentHits(where: string, bytes: Uint8Array, secrets: readonly Secret[]): Hit[] {
  if (startsWith(bytes, ZIP_MAGIC)) {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(bytes);
    } catch (error) {
      throw new ScanError(`cannot unzip ${where}: ${(error as Error).message}`);
    }
    return Object.entries(entries).flatMap(([name, entry]) => [
      ...nameHits(`${where}!${name}`, name, secrets),
      ...contentHits(`${where}!${name}`, entry, secrets),
    ]);
  }
  const found = IMAGE_MAGIC.some((magic) => startsWith(bytes, magic))
    ? secrets.filter((secret) => secret.long.some((form) => contains(bytes, form))).map((secret) => secret.name)
    : textHits(scannedText(where, asText(bytes)), secrets);
  return found.map((secret) => ({ where, secret }));
}

// a run id is generated, and its hex part can hold a short value by chance
function scannedText(where: string, text: string): string {
  return (path.basename(where) === "result.json" ? withoutHarnessFields(text) : text).replaceAll(RUN_ID, " ");
}

function withoutHarnessFields(text: string): string {
  const result = parsedJson(text);
  if (typeof result !== "object" || result === null || Array.isArray(result)) return text;
  const kept = Object.entries(result).filter(([key]) => !HARNESS_FIELDS.includes(key));
  return JSON.stringify(Object.fromEntries(kept));
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// also searches the text with its escapes undone, so a short value right after \n or %3D is the whole token it is
function textHits(text: string, secrets: readonly Secret[]): string[] {
  const views = [...new Set([text, unescaped(text)])];
  return secrets
    .filter((secret) =>
      views.some(
        (view) => secret.long.some((form) => view.includes(form)) || secret.short.some((token) => token.test(view)),
      ),
    )
    .map((secret) => secret.name);
}

function unescaped(text: string): string {
  let out = text;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
    const next = out
      .replace(JSON_ESCAPE, (escape) =>
        escape[1] === "u"
          ? String.fromCharCode(Number.parseInt(escape.slice(2), 16))
          : (JSON_ESCAPED[escape.slice(1)] ?? escape.slice(1)),
      )
      .replace(PERCENT_ESCAPE, (escape) => String.fromCharCode(Number.parseInt(escape.slice(1), 16)));
    if (next === out) break;
    out = next;
  }
  return out;
}

// not joined to a letter or a digit, nor to a digit through a decimal point, so 12.2468 and 2468.5 are one number
function asToken(form: string): RegExp {
  const escaped = form.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}]|\\p{N}\\.)${escaped}(?![\\p{L}\\p{N}]|\\.\\p{N})`, "u");
}

function startsWith(bytes: Uint8Array, magic: Buffer): boolean {
  return Buffer.from(bytes.subarray(0, magic.length)).equals(magic);
}

function contains(bytes: Uint8Array, form: string): boolean {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(Buffer.from(form, "utf8"));
}

// Bytes that are not UTF-8 read as U+FFFD, which joins no token. The trace scrubber copies such zip entries
// unmasked (see packages/driver-web/src/trace.ts::scrubTrace), so this scan is the only check on them.
function asText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

try {
  process.exitCode = await main();
} catch (error) {
  // a problem the scan names prints its message alone; anything else keeps its stack
  console.error(error instanceof ScanError || error instanceof SecretMissing ? error.message : error);
  process.exitCode = 2;
}
