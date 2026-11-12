import { describe, expect, it } from "vite-plus/test";
import {
  expandFlows,
  FlowCycle,
  InvalidFlowUse,
  type FlowSpec,
  type Step,
} from "../src/case/index.ts";

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function flowMap(...flows: FlowSpec[]): Map<string, FlowSpec> {
  return new Map(flows.map((flow) => [flow.name, flow]));
}

const login: FlowSpec = {
  name: "login",
  params: ["email"],
  steps: [
    {
      request: {
        method: "POST",
        url: "${env.API_URL}/login",
        json: { email: "${param.email}", raw: "$${param.email}" },
      },
    },
    { note: "signed in as ${param.email}" },
  ],
};

describe("expandFlows", () => {
  it("inlines a flow and fills its parameters, leaving other placeholders and escapes for run time", () => {
    const steps: Step[] = [
      { note: "start" },
      { use: { flow: "login", with: { email: "ops@example.test" } } },
    ];

    expect(expandFlows(steps, flowMap(login))).toEqual([
      { note: "start" },
      {
        request: {
          method: "POST",
          url: "${env.API_URL}/login",
          json: { email: "ops@example.test", raw: "$${param.email}" },
        },
      },
      { note: "signed in as ops@example.test" },
    ]);
  });

  it("passes a flow's parameters on to the flows it uses", () => {
    const onboard: FlowSpec = {
      name: "onboard",
      params: ["user"],
      steps: [{ use: { flow: "login", with: { email: "${param.user}" } } }],
    };

    const expanded = expandFlows(
      [{ use: { flow: "onboard", with: { user: "admin-1@example.test" } } }],
      flowMap(login, onboard),
    );

    expect(expanded[1]).toEqual({ note: "signed in as admin-1@example.test" });
  });

  it("gives the use step's identity to flow steps that name none in the step or its payload", () => {
    const adminCheck = { request: { method: "GET", url: "${env.API_URL}/admin", as: "admin" } };
    const greet: FlowSpec = {
      name: "greet",
      params: [],
      steps: [{ note: "hello" }, { note: "as admin", as: "admin" }, adminCheck],
    };

    expect(expandFlows([{ use: "greet", as: "customer" }], flowMap(greet))).toEqual([
      { note: "hello", as: "customer" },
      { note: "as admin", as: "admin" },
      adminCheck,
    ]);
  });

  it("expands the same flow twice in a row without calling it a cycle", () => {
    const greet: FlowSpec = { name: "greet", params: [], steps: [{ note: "hello" }] };

    expect(expandFlows([{ use: "greet" }, { use: "greet" }], flowMap(greet))).toHaveLength(2);
  });

  it("throws FlowCycle with the path when a flow uses itself", () => {
    const loop: FlowSpec = { name: "loop", params: [], steps: [{ use: "loop" }] };

    const error = thrownBy(() => expandFlows([{ use: "loop" }], flowMap(loop)));

    expect(error).toBeInstanceOf(FlowCycle);
    expect((error as FlowCycle).path).toEqual(["loop", "loop"]);
  });

  it("throws FlowCycle with the full path when flows reach each other indirectly", () => {
    const flows = flowMap(
      { name: "setup", params: [], steps: [{ use: "a" }] },
      { name: "a", params: [], steps: [{ note: "a" }, { use: "b" }] },
      { name: "b", params: [], steps: [{ use: "a" }] },
    );

    const error = thrownBy(() => expandFlows([{ use: "setup" }], flows));

    expect(error).toBeInstanceOf(FlowCycle);
    expect((error as FlowCycle).path).toEqual(["setup", "a", "b", "a"]);
    expect((error as FlowCycle).message).toBe("flow cycle: setup -> a -> b -> a");
  });

  it.each([
    ["an unknown flow", { use: "logout" }, "flow logout: no such flow"],
    ["a missing parameter", { use: "login" }, "flow login: missing parameter email"],
    [
      "an undeclared parameter",
      { use: { flow: "login", with: { email: "a@example.test", pin: 1234 } } },
      "flow login: undeclared parameter pin",
    ],
  ])("throws InvalidFlowUse for %s", (_, step: Step, message) => {
    const error = thrownBy(() => expandFlows([step], flowMap(login)));

    expect(error).toBeInstanceOf(InvalidFlowUse);
    expect((error as InvalidFlowUse).message).toBe(message);
  });

  it("replaces a use step in a challenge trigger and a guided observe with the flow's one step", () => {
    const sendCode: FlowSpec = {
      name: "send-code",
      params: [],
      steps: [{ tap: { id: "send-code" } }],
    };
    const readMe: FlowSpec = {
      name: "read-me",
      params: [],
      steps: [{ api: { request: "GET ${env.API_URL}/me", status: 200 } }],
    };
    const steps: Step[] = [
      {
        challenge: { kind: "otp-email", trigger: { use: "send-code" }, fill: { id: "code" } },
        as: "customer",
      },
      {
        guided: {
          title: "Check the account",
          steps: ["Open the account"],
          observe: { use: "read-me", as: "customer" },
        },
      },
    ];

    expect(expandFlows(steps, flowMap(sendCode, readMe))).toEqual([
      {
        challenge: {
          kind: "otp-email",
          trigger: { tap: { id: "send-code" } },
          fill: { id: "code" },
        },
        as: "customer",
      },
      {
        guided: {
          title: "Check the account",
          steps: ["Open the account"],
          observe: { api: { request: "GET ${env.API_URL}/me", status: 200 }, as: "customer" },
        },
      },
    ]);
  });

  it("throws InvalidFlowUse for a use step in a trigger whose flow expands to more than one step", () => {
    const steps: Step[] = [
      {
        challenge: {
          kind: "otp-email",
          trigger: { use: { flow: "login", with: { email: "a@example.test" } } },
        },
        as: "customer",
      },
    ];

    expect(() => expandFlows(steps, flowMap(login))).toThrow(
      "flow login: a challenge trigger runs one step, and the flow expands to 2",
    );
  });

  it("throws FlowCycle when a flow reaches itself through a challenge trigger", () => {
    const retry: FlowSpec = {
      name: "retry",
      params: [],
      steps: [{ challenge: { kind: "otp-email", trigger: { use: "retry" } } }],
    };

    const error = thrownBy(() => expandFlows([{ use: "retry" }], flowMap(retry)));

    expect(error).toBeInstanceOf(FlowCycle);
    expect((error as FlowCycle).path).toEqual(["retry", "retry"]);
  });

  it("throws InvalidFlowUse when a flow step names a parameter the flow does not declare", () => {
    const typo: FlowSpec = { name: "typo", params: ["email"], steps: [{ note: "${param.emial}" }] };

    expect(() =>
      expandFlows([{ use: { flow: "typo", with: { email: "a@example.test" } } }], flowMap(typo)),
    ).toThrow("flow typo: ${param.emial} names an undeclared parameter");
  });

  it("gives the flow steps the level and callout of the use step unless they set their own", () => {
    const flow: FlowSpec = {
      name: "marked",
      params: [],
      steps: [{ note: "a" }, { note: "b", level: "own" }, { note: "c", callout: false }],
    };
    const one: FlowSpec = { name: "one", params: [], steps: [{ note: "n" }] };
    const nested: Step = {
      challenge: { kind: "otp-email", trigger: { use: "one", level: "core" }, fill: { id: "c" } },
    };
    const use: Step = { use: "marked", level: "core", callout: true };

    expect(expandFlows([use], flowMap(flow))).toEqual([
      { note: "a", level: "core", callout: true },
      { note: "b", level: "own", callout: true },
      { note: "c", level: "core", callout: false },
    ]);
    expect(expandFlows([{ use: "one", level: "core" }], flowMap(one))).toEqual([
      { note: "n", level: "core" },
    ]);
    expect(expandFlows([nested], flowMap(one))).toMatchObject([
      { challenge: { trigger: { note: "n", level: "core" } } },
    ]);
  });
});
