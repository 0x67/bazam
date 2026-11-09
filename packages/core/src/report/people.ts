import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const PEOPLE_FILE = "people.yaml";
// each ticket names its own assignee and reporter, so people.yaml cannot map these roles
const TICKET_ROLES: readonly string[] = ["assignee", "reporter"];

/** `people.yaml`: tracker account ids by role and tracker. */
export const PeopleFile = z.strictObject({
  roles: z
    .record(z.string().regex(/^[a-z][a-z0-9-]*$/), z.record(z.string().min(1), z.string().min(1)))
    .refine((roles) => !TICKET_ROLES.some((role) => Object.hasOwn(roles, role)), {
      error: "assignee and reporter come from the ticket; remove them from roles in people.yaml",
    })
    .default({}),
});
export type PeopleFile = z.infer<typeof PeopleFile>;

export class PeopleRegistry {
  readonly #roles: ReadonlyMap<string, ReadonlyMap<string, string>>;

  constructor(roles: PeopleFile["roles"]) {
    this.#roles = new Map(Object.entries(roles).map(([role, accounts]) => [role, new Map(Object.entries(accounts))]));
  }

  /** Reads `people.yaml`. A project without the file maps no role. */
  static async load(root: string): Promise<PeopleRegistry> {
    let text: string;
    try {
      text = await readFile(join(root, PEOPLE_FILE), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new PeopleRegistry({});
      throw error;
    }
    // a file with only comments parses to null
    const parsed = PeopleFile.safeParse(parse(text) ?? {});
    if (!parsed.success)
      throw new Error(`${PEOPLE_FILE} does not match the people schema:\n${z.prettifyError(parsed.error)}`);
    return new PeopleRegistry(parsed.data.roles);
  }

  /** Undefined for assignee and reporter, whatever roles the registry was built with. */
  accountId(role: string, tracker: string): string | undefined {
    return TICKET_ROLES.includes(role) ? undefined : this.#roles.get(role)?.get(tracker);
  }
}
