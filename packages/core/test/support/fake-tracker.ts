import type {
  AttachmentFile,
  BugDraft,
  Mention,
  PostedComment,
  RenderedComment,
  TicketState,
  TrackerClient,
  TrackerClientContext,
  TrackerConnection,
} from "../../src/report/index.ts";

/**
 * A ticket the fake tracker holds; `done` is false when left out. `ticket()` answers with `key`, so a ticket stored
 * under another key acts as an issue moved to a new key.
 */
export interface FakeTicket {
  key: string;
  status: string;
  done?: boolean;
  assignee?: string;
  reporter?: string;
  /** The transition names the ticket offers; every name when left out. */
  transitions?: string[];
  labels?: string[];
}

export interface FakeComment {
  url: string;
  comment: RenderedComment;
  mentions: Mention[];
}

/** One call the connection received. */
export type FakeTrackerCall =
  | { method: "ticket"; key: string }
  | { method: "attach"; key: string; files: AttachmentFile[] }
  | { method: "postComment"; key: string; comment: RenderedComment; mentions: Mention[] }
  | {
      method: "editComment";
      key: string;
      url: string;
      comment: RenderedComment;
      mentions: Mention[];
    }
  | { method: "transition"; key: string; name: string }
  | { method: "findOpenBug"; project: string; label: string }
  | { method: "createBug"; draft: BugDraft };

type Method = FakeTrackerCall["method"];

/**
 * A tracker connection that keeps tickets, comments and bugs in memory and records every call in order.
 * A key it does not hold, or a transition the ticket does not offer, throws as a tracker would refuse it.
 */
export class FakeTrackerConnection implements TrackerConnection {
  readonly tickets = new Map<string, FakeTicket>();
  readonly comments = new Map<string, FakeComment[]>();
  readonly attachments = new Map<string, AttachmentFile[]>();
  readonly bugs = new Map<string, BugDraft>();
  readonly calls: FakeTrackerCall[] = [];
  /** The message a method throws after it records its call, as when the tracker answers with an error. */
  readonly failures: Partial<Record<Method, string>> = {};
  /** What `createBug` reports as failed after it files the bug, as when an upload or a link is refused. */
  readonly bugProblems: string[] = [];
  #lastComment = 10_000;
  #lastIssue = 900;

  constructor(tickets: readonly FakeTicket[] = []) {
    for (const ticket of tickets) this.tickets.set(ticket.key, ticket);
  }

  /** The methods called so far, in order. */
  methods(): Method[] {
    return this.calls.map((call) => call.method);
  }

  async ticket(key: string): Promise<TicketState> {
    this.#record({ method: "ticket", key });
    const ticket = this.#held(key);
    return {
      key: ticket.key,
      status: ticket.status,
      done: ticket.done ?? false,
      ...(ticket.assignee === undefined ? {} : { assignee: ticket.assignee }),
      ...(ticket.reporter === undefined ? {} : { reporter: ticket.reporter }),
    };
  }

  async attach(key: string, files: readonly AttachmentFile[]): Promise<void> {
    this.#record({ method: "attach", key, files: [...files] });
    this.#held(key);
    this.attachments.set(key, [...(this.attachments.get(key) ?? []), ...files]);
  }

  async postComment(
    key: string,
    comment: RenderedComment,
    mentions: readonly Mention[],
  ): Promise<PostedComment> {
    this.#record({ method: "postComment", key, comment, mentions: [...mentions] });
    this.#held(key);
    this.#lastComment += 1;
    const url = `https://tracker.example.test/browse/${key}?focusedCommentId=${this.#lastComment}`;
    this.comments.set(key, [
      ...(this.comments.get(key) ?? []),
      { url, comment, mentions: [...mentions] },
    ]);
    return { url };
  }

  async editComment(
    key: string,
    url: string,
    comment: RenderedComment,
    mentions: readonly Mention[],
  ): Promise<PostedComment | undefined> {
    this.#record({ method: "editComment", key, url, comment, mentions: [...mentions] });
    this.#held(key);
    const comments = this.comments.get(key) ?? [];
    const index = comments.findIndex((existing) => existing.url === url);
    if (index === -1) return undefined;
    comments[index] = { url, comment, mentions: [...mentions] };
    return { url };
  }

  async transition(key: string, name: string): Promise<void> {
    this.#record({ method: "transition", key, name });
    const ticket = this.#held(key);
    const offered = ticket.transitions;
    if (
      offered !== undefined &&
      !offered.some((offer) => offer.toLowerCase() === name.toLowerCase())
    )
      throw new Error(
        `transition ${name} is not available on ${key}; it offers ${offered.join(", ")}`,
      );
    ticket.status = name;
  }

  async findOpenBug(project: string, label: string): Promise<string | undefined> {
    this.#record({ method: "findOpenBug", project, label });
    // newest first, as the tracker's search orders them
    return [...this.tickets.values()]
      .reverse()
      .find(
        (ticket) =>
          ticket.key.startsWith(`${project}-`) &&
          ticket.done !== true &&
          ticket.labels?.includes(label),
      )?.key;
  }

  async createBug(draft: BugDraft): Promise<{ key: string; url: string; problems?: string[] }> {
    this.#record({ method: "createBug", draft });
    this.#lastIssue += 1;
    const key = `${draft.project}-${this.#lastIssue}`;
    this.tickets.set(key, { key, status: "Open", labels: [...draft.labels] });
    this.bugs.set(key, draft);
    const url = `https://tracker.example.test/browse/${key}`;
    return this.bugProblems.length === 0
      ? { key, url }
      : { key, url, problems: [...this.bugProblems] };
  }

  #record(call: FakeTrackerCall): void {
    this.calls.push(call);
    const failure = this.failures[call.method];
    if (failure !== undefined) throw new Error(failure);
  }

  #held(key: string): FakeTicket {
    const ticket = this.tickets.get(key);
    if (ticket === undefined) throw new Error(`${key} does not exist`);
    return ticket;
  }
}

export interface FakeTrackerClient extends TrackerClient {
  /** The context of each connect, in order. */
  contexts: TrackerClientContext[];
}

/** A client whose `connect` hands out `connection`, or rejects with `connectError` when one is given. */
export function fakeTrackerClient(
  connection: TrackerConnection,
  options: { tracker?: string; connectError?: Error } = {},
): FakeTrackerClient {
  const contexts: TrackerClientContext[] = [];
  return {
    tracker: options.tracker ?? "jira",
    contexts,
    connect: async (ctx) => {
      contexts.push(ctx);
      if (options.connectError !== undefined) throw options.connectError;
      return connection;
    },
  };
}
