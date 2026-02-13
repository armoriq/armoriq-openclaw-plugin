set -euo pipefail

R='\033[1;31m'
DR='\033[0;31m'
W='\033[1;97m'
D='\033[0;90m'
N='\033[0m'

clear 2>/dev/null || true
sleep 0.1

echo ""
echo -e "${R}    ╔════════════════════════════════════════════════════════════════╗       ${N}"
echo -e "${R}    ║${N}                                                                ${R}║${N}"
echo -e "${R}    ║${W}     ██████╗ ██████╗ ██╗     ██╗██████╗ ██████╗ ██╗ ██████╗     ${R}║${N}"
echo -e "${R}    ║${W}     ██╔══██╗██╔══██╗████╗ ████║██╔══██╗██╔══██╗██║██╔═══██╗    ${R}║${N}"
echo -e "${R}    ║${W}     ███████║██████╔╝██╔████╔██¯██║  ██║██████╔╝██║██║   ██║    ${R}║${N}"
echo -e "${R}    ║${W}     ██╔══██║██╔══██╗██║╚██╔╝██║██║  ██║██╔══██╗██║██║▄▄ ██║    ${R}║${N}"
echo -e "${R}    ║${W}     ██║  ██║██║  ██║██║ ╚═╝ ██║╚█████╔╝██║  ██║██║╚██████╔╝    ${R}║${N}"
echo -e "${R}    ║${W}     ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝ ╚════╝ ╚═╝  ╚═╝╚═╝ ╚══▀══╝     ${R}║${N}"
echo -e "${R}    ║${N}                                                                ${R}║${N}"
echo -e "${R}    ║${D}       AI agents are moving fast. Security isn't.               ${R}║${N}"
echo -e "${R}    ║${N}                                                                ${R}║${N}"
echo -e "${R}    ║${W}       The control layer for the agent era.                     ${R}║${N}"
echo -e "${R}    ║${D}       Track intent. Catch drift. Stop risk.                    ${R}║${N}"
echo -e "${R}    ║${N}                                                                ${R}║${N}"
echo -e "${R}    ║${DR}                    armoriq.ai                                  ${R}║${N}"
echo -e "${R}    ║${N}                                                                ${R}║${N}"
echo -e "${R}    ╚════════════════════════════════════════════════════════════════╝       ${N}"
echo ""
sleep 0.8

step=0
total=7
bar() {
  step=$((step + 1))
  local pct=$((step * 100 / total))
  local filled=$((pct / 5))
  local empty=$((20 - filled))
  printf "\r${R}  [${W}"
  for ((i=0; i<filled; i++)); do printf "█"; done
  for ((i=0; i<empty; i++)); do printf "${D}░"; done
  printf "${R}] ${W}%3d%%${N}  %s" "$pct" "$1"
  echo ""
}

# patch-armoriq.sh
# Patches a fresh OpenClaw clone to support the ArmorIQ plugin's extended hook context.
# Run from the OpenClaw repo root after cloning.
#
# Usage:
#   git clone git@github.com:openclaw/openclaw.git
#   cd openclaw
#   bash /path/to/patch-armoriq.sh
#   pnpm install && pnpm build
#
# What it does:
#   1. Extends PluginHookAgentContext with sender, model, channel fields
#   2. Extends PluginHookBeforeAgentStartEvent with tools array
#   3. Extends the before_agent_start hook call in attempt.ts to pass all context fields
#   4. Adds agentId/sessionKey to SubscribeEmbeddedPiSessionParams
#   5. Passes agentId/sessionKey through to subscribeEmbeddedPiSession
#   6. Fixes before_tool_call hook in handlers.tools.ts to pass agentId/sessionKey
#   7. Removes duplicate before_tool_call hook from pi-tool-definition-adapter.ts

TYPES_FILE="src/plugins/types.ts"
ATTEMPT_FILE="src/agents/pi-embedded-runner/run/attempt.ts"
SUBSCRIBE_TYPES_FILE="src/agents/pi-embedded-subscribe.types.ts"
HANDLERS_TOOLS_FILE="src/agents/pi-embedded-subscribe.handlers.tools.ts"
TOOL_ADAPTER_FILE="src/agents/pi-tool-definition-adapter.ts"

for f in "$TYPES_FILE" "$ATTEMPT_FILE" "$SUBSCRIBE_TYPES_FILE" "$HANDLERS_TOOLS_FILE" "$TOOL_ADAPTER_FILE"; do
  if [[ ! -f "$f" ]]; then
    echo "ERROR: $f not found. Run this from the OpenClaw repo root."
    exit 1
  fi
done

