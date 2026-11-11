import { stat } from "node:fs/promises";
import { join } from "node:path";
import { CredentialCache, Identities } from "@bazam/core/auth";
import { BRAND } from "@bazam/core/brand";
import { stagePolicy } from "@bazam/core/case";
import { phoneForm } from "@bazam/core/env";
import {
  LOCAL_FIXTURES_FILE,
  declaredSecretNames,
  type IdentityFixtures,
} from "@bazam/core/project";
import { isTestEmailDomain } from "@bazam/core/redact";
import { identitiesNamed } from "@bazam/core/run";
import type { SecretProvider } from "@bazam/core/secrets";
import { CommandError, ExitCode } from "../exit.ts";
import { plural } from "../io.ts";
import type { CommandContext } from "../main.ts";
import { credentialDirs, credentialScope, envOf } from "./keepalive.ts";

/** One line of the report; a line with a fix is a problem. */
interface Line {
  text: string;
  fix?: string;
}

const EMAIL = /^[^@\s]+@([^@\s]+\.[^@\s]+)$/;
const SECRET_FIELD = /^(password|pin|passcode)$/i;

/**
 * Checks that the secrets, the local fixtures and the cached credentials the env's cases need are in place,
 * without printing a value. Exits 1 with any problem, 0 with none.
 */
export async function doctorCommand(ctx: CommandContext): Promise<number> {
  const { project, registry } = await ctx.load();
  const { config } = project;
  const env = envOf(config, ctx.flags.env);
  const providers = registry.secretProviders(config.secrets.providers);
  const stateDir = join(project.root, BRAND.stateDir);
  const sections = {
    Secrets: await secretLines(
      ctx,
      config.secrets.providers,
      providers,
      declaredSecretNames(config),
      stateDir,
    ),
    "Local files": await fileLines(stateDir),
    Identities: [] as Line[],
  };

  const scope = await credentialScope(ctx, config, registry, env);
  const { cacheDir, lockDir } = credentialDirs(project.root);
  const identities = new Identities({
    env,
    configs: config.identities,
    fixtures: scope.fixtures,
    registry,
    cache: new CredentialCache(cacheDir),
    lockDir,
    resolve: scope.resolve,
    redactor: ctx.redactor,
    log: scope.log,
    projectRoot: project.root,
    channel: scope.channel,
    now: () => new Date(),
  });
  const named = new Set<string>();
  for (const { spec } of project.cases) {
    if (!stagePolicy(spec.stage).runs || (env.production && !spec.prod_safe)) continue;
    for (const name of identitiesNamed(spec, project.flows)) {
      for (const identity of Object.hasOwn(config.roles, name)
        ? config.roles[name]!.identities
        : [name])
        named.add(identity);
    }
  }
  for (const name of [...named].toSorted()) {
    const lines = await identityLines(name, config.identities[name], scope.fixtures, identities);
    sections.Identities.push(...lines);
  }

  const problems = Object.values(sections)
    .flat()
    .filter((line) => line.fix !== undefined);
  const text = Object.entries(sections).flatMap(([title, lines]) => [
    title,
    ...(lines.length === 0
      ? ["  none"]
      : lines.flatMap(({ text, fix }) => [`  ${text}`, ...(fix ? [`    fix: ${fix}`] : [])])),
    "",
  ]);
  text.push(plural(problems.length, "problem"));
  // registered masking: the Secrets key would match the redactor's sensitive keys and mask its whole section
  ctx.out.result(
    { env: env.name, ...sections, problems: problems.length },
    `${text.join("\n")}\n`,
    "registered",
  );
  return problems.length === 0 ? ExitCode.Pass : ExitCode.Fail;
}

