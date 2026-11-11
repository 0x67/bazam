import type { TrackerConfig } from "../project.ts";
import type { Redactor } from "../redact/index.ts";
import type { RenderedComment } from "./post-plan.ts";

/** `assignee` and `reporter` are account ids. */
export interface TicketState {
  key: string;
  status: string;
  done: boolean;
  assignee?: string;
  reporter?: string;
}

export interface Mention {
  role: string;
  accountId: string;
}

export interface AttachmentFile {
  name: string;
  /** Absolute, inside the run directory. */
  path: string;
}

export interface PostedComment {
  url: string;
}

export interface BugDraft {
  project: string;
  issueType: string;
  summary: string;
  labels: string[];
  description: RenderedComment;
  attachments: AttachmentFile[];
  /** Ticket keys. */
  relatesTo: string[];
}

/** What a tracker client does once connected; credentials stay inside it. */
export interface TrackerConnection {
  ticket(key: string): Promise<TicketState>;
  attach(key: string, files: readonly AttachmentFile[]): Promise<void>;
  postComment(
    key: string,
    comment: RenderedComment,
    mentions: readonly Mention[],
  ): Promise<PostedComment>;
  /** Undefined when `url` names no comment this client can edit, or the comment is gone. */
  editComment(
    key: string,
    url: string,
    comment: RenderedComment,
    mentions: readonly Mention[],
  ): Promise<PostedComment | undefined>;
  transition(key: string, name: string): Promise<void>;
  /** The key of the newest open issue with the label. */
  findOpenBug(project: string, label: string): Promise<string | undefined>;
  /** `problems` names each step after the create that failed, such as an upload or a link; the bug exists either way. */
  createBug(draft: BugDraft): Promise<{ key: string; url: string; problems?: string[] }>;
}

export interface TrackerClientContext {
  /** `trackers.<tracker>` of the project config. */
  config: TrackerConfig;
  /** Reads a secret through the env's providers and registers it with the redactor. */
  secret(name: string): Promise<string>;
  redactor: Redactor;
  signal: AbortSignal;
  log(line: string): void;
}

export interface TrackerClient {
  tracker: string;
  connect(ctx: TrackerClientContext): Promise<TrackerConnection>;
}