echo -e "${R}  Patching OpenClaw for ArmorIQ...${N}"
echo ""

# --- 1. Extend PluginHookAgentContext in types.ts ---
bar "types.ts  PluginHookAgentContext"

python3 << 'PYEOF'
with open("src/plugins/types.ts", "r") as f:
    content = f.read()

old_ctx = """export type PluginHookAgentContext = {
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  messageProvider?: string;
};"""

new_ctx = """export type PluginHookAgentContext = {
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  messageProvider?: string;
  messageChannel?: string;
  accountId?: string;
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  senderE164?: string;
  runId?: string;
  model?: unknown;
  modelRegistry?: unknown;
};"""

if "messageChannel?: string;" in content and "PluginHookAgentContext" in content:
    # check if it's already in the right type
    idx = content.find("PluginHookAgentContext")
    snippet = content[idx:idx+300]
    if "messageChannel" in snippet:
        print("  [skip] PluginHookAgentContext already extended")
    else:
        content = content.replace(old_ctx, new_ctx)
        with open("src/plugins/types.ts", "w") as f:
            f.write(content)
        print("  [patch] Extended PluginHookAgentContext in types.ts")
elif old_ctx in content:
    content = content.replace(old_ctx, new_ctx)
    with open("src/plugins/types.ts", "w") as f:
        f.write(content)
    print("  [patch] Extended PluginHookAgentContext in types.ts")
else:
    print("  [skip] PluginHookAgentContext already extended or structure changed")
PYEOF

# --- 2. Extend PluginHookBeforeAgentStartEvent with tools ---
bar "types.ts  BeforeAgentStartEvent.tools"

if grep -q 'tools?: Array<{' "$TYPES_FILE"; then
  echo -e "  ${D}[skip] already has tools${N}"
else
  sed -i.bak '/^  messages?: unknown\[\];$/a\
\  tools?: Array<{\
\    name: string;\
\    description?: string;\
\    parameters?: Record<string, unknown>;\
\  }>;' "$TYPES_FILE"
  rm -f "${TYPES_FILE}.bak"
fi

# --- 3. Patch attempt.ts: extend before_agent_start hook call ---
bar "attempt.ts  before_agent_start"

if grep -q 'messageChannel: runtimeChannel' "$ATTEMPT_FILE"; then
  echo -e "  ${D}[skip] already patched${N}"
else
  python3 << 'PYEOF'
with open("src/agents/pi-embedded-runner/run/attempt.ts", "r") as f:
    content = f.read()

old_block = """        if (hookRunner?.hasHooks("before_agent_start")) {
          try {
            const hookResult = await hookRunner.runBeforeAgentStart(
              {
                prompt: params.prompt,
                messages: activeSession.messages,
              },
              {
                agentId: hookAgentId,
                sessionKey: params.sessionKey,
                workspaceDir: params.workspaceDir,
                messageProvider: params.messageProvider ?? undefined,
              },
            );"""

new_block = """        if (hookRunner?.hasHooks("before_agent_start")) {
          try {
            const hookTools =
              tools.length > 0
                ? tools
                    .filter((tool) => tool.name)
                    .map((tool) => ({
                      name: tool.name,
                      description: tool.description ?? "",
                      parameters:
                        tool.parameters && typeof tool.parameters === "object"
                          ? (tool.parameters as Record<string, unknown>)
                          : undefined,
                    }))
                : undefined;
            const hookResult = await hookRunner.runBeforeAgentStart(
              {
                prompt: params.prompt,
                messages: activeSession.messages,
                tools: hookTools,
              },
              {
                agentId: hookAgentId,
                sessionKey: params.sessionKey,
                workspaceDir: params.workspaceDir,
                messageProvider: params.messageProvider ?? undefined,
                messageChannel: runtimeChannel ?? undefined,
                accountId: params.agentAccountId,
                senderId: params.senderId ?? undefined,
                senderName: params.senderName ?? undefined,
                senderUsername: params.senderUsername ?? undefined,
                senderE164: params.senderE164 ?? undefined,
                runId: params.runId,
                model: params.model,
                modelRegistry: params.modelRegistry,
              },
            );"""

if old_block in content:
    content = content.replace(old_block, new_block)
    with open("src/agents/pi-embedded-runner/run/attempt.ts", "w") as f:
        f.write(content)
    print("    attempt.ts before_agent_start patched")
else:
    print("    WARNING: Could not find exact match for before_agent_start in attempt.ts")
    print("    Manual patching may be needed.")
PYEOF
fi

# --- 4. Add agentId/sessionKey to SubscribeEmbeddedPiSessionParams ---
bar "subscribe.types  agentId/sessionKey"