async function secretLines(
  ctx: CommandContext,
  providerNames: readonly string[],
  providers: readonly SecretProvider[],
  names: readonly string[],
  stateDir: string,
): Promise<Line[]> {
  const lines: Line[] = [];
  const failed = new Set<string>();
  for (const name of names) {
    let holder: string | undefined;
    for (const provider of providers) {
      try {
        const value = await provider.load(name);
        if (!value) continue;
        ctx.redactor.register(value);
        holder = provider.name;
        break;
      } catch (error) {
        if (failed.has(provider.name)) continue;
        failed.add(provider.name);
        lines.push({
          text: `provider ${provider.name} failed: ${(error as Error).message}`,
          fix: `check the ${provider.name} provider's setup, then run doctor again`,
        });
      }
    }
    if (holder !== undefined) {
      lines.push({ text: `${name}: held by ${holder}` });
      continue;
    }
    const file = join(stateDir, "secrets.env");
    const set = `set ${name} in ${file} or the environment`;
    lines.push({
      text: `${name}: no provider holds it`,
      fix: providerNames.includes("1password")
        ? `add a 1Password reference under secrets.refs, or ${set}`
        : set,
    });
  }
  return lines;
}

async function fileLines(stateDir: string): Promise<Line[]> {
  const file = join(stateDir, "secrets.env");
  let mode: number;
  try {
    mode = (await stat(file)).mode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [{ text: `${file}: absent` }];
    throw new CommandError(`cannot read ${file}: ${(error as Error).message}`);
  }
  if (process.platform === "win32") return [{ text: `${file}: present` }];
  const octal = (mode & 0o777).toString(8).padStart(4, "0");
  if ((mode & 0o077) === 0) return [{ text: `${file}: present, mode ${octal}` }];
  return [
    { text: `${file}: present, mode ${octal}, readable by others`, fix: `chmod 600 ${file}` },
  ];
}

async function identityLines(
  name: string,
  config: { fixture?: string | undefined; auth: Readonly<Record<string, unknown>> } | undefined,
  fixtures: IdentityFixtures,
  identities: Identities,
): Promise<Line[]> {
  if (config === undefined) {
    return [
      {
        text: `${name}: not in identities`,
        fix: `add ${name} under identities in ${BRAND.configFile}`,
      },
    ];
  }
  const lines: Line[] = [];
  if (config.fixture !== undefined) {
    const entry = fixtures[config.fixture];
    if (entry === undefined) {
      lines.push({
        text: `${name}: no fixture entry ${config.fixture}`,
        fix: `add ${config.fixture} to ${LOCAL_FIXTURES_FILE}`,
      });
    } else {
      for (const [field, value] of Object.entries(entry))
        lines.push(...fieldLines(name, field, value));
    }
  }
  for (const surface of Object.keys(config.auth)) {
    try {
      lines.push({
        text: `${name}/${surface}: credential ${await identities.credentialState(name, surface)}`,
      });
    } catch (error) {
      lines.push({
        text: `${name}/${surface}: credential state unknown: ${(error as Error).message}`,
        fix: `fix identities.${name}.auth.${surface} in ${BRAND.configFile}`,
      });
    }
  }
  return lines;
}

/** The shape of one fixture field, judged by its name; a field of another kind has no line. */
function fieldLines(identity: string, field: string, value: string): Line[] {
  const at = `${identity}.${field}`;
  if (/phone$/i.test(field)) {
    const country = phoneForm(value, "countryName", "en");
    return country === undefined
      ? [{ text: `${at}: not a phone number`, fix: `write ${at} as +<country code><number>` }]
      : [{ text: `${at}: phone, country ${country}` }];
  }
  if (/email$/i.test(field)) {
    const domain = EMAIL.exec(value)?.[1];
    if (domain === undefined)
      return [{ text: `${at}: not an email address`, fix: `write ${at} as name@example.test` }];
    return isTestEmailDomain(domain)
      ? [{ text: `${at}: email, example domain` }]
      : [
          {
            text: `${at}: email, not on an example domain`,
            fix: `use an example.test address for ${at}`,
          },
        ];
  }
  if (SECRET_FIELD.test(field)) return [{ text: `${at}: ${plural(value.length, "character")}` }];
  return [];
}
