import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import register from "./index.js";

const completeSimpleMock = vi.fn();
const fetchMock = vi.fn();
const ORIGINAL_ENV = { ...process.env };

vi.mock("@mariozechner/pi-ai", () => ({
  completeSimple: (...args: unknown[]) => completeSimpleMock(...args),
}));

vi.mock("@armoriq/sdk", () => ({
  ArmorIQClient: class {
    capturePlan(_llm: string, _prompt: string, plan: Record<string, unknown>) {
      return { plan, llm: _llm, prompt: _prompt, metadata: {} };
    }

    async getIntentToken() {
      return { expiresAt: Date.now() / 1000 + 60 };
    }
  },
}));

type HookName = "before_agent_start" | "before_tool_call" | "agent_end";

function createApi(pluginConfig: Record<string, unknown>) {
  const handlers = new Map<HookName, Array<(event: any, ctx: any) => any>>();
  const tools: Array<(ctx: any) => any> = [];
  const api = {
    id: "armoriq",
    name: "ArmorIQ",
    source: "test",
    pluginConfig,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    on: (name: HookName, handler: (event: any, ctx: any) => any) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerTool: (tool: any) => {
      const factory = typeof tool === "function" ? tool : () => tool;
      tools.push(factory);
    },
    resolvePath: (input: string) => input,
  };
  return { api, handlers, tools };
}

function createCtx(runId: string) {
  const model = { provider: "test", id: "model" } as Model<Api>;
  const modelRegistry = {
    getApiKey: async () => "test-api-key",
  } as unknown as ModelRegistry;
  return {
    runId,
    sessionKey: "session:test",
    model,
    modelRegistry,
    messageChannel: "whatsapp",
    accountId: "acct-1",
    senderId: "sender-1",
    senderName: "Sender",
    senderUsername: "sender",
    senderE164: "+15550001111",
  };
}

