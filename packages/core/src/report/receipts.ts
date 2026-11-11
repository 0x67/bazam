import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { PostPlanItem } from "./post-plan.ts";

const RECEIPTS_FILE = "receipts.json";

/** The comment posted for a post plan item, recorded by `report post`, `report ack` or the MCP `report_ack` tool. */
export interface Receipt {
  marker: string;
  url: string;
  postedAt: string;
}

export interface Receipts {
  latest(tracker: string, ticket: string, caseId: string): Receipt | undefined;
}

// keyed by `<tracker>:<ticket>:<case-id>`
const ReceiptsFile = z.record(
  z.string(),
  z.strictObject({
    marker: z.string().min(1),
    url: z.string().min(1),
    postedAt: z.string().min(1),
  }),
);
type ReceiptsFile = z.infer<typeof ReceiptsFile>;

/** Reads `<stateDir>/receipts.json`; a missing file holds no receipts. */
export async function loadReceipts(stateDir: string): Promise<Receipts> {
  const receipts = new Map(Object.entries(await readReceipts(stateDir)));
  return { latest: (tracker, ticket, caseId) => receipts.get(receiptKey(tracker, ticket, caseId)) };
}

/** Records the comment posted for `item`, replacing the receipt of an earlier run of the same case on the same ticket. */
export async function recordReceipt(
  stateDir: string,
  item: Pick<PostPlanItem, "marker" | "ticket" | "caseId">,
  url: string,
  now: Date,
): Promise<void> {
  const receipts = await readReceipts(stateDir);
  receipts[receiptKey(item.ticket.tracker, item.ticket.key, item.caseId)] = {
    marker: item.marker,
    url,
    postedAt: now.toISOString(),
  };
  const file = join(stateDir, RECEIPTS_FILE);
  // a unique temp name keeps two writers from renaming each other's half-written file
  const temp = `${file}.${randomUUID()}.tmp`;
  await mkdir(stateDir, { recursive: true });
  await writeFile(temp, `${JSON.stringify(receipts, null, 2)}\n`);
  await rename(temp, file);
}

async function readReceipts(stateDir: string): Promise<ReceiptsFile> {
  let text: string;
  try {
    text = await readFile(join(stateDir, RECEIPTS_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed = ReceiptsFile.safeParse(parseJson(text));
  if (!parsed.success)
    throw new Error(
      `${RECEIPTS_FILE} does not match the receipts schema:\n${z.prettifyError(parsed.error)}`,
    );
  return parsed.data;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${RECEIPTS_FILE} is not valid JSON`, { cause: error });
  }
}

function receiptKey(tracker: string, ticket: string, caseId: string): string {
  return `${tracker}:${ticket}:${caseId}`;
}