if grep -q 'agentId?: string;' "$SUBSCRIBE_TYPES_FILE"; then
  echo -e "  ${D}[skip] already has agentId${N}"
else
  sed -i.bak '/hookRunner?: HookRunner;/a\
\  agentId?: string;\
\  sessionKey?: string;' "$SUBSCRIBE_TYPES_FILE"
  rm -f "${SUBSCRIBE_TYPES_FILE}.bak"
fi

# --- 5. Pass agentId/sessionKey in subscribeEmbeddedPiSession call ---
bar "attempt.ts  subscribe params"

if grep -q 'agentId: sessionAgentId,' "$ATTEMPT_FILE" && grep -q 'sessionKey: params.sessionKey,' "$ATTEMPT_FILE"; then
  # check specifically in the subscribeEmbeddedPiSession block
  python3 << 'PYEOF'
with open("src/agents/pi-embedded-runner/run/attempt.ts", "r") as f:
    content = f.read()

idx = content.find("subscribeEmbeddedPiSession({")
if idx == -1:
    print("  [skip] subscribeEmbeddedPiSession call not found")
else:
    block = content[idx:idx+500]
    if "agentId: sessionAgentId," in block:
        print("  [skip] subscribeEmbeddedPiSession already passes agentId")
    else:
        old = "hookRunner: getGlobalHookRunner() ?? undefined,"
        new = "hookRunner: getGlobalHookRunner() ?? undefined,\n        agentId: sessionAgentId,\n        sessionKey: params.sessionKey,"
        content = content.replace(old, new, 1)
        with open("src/agents/pi-embedded-runner/run/attempt.ts", "w") as f:
            f.write(content)
        print("  [patch] Added agentId/sessionKey to subscribeEmbeddedPiSession call")
PYEOF
else
  echo "  [patch] Adding agentId/sessionKey to subscribeEmbeddedPiSession call"
  python3 << 'PYEOF'
with open("src/agents/pi-embedded-runner/run/attempt.ts", "r") as f:
    content = f.read()

old = "hookRunner: getGlobalHookRunner() ?? undefined,"
new = "hookRunner: getGlobalHookRunner() ?? undefined,\n        agentId: sessionAgentId,\n        sessionKey: params.sessionKey,"
content = content.replace(old, new, 1)
with open("src/agents/pi-embedded-runner/run/attempt.ts", "w") as f:
    f.write(content)
print("  [patch] Added agentId/sessionKey to subscribeEmbeddedPiSession call")
PYEOF
fi

# --- 6. Fix before_tool_call hook context in handlers.tools.ts ---
bar "handlers.tools.ts  before_tool_call"

if grep -q 'agentId: ctx.params.agentId' "$HANDLERS_TOOLS_FILE"; then
  echo -e "  ${D}[skip] already passes agentId${N}"
else
  python3 << 'PYEOF'
with open("src/agents/pi-embedded-subscribe.handlers.tools.ts", "r") as f:
    content = f.read()

old = "await hookRunner.runBeforeToolCall(hookEvent, { toolName });"
new = """await hookRunner.runBeforeToolCall(hookEvent, {
        toolName,
        agentId: ctx.params.agentId,
        sessionKey: ctx.params.sessionKey,
      });"""

if old in content:
    content = content.replace(old, new)
    with open("src/agents/pi-embedded-subscribe.handlers.tools.ts", "w") as f:
        f.write(content)
    print("    handlers.tools.ts patched")
else:
    print("    WARNING: Could not find exact match in handlers.tools.ts")
PYEOF
fi

# --- 7. Remove duplicate before_tool_call hook from pi-tool-definition-adapter.ts ---
bar "tool-adapter.ts  remove duplicate hooks"

python3 << 'PYEOF'
with open("src/agents/pi-tool-definition-adapter.ts", "r") as f:
    content = f.read()

