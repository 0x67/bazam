import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { CaseResult } from "../result/index.ts";
import { scanFiles, type ScanValues } from "./evidence-scan.ts";

export type OmitReason = "missing" | "outside the case folder";

export interface AttachmentScreen {
  /** The kinds of value each attachment holds, by `<case-id>/<file>`. */
  withheld: ReadonlyMap<string, readonly string[]>;
  /** Why an attachment a result lists cannot be read, by `<case-id>/<name as written>`. */
  omitted: ReadonlyMap<string, OmitReason>;
}

// the form EvidenceStore.attach writes, and the one the MCP evidence_get asks for
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VALUE_KINDS = ["fixture ", "secret ", "credential "];

/** The attachments a result lists that are not plain file names in its case folder, or are no longer there. */
export async function omittedAttachments(
  runDir: string,
  results: readonly CaseResult[],
): Promise<ReadonlyMap<string, OmitReason>> {
  const omitted = new Map<string, OmitReason>();
  for (const result of results) {
    for (const name of result.attachments) {
      const reason = await omitReason(runDir, result.caseId, name);
      if (reason !== undefined) omitted.set(`${result.caseId}/${name}`, reason);
    }
  }
  return omitted;
}

/** `omittedAttachments`, and for every other attachment the fixture, secret and credential kinds it holds. */
export async function screenAttachments(
  runDir: string,
  results: readonly CaseResult[],
  values: ScanValues,
): Promise<AttachmentScreen> {
  const omitted = await omittedAttachments(runDir, results);
  const withheld = new Map<string, readonly string[]>();
  for (const result of results) {
    for (const name of result.attachments) {
      const attachment = `${result.caseId}/${name}`;
      if (omitted.has(attachment)) continue;
      const { findings } = await scanFiles(runDir, [attachment], values);
      const kinds = [...new Set(findings.map((finding) => finding.kind))].filter((kind) =>
        VALUE_KINDS.some((prefix) => kind.startsWith(prefix)),
      );
      if (kinds.length > 0) withheld.set(attachment, kinds.toSorted());
    }
  }
  return { withheld, omitted };
}

async function omitReason(
  runDir: string,
  caseId: string,
  name: string,
): Promise<OmitReason | undefined> {
  if (!PLAIN_NAME.test(name)) return "outside the case folder";
  try {
    // lstat, so a link is never followed to a file outside the case folder
    const entry = await lstat(join(runDir, caseId, name));
    if (entry.isSymbolicLink()) return "outside the case folder";

    return entry.isFile() ? undefined : "missing";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}