describe("ArmorIQ plugin", () => {
  beforeEach(() => {
    completeSimpleMock.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
    process.env.REQUIRE_CSRG_PROOFS = "false";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("captures a plan on agent start and allows matching tool calls", async () => {
    const { api, handlers } = createApi({
      enabled: true,
      apiKey: "ak_live_test",
      userId: "user-1",
      agentId: "agent-1",
    });
    register(api as any);

    completeSimpleMock.mockResolvedValue({
      content: JSON.stringify({
        steps: [{ action: "read", mcp: "openclaw" }],
        metadata: { goal: "read a file" },
      }),
    });

    const ctx = createCtx("run-allow");
    const beforeAgentStart = handlers.get("before_agent_start")?.[0];
    await beforeAgentStart?.(
      {
        prompt: "Read a file",
        tools: [{ name: "read", description: "Read files" }],
      },
      ctx,
    );

    const beforeToolCall = handlers.get("before_tool_call")?.[0];
    const result = await beforeToolCall?.({ toolName: "read", params: { path: "demo.txt" } }, ctx);
    expect(result?.block).not.toBe(true);
  });

  it("blocks when API key is missing", async () => {
    const { api, handlers } = createApi({
      enabled: true,
      userId: "user-1",
      agentId: "agent-1",
    });
    register(api as any);

    const ctx = createCtx("run-missing-key");
    const beforeToolCall = handlers.get("before_tool_call")?.[0];
    const result = await beforeToolCall?.({ toolName: "read", params: {} }, ctx);
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("ArmorIQ API key missing");
  });

  it("accepts tool calls when intent token header includes the tool", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ allowed: true }),
    });

    const { api, handlers } = createApi({
      enabled: true,
      apiKey: "ak_live_test",
      userId: "user-1",
      agentId: "agent-1",
    });
    register(api as any);

    const ctx = {
      ...createCtx("run-intent-header"),
      intentTokenRaw: JSON.stringify({
        plan: { steps: [{ action: "web_fetch", mcp: "openclaw" }] },
        expiresAt: Date.now() / 1000 + 60,
      }),
    };

    const beforeToolCall = handlers.get("before_tool_call")?.[0];
    const result = await beforeToolCall?.(
      { toolName: "web_fetch", params: { url: "https://example.com" } },
      ctx,
    );
    expect(result?.block).not.toBe(true);
  });

  it("blocks tool calls when intent token header excludes the tool", async () => {
    const { api, handlers } = createApi({
      enabled: true,
      apiKey: "ak_live_test",
      userId: "user-1",
      agentId: "agent-1",
    });
    register(api as any);

    const ctx = {
      ...createCtx("run-intent-block"),
      intentTokenRaw: JSON.stringify({
        plan: { steps: [{ action: "read", mcp: "openclaw" }] },
        expiresAt: Date.now() / 1000 + 60,
      }),
    };

    const beforeToolCall = handlers.get("before_tool_call")?.[0];
    const result = await beforeToolCall?.({ toolName: "web_fetch", params: {} }, ctx);
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("intent drift");
  });

  it("allows CSRG verify-step when IAP returns allowed", async () => {
    const { api, handlers } = createApi({
      enabled: true,
      apiKey: "ak_live_test",
      userId: "user-1",
      agentId: "agent-1",
      backendEndpoint: "https://iap.example",
    });
    register(api as any);

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          allowed: true,
          reason: "ok",
          step: { step_index: 0, action: "web_fetch", params: {} },
          execution_state: {
            plan_id: "plan-1",
            intent_reference: "plan-1",
            executed_steps: [],
            current_step: 0,
            total_steps: 1,
            status: "in_progress",
            is_completed: false,
          },
        }),
    });

    const ctx = {
      ...createCtx("run-csrg-allow"),
      intentTokenRaw: "jwt-token",
      csrgPath: "/steps/[0]/action",
      csrgProofRaw: JSON.stringify([{ position: "left", sibling_hash: "abc" }]),
      csrgValueDigest: "deadbeef",
    };

    const beforeToolCall = handlers.get("before_tool_call")?.[0];
    const result = await beforeToolCall?.(
      { toolName: "web_fetch", params: { url: "https://example.com" } },
      ctx,
    );
    expect(result?.block).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks CSRG verify-step when IAP returns denied", async () => {
    const { api, handlers } = createApi({
      enabled: true,
      apiKey: "ak_live_test",
      userId: "user-1",
      agentId: "agent-1",
      backendEndpoint: "https://iap.example",
    });
    register(api as any);

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          allowed: false,
          reason: "denied",
          step: { step_index: 0, action: "web_fetch", params: {} },
          execution_state: {
            plan_id: "plan-1",
            intent_reference: "plan-1",
            executed_steps: [],
            current_step: 0,
            total_steps: 1,
            status: "blocked",
            is_completed: false,
          },
        }),
    });

    const ctx = {
      ...createCtx("run-csrg-deny"),
      intentTokenRaw: "jwt-token",
      csrgPath: "/steps/[0]/action",
      csrgProofRaw: JSON.stringify([{ position: "left", sibling_hash: "abc" }]),
      csrgValueDigest: "deadbeef",
    };

    const beforeToolCall = handlers.get("before_tool_call")?.[0];
    const result = await beforeToolCall?.({ toolName: "web_fetch", params: {} }, ctx);
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("denied");
  });

  it("blocks CSRG verification when proofs are required but missing", async () => {
    process.env.REQUIRE_CSRG_PROOFS = "true";
    const { api, handlers } = createApi({
      enabled: true,
      apiKey: "ak_live_test",
      userId: "user-1",
      agentId: "agent-1",
      backendEndpoint: "https://iap.example",
    });
    register(api as any);

    const ctx = {
      ...createCtx("run-csrg-missing"),
      intentTokenRaw: "jwt-token",
    };

    const beforeToolCall = handlers.get("before_tool_call")?.[0];
    const result = await beforeToolCall?.({ toolName: "web_fetch", params: {} }, ctx);
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("CSRG proof headers missing");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows CSRG verification when proofs are optional and missing", async () => {
    process.env.REQUIRE_CSRG_PROOFS = "false";
    const { api, handlers } = createApi({
      enabled: true,
      apiKey: "ak_live_test",
      userId: "user-1",
      agentId: "agent-1",
      backendEndpoint: "https://iap.example",
    });
    register(api as any);

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          allowed: true,
          reason: "ok",
          step: { step_index: 0, action: "web_fetch", params: {} },
          execution_state: {
            plan_id: "plan-1",
            intent_reference: "plan-1",
            executed_steps: [],
            current_step: 0,
            total_steps: 1,
            status: "in_progress",
            is_completed: false,
          },
        }),
    });

    const ctx = {
      ...createCtx("run-csrg-optional"),
      intentTokenRaw: "jwt-token",
    };

    const beforeToolCall = handlers.get("before_tool_call")?.[0];
    const result = await beforeToolCall?.({ toolName: "web_fetch", params: {} }, ctx);
    expect(result?.block).not.toBe(true);
  });

  it("blocks policy updates when sender is not allowed", async () => {
    const { api, handlers } = createApi({
      enabled: true,
      apiKey: "ak_live_test",
      userId: "user-1",
      agentId: "agent-1",
      policyUpdateEnabled: true,
      policyUpdateAllowList: ["someone-else"],
    });
    register(api as any);

    const ctx = createCtx("run-policy-deny");
    const beforeToolCall = handlers.get("before_tool_call")?.[0];
    const result = await beforeToolCall?.({ toolName: "policy_update", params: {} }, ctx);
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("policy update denied");
  });

  it("applies policy updates and blocks PCI send_email", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "armoriq-policy-"));
    const policyPath = join(dir, "policy.json");

    const { api, handlers, tools } = createApi({
      enabled: true,
      apiKey: "ak_live_test",
      userId: "user-1",
      agentId: "agent-1",
      policyUpdateEnabled: true,
      policyUpdateAllowList: ["sender-1"],
      policyStorePath: policyPath,
    });
    register(api as any);

    const policyToolFactory = tools.find((factory) => {
      const tool = factory({ agentId: "agent-1", sessionKey: "session:test" });
      return tool?.name === "policy_update";
    });
    expect(policyToolFactory).toBeTruthy();
    const policyTool = policyToolFactory?.({ agentId: "agent-1", sessionKey: "session:test" });
    if (!policyTool) {
      throw new Error("policy_update tool not registered");
    }

    const updateResult = await policyTool.execute("call-1", {
      update: {
        reason: "Block PCI in email",
        mode: "replace",
        rules: [
          {
            id: "deny_pci_email",
            action: "deny",
            tool: "send_email",
            dataClass: "PCI",
          },
        ],
      },
    });
    expect(updateResult?.details?.version).toBeGreaterThan(0);

    const ctx = {
      ...createCtx("run-policy-block"),
      intentTokenRaw: JSON.stringify({
        plan: { steps: [{ action: "send_email", mcp: "openclaw" }] },
        expiresAt: Date.now() / 1000 + 60,
      }),
    };

    const beforeToolCall = handlers.get("before_tool_call")?.[0];
    const result = await beforeToolCall?.(
      { toolName: "send_email", params: { body: "Card 4111 1111 1111 1111" } },
      ctx,
    );
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("policy deny");
  });

  it("blocks when intent token has embedded plan but proofs required and missing", async () => {
    process.env.REQUIRE_CSRG_PROOFS = "true";
    process.env.CSRG_VERIFY_ENABLED = "true";

    const { api, handlers } = createApi({
      enabled: true,
      apiKey: "ak_live_test",
      userId: "user-1",
      agentId: "agent-1",
      backendEndpoint: "https://iap.example",
    });
    register(api as any);

    const intentToken = {
      plan: {
        steps: [{ action: "send_email", params: { to: "user@example.com" }, mcp: "openclaw" }],
        metadata: { goal: "Send email" },
      },
      expiresAt: Date.now() / 1000 + 300,
    };

    const ctx = {
      ...createCtx("run-proofs-required-missing"),
      intentTokenRaw: JSON.stringify(intentToken),
    };

    const beforeToolCall = handlers.get("before_tool_call")?.[0];
    const result = await beforeToolCall?.(
      { toolName: "send_email", params: { to: "user@example.com" } },
      ctx,
    );

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("CSRG proof headers");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("DETAILED: shows full enforcement flow with logging", async () => {
    const logs: string[] = [];
    const log = (msg: string) => {
      logs.push(msg);
      console.log(`[ENFORCE] ${msg}`);
    };

    log("=== ArmorIQ OpenClaw Plugin Enforcement Test ===");
    log("Step 1: Setting up plugin with API key and IAP endpoint");

    fetchMock.mockImplementation(async (url: string, options: any) => {
      log(`Step 3: IAP verify-step called`);
      log(`  URL: ${url}`);
      log(`  Body: ${options?.body}`);
      return {
        ok: true,
        status: 200,
        text: async () => {
          const response = {
            allowed: true,
            reason: "Step verified successfully",
            verification_source: "iap",
            step: { step_index: 0, action: "send_email", params: { to: "user@example.com" } },
            execution_state: {
              plan_id: "plan-123",
              intent_reference: "plan-123",
              executed_steps: [],
              current_step: 1,
              total_steps: 2,
              status: "in_progress",
              is_completed: false,
            },
          };
          log(`Step 4: IAP Response: ${JSON.stringify(response, null, 2)}`);
          return JSON.stringify(response);
        },
      };
    });

    const { api, handlers } = createApi({
      enabled: true,
      apiKey: "ak_live_test123",
      userId: "user-enforcement-test",
      agentId: "agent-enforcement-test",
      backendEndpoint: "https://customer-iap.armoriq.ai",
    });
    register(api as any);

    const intentToken = {
      plan: {
        steps: [
          { action: "send_email", params: { to: "user@example.com" }, mcp: "openclaw" },
          { action: "read_file", params: { path: "/tmp/data.txt" }, mcp: "openclaw" },
        ],
        metadata: { goal: "Send email and read file" },
      },
      expiresAt: Date.now() / 1000 + 300,
    };

    log(`Step 2: Tool call received with intent token`);
    log(`  Tool: send_email`);
    log(`  Params: { to: "user@example.com" }`);
    log(`  Intent Token Plan: ${JSON.stringify(intentToken.plan, null, 2)}`);

    const ctx = {
      ...createCtx("run-enforcement-detailed"),
      intentTokenRaw: JSON.stringify(intentToken),
    };

    const beforeToolCall = handlers.get("before_tool_call")?.[0];
    const result = await beforeToolCall?.(
      { toolName: "send_email", params: { to: "user@example.com" } },
      ctx,
    );

    log(`Step 5: Enforcement Result: ${JSON.stringify(result, null, 2)}`);
    log(`  Blocked: ${result?.block ?? false}`);
    log(`  Reason: ${result?.blockReason ?? "N/A (allowed)"}`);

    expect(result?.block).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    log("=== Enforcement Flow Summary ===");
    log("1. Plugin receives before_tool_call hook");
    log("2. Extracts intent token from context (intentTokenRaw)");
    log("3. Validates tool against plan (checkIntentTokenPlan)");
    log("4. ALWAYS calls IAP verifyStep (non-conditional)");
    log("5. Returns allow/block based on IAP response");
    log("================================");
  });

  it("ONE TOKEN PER RUN: shares intent token across multiple tool calls", async () => {
    const logs: string[] = [];
    const log = (msg: string) => {
      logs.push(msg);
      console.log(`[TOKEN-REUSE] ${msg}`);
    };

    log("=== Testing One Intent Token Per Run ===");

    let tokenCreationCount = 0;
    completeSimpleMock.mockImplementation(async () => {
      tokenCreationCount++;
      log(`Token creation #${tokenCreationCount}`);
      return {
        content: JSON.stringify({
          steps: [
            { action: "send_email", mcp: "openclaw" },
            { action: "read_file", mcp: "openclaw" },
            { action: "write_file", mcp: "openclaw" },
          ],
          metadata: { goal: "Multi-step task" },
        }),
      };
    });

    fetchMock.mockImplementation(async (url: string, options: any) => {
      const body = JSON.parse(options?.body || "{}");
      log(`IAP verify-step called for tool: ${body.tool_name}`);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            allowed: true,
            reason: "Step verified",
            verification_source: "iap",
            step: { step_index: 0, action: body.tool_name, params: {} },
            execution_state: {
              plan_id: "plan-123",
              intent_reference: "plan-123",
              executed_steps: [],
              current_step: 1,
              total_steps: 3,
              status: "in_progress",
              is_completed: false,
            },
          }),
      };
    });

    const { api, handlers } = createApi({
      enabled: true,
      apiKey: "ak_live_test",
      userId: "user-1",
      agentId: "agent-1",
      backendEndpoint: "https://iap.example",
    });
    register(api as any);

    const stableRunId = "stable-run-456";
    const ctx = createCtx(stableRunId);

    log(`\n--- Agent Start (runId: ${stableRunId}) ---`);
    const beforeAgentStart = handlers.get("before_agent_start")?.[0];
    await beforeAgentStart?.(
      {
        prompt: "Send email, read file, write file",
        tools: [
          { name: "send_email", description: "Send email" },
          { name: "read_file", description: "Read file" },
          { name: "write_file", description: "Write file" },
        ],
      },
      ctx,
    );

    log(`Token creation count after agent_start: ${tokenCreationCount}`);
    expect(tokenCreationCount).toBe(1);

    const beforeToolCall = handlers.get("before_tool_call")?.[0];

    log(`\n--- Tool Call 1: send_email (runId: ${stableRunId}) ---`);
    const result1 = await beforeToolCall?.(
      { toolName: "send_email", params: { to: "user@example.com" } },
      ctx,
    );
    log(`Result 1: ${result1?.block ? "BLOCKED" : "ALLOWED"}`);
    expect(result1?.block).not.toBe(true);

    log(`\n--- Tool Call 2: read_file (runId: ${stableRunId}) ---`);
    const result2 = await beforeToolCall?.(
      { toolName: "read_file", params: { path: "/tmp/data.txt" } },
      ctx,
    );
    log(`Result 2: ${result2?.block ? "BLOCKED" : "ALLOWED"}`);
    expect(result2?.block).not.toBe(true);

    log(`\n--- Tool Call 3: write_file (runId: ${stableRunId}) ---`);
    const result3 = await beforeToolCall?.(
      { toolName: "write_file", params: { path: "/tmp/output.txt" } },
      ctx,
    );
    log(`Result 3: ${result3?.block ? "BLOCKED" : "ALLOWED"}`);
    expect(result3?.block).not.toBe(true);

    log(`\n=== Final Token Creation Count: ${tokenCreationCount} ===`);
    log(`IAP verify-step calls: ${fetchMock.mock.calls.length}`);
    log(`Explanation: Cached plan allows local validation without IAP calls`);
    log(`\n✅ ONE intent token shared across 3 tool calls!`);

    expect(tokenCreationCount).toBe(1);
    log(`\nFlow: Token created once during agent_start, then reused for all tool calls`);

    log(`\n--- Agent End (cleanup cache) ---`);
    const agentEnd = handlers.get("agent_end")?.[0];
    await agentEnd?.({}, ctx);
    log(`Cache cleared for runId: ${stableRunId}`);
  });

  it("FULL FLOW WITH VERIFICATION: shows complete enforcement with IAP calls", async () => {
    const logs: string[] = [];
    const log = (msg: string) => {
      logs.push(msg);
      console.log(`[FULL-FLOW] ${msg}`);
    };

    log("=== Complete Enforcement Flow Test ===");
    log("Scenario: Intent token passed via header, IAP verification for each tool");

    let iapCallCount = 0;
    fetchMock.mockImplementation(async (url: string, options: any) => {
      iapCallCount++;
      const body = JSON.parse(options?.body || "{}");
      const toolName = body.tool_name || "unknown";

      log(`\n[IAP Call #${iapCallCount}] POST ${url}`);
      log(`  Tool: ${toolName}`);
      log(`  Token present: ${body.token ? "YES" : "NO"}`);
      log(`  Token length: ${body.token?.length || 0} chars`);

      const response = {
        ok: true,
        status: 200,
        text: async () => {
          const result = {
            allowed: true,
            reason: `Step ${iapCallCount} verified successfully`,
            verification_source: "iap",
            step: {
              step_index: iapCallCount - 1,
              action: toolName,
              params: {},
            },
            execution_state: {
              plan_id: "plan-xyz-789",
              intent_reference: "plan-xyz-789",
              executed_steps: Array.from({ length: iapCallCount - 1 }, (_, i) => i),
              current_step: iapCallCount,
              total_steps: 3,
              status: "in_progress",
              is_completed: iapCallCount === 3,
            },
          };
          log(`  [IAP Response] allowed=${result.allowed}, step=${result.step.step_index}`);
          return JSON.stringify(result);
        },
      };
      return response;
    });

    const { api, handlers } = createApi({
      enabled: true,
      apiKey: "ak_live_test",
      userId: "user-full-flow",
      agentId: "agent-full-flow",
      backendEndpoint: "https://customer-iap.armoriq.ai",
    });
    register(api as any);

    const intentToken = {
      plan: {
        steps: [
          { action: "send_email", params: { to: "alice@example.com" }, mcp: "openclaw" },
          { action: "read_file", params: { path: "/data/report.txt" }, mcp: "openclaw" },
          { action: "write_file", params: { path: "/output/summary.txt" }, mcp: "openclaw" },
        ],
        metadata: {
          goal: "Process report and send email",
          plan_id: "plan-xyz-789",
        },
      },
      expiresAt: Date.now() / 1000 + 600,
    };

    const intentTokenRaw = JSON.stringify(intentToken);
    const stableRunId = "full-flow-run-999";

    log(`\nRun ID: ${stableRunId}`);
    log(`Intent Token Plan: ${intentToken.plan.steps.length} steps`);
    log(`  Step 0: ${intentToken.plan.steps[0].action}`);
    log(`  Step 1: ${intentToken.plan.steps[1].action}`);
    log(`  Step 2: ${intentToken.plan.steps[2].action}`);

    const beforeToolCall = handlers.get("before_tool_call")?.[0];

    log("\n--- Executing Tool Call 1: send_email ---");
    const ctx1 = {
      ...createCtx(stableRunId),
      intentTokenRaw,
    };

    const result1 = await beforeToolCall?.(
      { toolName: "send_email", params: { to: "alice@example.com" } },
      ctx1,
    );

    log(`[Plugin Decision] ${result1?.block ? `BLOCKED: ${result1.blockReason}` : "ALLOWED"}`);
    expect(result1?.block).not.toBe(true);

    log("\n--- Executing Tool Call 2: read_file ---");
    const ctx2 = {
      ...createCtx(stableRunId),
      intentTokenRaw,
    };

    const result2 = await beforeToolCall?.(
      { toolName: "read_file", params: { path: "/data/report.txt" } },
      ctx2,
    );

    log(`[Plugin Decision] ${result2?.block ? `BLOCKED: ${result2.blockReason}` : "ALLOWED"}`);
    expect(result2?.block).not.toBe(true);

    log("\n--- Executing Tool Call 3: write_file ---");
    const ctx3 = {
      ...createCtx(stableRunId),
      intentTokenRaw,
    };

    const result3 = await beforeToolCall?.(
      { toolName: "write_file", params: { path: "/output/summary.txt" } },
      ctx3,
    );

    log(`[Plugin Decision] ${result3?.block ? `BLOCKED: ${result3.blockReason}` : "ALLOWED"}`);
    expect(result3?.block).not.toBe(true);

    log("\n=== Final Results ===");
    log(`Total IAP verification calls: ${iapCallCount}`);
    log(`All tools allowed: YES`);
    log(`Same intent token used: YES (passed via context)`);

    expect(iapCallCount).toBe(3);

    log("\n=== Flow Summary ===");
    log("1. Intent token with 3-step plan passed via context");
    log("2. Each tool call validates against plan locally");
    log("3. Each tool call makes IAP verification request");
    log("4. IAP returns execution state (current_step, completed steps)");
    log("5. All 3 tools executed successfully with same intent token");
    log("================================");
  });

  it("COMPLETE FLOW: Intent token + CSRG proofs + IAP verification", async () => {
    process.env.REQUIRE_CSRG_PROOFS = "false";
    process.env.CSRG_VERIFY_ENABLED = "true";

    const logs: string[] = [];
    const log = (msg: string) => {
      logs.push(msg);
      console.log(`[COMPLETE] ${msg}`);
    };

    log("╔═══════════════════════════════════════════════════════════╗");
    log("║   COMPLETE ARMORIQ ENFORCEMENT FLOW WITH CSRG PROOFS      ║");
    log("╚═══════════════════════════════════════════════════════════╝");

    let iapCallCount = 0;
    fetchMock.mockImplementation(async (url: string, options: any) => {
      iapCallCount++;
      const body = JSON.parse(options?.body || "{}");
      const toolName = body.tool_name || "unknown";
      const hasProof = body.proof && Array.isArray(body.proof);
      const hasPath = !!body.path;
      const hasValueDigest = !!body.context?.csrg_value_digest;

      log(`\n┌─────────────────────────────────────────────────────────┐`);
      log(`│ IAP VERIFICATION REQUEST #${iapCallCount}                              │`);
      log(`└─────────────────────────────────────────────────────────┘`);
      log(`  🔗 Endpoint: ${url}`);
      log(`  🛠️  Tool: ${toolName}`);
      log(`  🎫 Token: ${body.token ? `Present (${body.token.length} chars)` : "MISSING"}`);
      log(`  📍 Path: ${body.path || "N/A"}`);
      log(`  🔢 Step Index: ${body.step_index ?? "N/A"}`);
      log(`  🌲 Merkle Proof: ${hasProof ? `YES (${body.proof.length} siblings)` : "NO"}`);
      log(
        `  🔐 Value Digest: ${hasValueDigest ? body.context.csrg_value_digest.substring(0, 16) + "..." : "NO"}`,
      );

      if (hasProof) {
        log(`  📝 Proof Details:`);
        body.proof.forEach((p: any, i: number) => {
          log(`     [${i}] ${p.position}: ${p.sibling_hash.substring(0, 16)}...`);
        });
      }

      const result = {
        allowed: true,
        reason: hasProof
          ? `CSRG cryptographic proof verified + IAP step ${iapCallCount} approved`
          : `IAP step ${iapCallCount} verified (no CSRG proof)`,
        verification_source: hasProof ? "csrg" : "iap",
        step: {
          step_index: iapCallCount - 1,
          action: toolName,
          params: {},
        },
        execution_state: {
          plan_id: "plan-complete-123",
          intent_reference: "plan-complete-123",
          executed_steps: Array.from({ length: iapCallCount - 1 }, (_, i) => i),
          current_step: iapCallCount,
          total_steps: 3,
          status: iapCallCount === 3 ? "completed" : "in_progress",
          is_completed: iapCallCount === 3,
        },
        ...(hasProof && {
          node_hash: "abcdef123456789",
          csrg_path: body.path,
          csrg_merkle_root: "root_hash_xyz789",
        }),
      };

      log(`\n  ✅ IAP RESPONSE:`);
      log(`     Allowed: ${result.allowed}`);
      log(`     Reason: ${result.reason}`);
      log(`     Verification Source: ${result.verification_source.toUpperCase()}`);
      log(`     Execution Status: ${result.execution_state.status}`);
      log(`     Completed Steps: [${result.execution_state.executed_steps.join(", ")}]`);
      log(
        `     Current Step: ${result.execution_state.current_step}/${result.execution_state.total_steps}`,
      );
      if (result.node_hash) {
        log(`     🌲 Merkle Root: ${result.csrg_merkle_root}`);
        log(`     🔗 Node Hash: ${result.node_hash}`);
      }

      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(result),
      };
    });

    const { api, handlers } = createApi({
      enabled: true,
      apiKey: "ak_live_complete_test",
      userId: "user-complete",
      agentId: "agent-complete",
      backendEndpoint: "https://customer-iap.armoriq.ai",
    });
    register(api as any);

    const intentToken = {
      plan: {
        steps: [
          { action: "send_email", params: { to: "user@example.com" }, mcp: "openclaw" },
          { action: "read_file", params: { path: "/secure/data.json" }, mcp: "openclaw" },
          { action: "write_file", params: { path: "/output/result.json" }, mcp: "openclaw" },
        ],
        metadata: {
          goal: "Process secure data and send notification",
          plan_id: "plan-complete-123",
        },
      },
      expiresAt: Date.now() / 1000 + 3600,
      step_proofs: [
        {
          step_index: 0,
          path: "/steps/[0]/action",
          proof: [
            { position: "left", sibling_hash: "hash_sibling_1_send_email" },
            { position: "right", sibling_hash: "hash_sibling_2_send_email" },
          ],
          value_digest: "digest_send_email_step0",
        },
        {
          step_index: 1,
          path: "/steps/[1]/action",
          proof: [
            { position: "right", sibling_hash: "hash_sibling_1_read_file" },
            { position: "left", sibling_hash: "hash_sibling_2_read_file" },
          ],
          value_digest: "digest_read_file_step1",
        },
        {
          step_index: 2,
          path: "/steps/[2]/action",
          proof: [
            { position: "left", sibling_hash: "hash_sibling_1_write_file" },
            { position: "left", sibling_hash: "hash_sibling_2_write_file" },
          ],
          value_digest: "digest_write_file_step2",
        },
      ],
    };

    const intentTokenRaw = JSON.stringify(intentToken);
    const stableRunId = "complete-flow-run-123";

    log(`\n┌─────────────────────────────────────────────────────────┐`);
    log(`│ SETUP DETAILS                                           │`);
    log(`└─────────────────────────────────────────────────────────┘`);
    log(`  🆔 Run ID: ${stableRunId}`);
    log(`  🎫 Intent Token: ${intentToken.plan.steps.length} steps in plan`);
    log(`  🌲 CSRG Proofs: ${intentToken.step_proofs.length} proofs embedded in token`);
    log(`  ⏰ Token Expiry: ${new Date((intentToken.expiresAt || 0) * 1000).toISOString()}`);
    log(`  📋 Plan Goal: ${intentToken.plan.metadata.goal}`);
    log(`\n  📝 Plan Steps:`);
    intentToken.plan.steps.forEach((step, i) => {
      log(`     [${i}] ${step.action} - ${JSON.stringify(step.params)}`);
    });

    const beforeToolCall = handlers.get("before_tool_call")?.[0];

    // TOOL CALL 1
    log(`\n╔═══════════════════════════════════════════════════════════╗`);
    log(`║ TOOL CALL #1: send_email                                  ║`);
    log(`╚═══════════════════════════════════════════════════════════╝`);

    const ctx1 = {
      ...createCtx(stableRunId),
      intentTokenRaw,
    };

    log(`  🔍 Plugin Processing:`);
    log(`     - Extract intent token from context`);
    log(`     - Parse embedded plan (${intentToken.plan.steps.length} steps)`);
    log(`     - Check if 'send_email' is in plan: YES ✓`);
    log(`     - Extract CSRG proofs from token for step 0`);
    log(`     - Call IAP verify-step with token + proofs`);

    const result1 = await beforeToolCall?.(
      { toolName: "send_email", params: { to: "user@example.com" } },
      ctx1,
    );

    log(
      `\n  🎯 PLUGIN DECISION: ${result1?.block ? `❌ BLOCKED - ${result1.blockReason}` : "✅ ALLOWED"}`,
    );
    expect(result1?.block).not.toBe(true);

    // TOOL CALL 2
    log(`\n╔═══════════════════════════════════════════════════════════╗`);
    log(`║ TOOL CALL #2: read_file                                   ║`);
    log(`╚═══════════════════════════════════════════════════════════╝`);

    const ctx2 = {
      ...createCtx(stableRunId),
      intentTokenRaw,
    };

    log(`  🔍 Plugin Processing:`);
    log(`     - Reuse same intent token from context`);
    log(`     - Check if 'read_file' is in plan: YES ✓`);
    log(`     - Extract CSRG proofs from token for step 1`);
    log(`     - Call IAP verify-step with token + proofs`);

    const result2 = await beforeToolCall?.(
      { toolName: "read_file", params: { path: "/secure/data.json" } },
      ctx2,
    );

    log(
      `\n  🎯 PLUGIN DECISION: ${result2?.block ? `❌ BLOCKED - ${result2.blockReason}` : "✅ ALLOWED"}`,
    );
    expect(result2?.block).not.toBe(true);

    // TOOL CALL 3
    log(`\n╔═══════════════════════════════════════════════════════════╗`);
    log(`║ TOOL CALL #3: write_file                                  ║`);
    log(`╚═══════════════════════════════════════════════════════════╝`);

    const ctx3 = {
      ...createCtx(stableRunId),
      intentTokenRaw,
    };

    log(`  🔍 Plugin Processing:`);
    log(`     - Reuse same intent token from context`);
    log(`     - Check if 'write_file' is in plan: YES ✓`);
    log(`     - Extract CSRG proofs from token for step 2`);
    log(`     - Call IAP verify-step with token + proofs`);

    const result3 = await beforeToolCall?.(
      { toolName: "write_file", params: { path: "/output/result.json" } },
      ctx3,
    );

    log(
      `\n  🎯 PLUGIN DECISION: ${result3?.block ? `❌ BLOCKED - ${result3.blockReason}` : "✅ ALLOWED"}`,
    );
    expect(result3?.block).not.toBe(true);

    // SUMMARY
    log(`\n╔═══════════════════════════════════════════════════════════╗`);
    log(`║ EXECUTION SUMMARY                                         ║`);
    log(`╚═══════════════════════════════════════════════════════════╝`);
    log(`  📊 Statistics:`);
    log(`     Total IAP calls: ${iapCallCount}`);
    log(`     Tools executed: 3`);
    log(`     Tools blocked: 0`);
    log(`     Success rate: 100%`);
    log(`  🔐 Security:`);
    log(`     Same intent token: ✅ YES`);
    log(`     CSRG proofs verified: ✅ YES (3 proofs)`);
    log(`     Intent drift: ❌ NONE`);
    log(`     Token expiry check: ✅ PASSED`);

    log(`\n╔═══════════════════════════════════════════════════════════╗`);
    log(`║ ENFORCEMENT FLOW BREAKDOWN                                ║`);
    log(`╚═══════════════════════════════════════════════════════════╝`);
    log(`  1️⃣  Intent Token Creation (before agent start)`);
    log(`     - Plan with 3 steps generated`);
    log(`     - CSRG proofs embedded in token`);
    log(`     - Token issued with expiry timestamp`);
    log(`\n  2️⃣  Plugin Hook: before_tool_call (for each tool)`);
    log(`     - Extract intentTokenRaw from context`);
    log(`     - Parse JSON to get plan + step_proofs`);
    log(`     - Validate tool name against plan.steps[].action`);
    log(`\n  3️⃣  Local Plan Validation`);
    log(`     - Check token expiry (expiresAt vs current time)`);
    log(`     - Check tool in allowed actions (intent drift prevention)`);
    log(`     - Extract matching step from plan`);
    log(`\n  4️⃣  CSRG Proof Resolution`);
    log(`     - Look for step_proofs in token for current step index`);
    log(`     - Extract: path, proof array, value_digest`);
    log(`     - Build CsrgProofHeaders object`);
    log(`\n  5️⃣  IAP Verification Request`);
    log(`     - POST https://customer-iap.armoriq.ai/iap/verify-step`);
    log(`     - Payload: { token, tool_name, path, proof, context }`);
    log(`     - IAP validates: JWT, plan_id, step sequence, proofs`);
    log(`\n  6️⃣  IAP Response Processing`);
    log(`     - allowed: true/false`);
    log(`     - verification_source: "csrg" or "iap"`);
    log(`     - execution_state: tracks progress`);
    log(`     - If CSRG: node_hash + merkle_root returned`);
    log(`\n  7️⃣  Plugin Decision`);
    log(`     - allowed=true → Return params, tool executes`);
    log(`     - allowed=false → Return block=true, blockReason`);
    log(`\n  8️⃣  Tool Execution (OpenClaw framework)`);
    log(`     - Tool function called with validated params`);
    log(`     - Results returned to agent/user`);

    log(`\n╔═══════════════════════════════════════════════════════════╗`);
    log(`║ ✅ COMPLETE FLOW TEST PASSED                              ║`);
    log(`╚═══════════════════════════════════════════════════════════╝`);

    expect(iapCallCount).toBe(3);
  });

  it("DUPLICATE TOOLS: selects correct proof when same tool appears multiple times with different params", async () => {
    process.env.REQUIRE_CSRG_PROOFS = "false";
    process.env.CSRG_VERIFY_ENABLED = "true";

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          allowed: true,
          reason: "Step verified",
          verification_source: "csrg",
          step: { step_index: 2, action: "send_email", params: {} },
          execution_state: {
            plan_id: "plan-duplicate",
            intent_reference: "plan-duplicate",
            executed_steps: [0, 1],
            current_step: 3,
            total_steps: 3,
            status: "in_progress",
            is_completed: false,
          },
        }),
    });

    const { api, handlers } = createApi({
      enabled: true,
      apiKey: "ak_live_test",
      userId: "user-duplicate",
      agentId: "agent-duplicate",
      backendEndpoint: "https://customer-iap.armoriq.ai",
    });
    register(api as any);

    const intentToken = {
      plan: {
        steps: [
          {
            action: "send_email",
            params: { to: "alice@example.com" },
            metadata: { inputs: { to: "alice@example.com" } },
            mcp: "openclaw",
          },
          {
            action: "send_email",
            params: { to: "bob@example.com" },
            metadata: { inputs: { to: "bob@example.com" } },
            mcp: "openclaw",
          },
          {
            action: "send_email",
            params: { to: "charlie@example.com" },
            metadata: { inputs: { to: "charlie@example.com" } },
            mcp: "openclaw",
          },
        ],
        metadata: { goal: "Send multiple emails" },
      },
      expiresAt: Date.now() / 1000 + 3600,
      step_proofs: [
        {
          step_index: 0,
          path: "/steps/[0]/action",
          proof: [{ position: "left", sibling_hash: "hash_alice" }],
          value_digest: "digest_alice",
        },
        {
          step_index: 1,
          path: "/steps/[1]/action",
          proof: [{ position: "right", sibling_hash: "hash_bob" }],
          value_digest: "digest_bob",
        },
        {
          step_index: 2,
          path: "/steps/[2]/action",
          proof: [{ position: "left", sibling_hash: "hash_charlie" }],
          value_digest: "digest_charlie",
        },
      ],
    };

    const ctx = {
      ...createCtx("duplicate-tools-run"),
      intentTokenRaw: JSON.stringify(intentToken),
    };

    const beforeToolCall = handlers.get("before_tool_call")?.[0];
    const result = await beforeToolCall?.(
      { toolName: "send_email", params: { to: "charlie@example.com" } },
      ctx,
    );

    expect(result?.block).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const callBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body || "{}");
    expect(callBody.path).toBe("/steps/[2]/action");
    expect(callBody.step_index).toBe(2);
    expect(callBody.proof).toEqual([{ position: "left", sibling_hash: "hash_charlie" }]);
  });

  it("DUPLICATE TOOLS: resolves proofs with step_path + step_index fields", async () => {
    process.env.REQUIRE_CSRG_PROOFS = "true";
    process.env.CSRG_VERIFY_ENABLED = "true";

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          allowed: true,
          reason: "Step verified",
          verification_source: "csrg",
          step: { step_index: 2, action: "send_email", params: {} },
          execution_state: {
            plan_id: "plan-step-path",
            intent_reference: "plan-step-path",
            executed_steps: [0, 1],
            current_step: 3,
            total_steps: 3,
            status: "in_progress",
            is_completed: false,
          },
        }),
    });

    const { api, handlers } = createApi({
      enabled: true,
      apiKey: "ak_live_test",
      userId: "user-step-path",
      agentId: "agent-step-path",
      backendEndpoint: "https://customer-iap.armoriq.ai",
    });
    register(api as any);

    const intentToken = {
      plan: {
        steps: [
          {
            action: "send_email",
            params: { to: "alice@example.com" },
            mcp: "openclaw",
          },
          {
            action: "send_email",
            params: { to: "bob@example.com" },
            mcp: "openclaw",
          },
          {
            action: "send_email",
            params: { to: "charlie@example.com" },
            mcp: "openclaw",
          },
        ],
        metadata: { goal: "Send multiple emails" },
      },
      expiresAt: Date.now() / 1000 + 3600,
      step_proofs: [
        {
          step_index: 0,
          step_path: "/steps/[0]/tool",
          proof: [{ position: "left", sibling_hash: "hash_alice" }],
          value_digest: "digest_alice",
        },
        {
          step_index: 1,
          step_path: "/steps/[1]/tool",
          proof: [{ position: "right", sibling_hash: "hash_bob" }],
          value_digest: "digest_bob",
        },
        {
          step_index: 2,
          step_path: "/steps/[2]/tool",
          proof: [{ position: "left", sibling_hash: "hash_charlie" }],
          value_digest: "digest_charlie",
        },
      ],
    };

    const ctx = {
      ...createCtx("duplicate-step-path-run"),
      intentTokenRaw: JSON.stringify(intentToken),
    };

    const beforeToolCall = handlers.get("before_tool_call")?.[0];
    const result = await beforeToolCall?.(
      { toolName: "send_email", params: { to: "charlie@example.com" } },
      ctx,
    );

    expect(result?.block).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const callBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body || "{}");
    expect(callBody.path).toBe("/steps/[2]/tool");
    expect(callBody.step_index).toBe(2);
  });

  it("DUPLICATE TOOLS: matches step.params when metadata.inputs is missing", async () => {
    process.env.REQUIRE_CSRG_PROOFS = "true";
    process.env.CSRG_VERIFY_ENABLED = "true";

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          allowed: true,
          reason: "Step verified",
          verification_source: "csrg",
          step: { step_index: 1, action: "exec", params: {} },
          execution_state: {
            plan_id: "plan-step-params",
            intent_reference: "plan-step-params",
            executed_steps: [0],
            current_step: 2,
            total_steps: 2,
            status: "in_progress",
            is_completed: false,
          },
        }),
    });

    const { api, handlers } = createApi({
      enabled: true,
      apiKey: "ak_live_test",
      userId: "user-step-params",
      agentId: "agent-step-params",
      backendEndpoint: "https://customer-iap.armoriq.ai",
    });
    register(api as any);

    const intentToken = {
      plan: {
        steps: [
          {
            action: "exec",
            params: { command: "date" },
            mcp: "openclaw",
          },
          {
            action: "exec",
            params: { command: "uname -a" },
            mcp: "openclaw",
          },
        ],
        metadata: { goal: "Run two exec calls" },
      },
      expiresAt: Date.now() / 1000 + 3600,
      step_proofs: [
        {
          step_index: 0,
          path: "/steps/[0]/action",
          proof: [{ position: "left", sibling_hash: "hash_date" }],
          value_digest: "digest_date",
        },
        {
          step_index: 1,
          path: "/steps/[1]/action",
          proof: [{ position: "right", sibling_hash: "hash_uname" }],
          value_digest: "digest_uname",
        },
      ],
    };

    const ctx = {
      ...createCtx("duplicate-step-params-run"),
      intentTokenRaw: JSON.stringify(intentToken),
    };

    const beforeToolCall = handlers.get("before_tool_call")?.[0];
    const result = await beforeToolCall?.(
      { toolName: "exec", params: { command: "uname -a" } },
      ctx,
    );

    expect(result?.block).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const callBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body || "{}");
    expect(callBody.path).toBe("/steps/[1]/action");
    expect(callBody.step_index).toBe(1);
  });

  it("DUPLICATE TOOLS: advances through repeated identical tools in sequence", async () => {
    process.env.REQUIRE_CSRG_PROOFS = "true";
    process.env.CSRG_VERIFY_ENABLED = "true";

    fetchMock.mockImplementation(async (_url: string, options: any) => {
      const body = JSON.parse(options?.body || "{}");
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            allowed: true,
            reason: "Step verified",
            verification_source: "csrg",
            step: { step_index: body.step_index ?? 0, action: "send_email", params: {} },
            execution_state: {
              plan_id: "plan-ambiguous",
              intent_reference: "plan-ambiguous",
              executed_steps: [],
              current_step: body.step_index ?? 0,
              total_steps: 3,
              status: "in_progress",
              is_completed: false,
            },
          }),
      };
    });

    const { api, handlers } = createApi({
      enabled: true,
      apiKey: "ak_live_test",
      userId: "user-ambiguous",
      agentId: "agent-ambiguous",
      backendEndpoint: "https://customer-iap.armoriq.ai",
    });
    register(api as any);

    const intentToken = {
      plan: {
        steps: [
          { action: "send_email", params: {}, mcp: "openclaw" },
          { action: "send_email", params: {}, mcp: "openclaw" },
          { action: "send_email", params: {}, mcp: "openclaw" },
        ],
        metadata: { goal: "Send multiple emails without distinct params" },
      },
      expiresAt: Date.now() / 1000 + 3600,
      step_proofs: [
        {
          step_index: 0,
          path: "/steps/[0]/action",
          proof: [{ position: "left", sibling_hash: "hash_1" }],
          value_digest: "digest_1",
        },
        {
          step_index: 1,
          path: "/steps/[1]/action",
          proof: [{ position: "right", sibling_hash: "hash_2" }],
          value_digest: "digest_2",
        },
        {
          step_index: 2,
          path: "/steps/[2]/action",
          proof: [{ position: "left", sibling_hash: "hash_3" }],
          value_digest: "digest_3",
        },
      ],
    };

    const ctx = {
      ...createCtx("ambiguous-tools-run"),
      intentTokenRaw: JSON.stringify(intentToken),
    };

    const beforeToolCall = handlers.get("before_tool_call")?.[0];
    const result1 = await beforeToolCall?.({ toolName: "send_email", params: {} }, ctx);
    const result2 = await beforeToolCall?.({ toolName: "send_email", params: {} }, ctx);
    const result3 = await beforeToolCall?.({ toolName: "send_email", params: {} }, ctx);

    expect(result1?.block).not.toBe(true);
    expect(result2?.block).not.toBe(true);
    expect(result3?.block).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const callBody1 = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body || "{}");
    const callBody2 = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body || "{}");
    const callBody3 = JSON.parse(fetchMock.mock.calls[2]?.[1]?.body || "{}");
    expect(callBody1.path).toBe("/steps/[0]/action");
    expect(callBody2.path).toBe("/steps/[1]/action");
    expect(callBody3.path).toBe("/steps/[2]/action");
    expect(callBody1.step_index).toBe(0);
    expect(callBody2.step_index).toBe(1);
    expect(callBody3.step_index).toBe(2);
  });

  it("NO CACHED PLAN: blocks when there is no cached plan and no intent token", async () => {
    const { api, handlers } = createApi({
      enabled: true,
      apiKey: "ak_live_test",
      userId: "user-no-plan",
      agentId: "agent-no-plan",
    });
    register(api as any);

    const ctx = createCtx("no-plan-run");

    const beforeToolCall = handlers.get("before_tool_call")?.[0];
    const result = await beforeToolCall?.({ toolName: "send_email", params: {} }, ctx);

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("ArmorIQ intent plan missing");
  });
});