# check if the duplicate hook exists
if "// Call before_tool_call hook" in content and "runBeforeToolCallHook({" in content:
    # check if toToolDefinitions has the inline hook
    idx = content.find("export function toToolDefinitions")
    if idx == -1:
        print("  [skip] toToolDefinitions not found")
    else:
        func_block = content[idx:content.find("\nexport ", idx+1)]
        if "runBeforeToolCallHook" in func_block:
            print("  [patch] Removing duplicate hook calls from toToolDefinitions")

            old_execute = """      execute: async (...args: ToolExecuteArgs): Promise<AgentToolResult<unknown>> => {
        const { toolCallId, params, onUpdate, signal } = splitToolExecuteArgs(args);
        try {
          // Call before_tool_call hook
          const hookOutcome = await runBeforeToolCallHook({
            toolName: name,
            params,
            toolCallId,
          });
          if (hookOutcome.blocked) {
            throw new Error(hookOutcome.reason);
          }
          const adjustedParams = hookOutcome.params;
          const result = await tool.execute(toolCallId, adjustedParams, signal, onUpdate);

          // Call after_tool_call hook
          const hookRunner = getGlobalHookRunner();
          if (hookRunner?.hasHooks("after_tool_call")) {
            try {
              await hookRunner.runAfterToolCall(
                {
                  toolName: name,
                  params: isPlainObject(adjustedParams) ? adjustedParams : {},
                  result,
                },
                { toolName: name },
              );
            } catch (hookErr) {
              logDebug(
                `after_tool_call hook failed: tool=${normalizedName} error=${String(hookErr)}`,
              );
            }
          }

          return result;
        } catch (err) {
          if (signal?.aborted) {
            throw err;
          }
          const name =
            err && typeof err === "object" && "name" in err
              ? String((err as { name?: unknown }).name)
              : "";
          if (name === "AbortError") {
            throw err;
          }
          const described = describeToolExecutionError(err);
          if (described.stack && described.stack !== described.message) {
            logDebug(`tools: ${normalizedName} failed stack:\\n${described.stack}`);
          }
          logError(`[tools] ${normalizedName} failed: ${described.message}`);

          const errorResult = jsonResult({
            status: "error",
            tool: normalizedName,
            error: described.message,
          });

          // Call after_tool_call hook for errors too
          const hookRunner = getGlobalHookRunner();
          if (hookRunner?.hasHooks("after_tool_call")) {
            try {
              await hookRunner.runAfterToolCall(
                {
                  toolName: normalizedName,
                  params: isPlainObject(params) ? params : {},
                  error: described.message,
                },
                { toolName: normalizedName },
              );
            } catch (hookErr) {
              logDebug(
                `after_tool_call hook failed: tool=${normalizedName} error=${String(hookErr)}`,
              );
            }
          }

          return errorResult;
        }
      },"""

            new_execute = """      execute: async (...args: ToolExecuteArgs): Promise<AgentToolResult<unknown>> => {
        const { toolCallId, params, onUpdate, signal } = splitToolExecuteArgs(args);
        try {
          return await tool.execute(toolCallId, params, signal, onUpdate);
        } catch (err) {
          if (signal?.aborted) {
            throw err;
          }
          const name =
            err && typeof err === "object" && "name" in err
              ? String((err as { name?: unknown }).name)
              : "";
          if (name === "AbortError") {
            throw err;
          }
          const described = describeToolExecutionError(err);
          if (described.stack && described.stack !== described.message) {
            logDebug(`tools: ${normalizedName} failed stack:\\n${described.stack}`);
          }
          logError(`[tools] ${normalizedName} failed: ${described.message}`);
          return jsonResult({
            status: "error",
            tool: normalizedName,
            error: described.message,
          });
        }
      },"""

            if old_execute in content:
                content = content.replace(old_execute, new_execute)
                # remove unused getGlobalHookRunner import
                content = content.replace(
                    'import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";\n', ''
                )
                with open("src/agents/pi-tool-definition-adapter.ts", "w") as f:
                    f.write(content)
                print("    Removed duplicate hooks from toToolDefinitions")
            else:
                print("    WARNING: toToolDefinitions execute block doesn't match expected pattern")
        else:
            print("  [skip] toToolDefinitions already clean")
else:
    print("  [skip] No duplicate hook calls found in pi-tool-definition-adapter.ts")
PYEOF

echo ""
sleep 0.3
echo -e "${R}  ╔═══════════════════════════════════════════════╗${N}"
echo -e "${R}  ║${N}                                               ${R}║${N}"
echo -e "${R}  ║${W}   Patch complete. Lock it down.               ${R}║${N}"
echo -e "${R}  ║${N}                                               ${R}║${N}"
echo -e "${R}  ║${D}   Next:                                       ${R}║${N}"
echo -e "${R}  ║${N}   1. ${W}pnpm install && pnpm build${N}               ${R}║${N}"
echo -e "${R}  ║${N}   2. Install ArmorIQ plugin                   ${R}║${N}"
echo -e "${R}  ║${N}   3. Configure openclaw.json + env            ${R}║${N}"
echo -e "${R}  ║${N}   4. ${W}pnpm dev gateway${N}                         ${R}║${N}"
echo -e "${R}  ║${N}                                               ${R}║${N}"
echo -e "${R}  ║${DR}              armoriq.ai                       ${R}║${N}"
echo -e "${R}  ╚═══════════════════════════════════════════════╝${N}"
echo ""
