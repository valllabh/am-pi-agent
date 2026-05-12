// Runtime adapter for `pi` (npm @mariozechner/pi-coding-agent). Pattern
// borrowed from web-exposure-detection/src/pkg/webexposure/ai/pi/pi.go which
// has been running this exact shape in production against Bedrock Nova.
//
// pi takes a system prompt + a user message + a provider/model and emits an
// NDJSON event stream on stdout. The agent inside runs a tool-use loop with
// bash + write + read built in. For Bedrock we authenticate via the ECS task
// role; no api key is needed.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { BootstrapResponse, ManagerClient } from "./sdk.js";

export interface RunPiArgs {
  client: ManagerClient;
  bootstrap: BootstrapResponse;
  prompt: string;
  payload: Record<string, unknown>;
  workdir?: string;
}

interface LogEvent {
  ts: string;
  level: string;
  message: string;
  [k: string]: unknown;
}

interface PiUsage {
  input?: number;
  output?: number;
  totalTokens?: number;
  cacheRead?: number;
  costUsd?: number;
}

// Strip the `amazon-bedrock/` prefix off our internal model id when handing it
// to pi (pi's --provider already names the route; --model takes the bare id).
function modelFor(piProvider: string, model: string): string {
  if (piProvider === "amazon-bedrock") {
    const idx = model.indexOf("/");
    if (idx >= 0 && model.slice(0, idx) === "amazon-bedrock") {
      return model.slice(idx + 1);
    }
  }
  return model;
}

function piProviderFor(model: string): string | null {
  const idx = model.indexOf("/");
  if (idx < 0) return null;
  return model.slice(0, idx);
}

export async function runPi(args: RunPiArgs): Promise<void> {
  const { client, bootstrap, prompt, payload } = args;
  const workdir = args.workdir ?? "/work";

  const requestedModel =
    typeof payload.model === "string" && payload.model.length > 0
      ? payload.model
      : "amazon-bedrock/us.amazon.nova-pro-v1:0";

  const piProvider = piProviderFor(requestedModel);
  if (!piProvider) {
    await client.fail({
      code: "agent.unknown_secret_key",
      message: `model id missing provider prefix: ${requestedModel}`,
    });
    return;
  }
  const piModel = modelFor(piProvider, requestedModel);

  mkdirSync(workdir, { recursive: true });

  // Bedrock auth: ECS task role on Fargate, AWS_* env locally. pi reads the
  // SDK default chain; only AWS_REGION needs to be explicit so inference
  // profiles like `us.amazon.nova-pro-v1:0` resolve.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (piProvider === "amazon-bedrock") {
    env.AWS_REGION =
      env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1";
    env.AWS_DEFAULT_REGION = env.AWS_REGION;
  }

  // Push everything sandbox secrets carry into the child env as well so the
  // agent can `curl $GITHUB_TOKEN`, `$QUALYS_*`, etc directly.
  for (const [k, v] of Object.entries(bootstrap.secrets)) {
    env[k] = v;
  }

  const queue: LogEvent[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let flushing: Promise<void> = Promise.resolve();
  const flush = async (): Promise<void> => {
    if (queue.length === 0) return;
    const batch = queue.splice(0, queue.length);
    try {
      await client.pushLogs(batch);
    } catch {
      /* don't fail run on log loss */
    }
  };
  const enqueue = (e: LogEvent): void => {
    queue.push(e);
    if (queue.length >= 50) {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flushing = flushing.then(() => flush());
    } else if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushing = flushing.then(() => flush());
      }, 1000);
    }
  };

  let totalIn = 0;
  let totalOut = 0;
  let totalCostUsd = 0;
  let lastAssistantText = "";
  let lastStderr = "";

  const child = spawn(
    "pi",
    [
      "-p",
      "--mode",
      "json",
      "--provider",
      piProvider,
      "--model",
      piModel,
      "--system-prompt",
      prompt,
      // Empty user message — the system prompt carries the full task because
      // it is already assembled by the caller from soulMd + skill bodies.
      "go",
    ],
    { cwd: workdir, env },
  );

  const stdoutRl = createInterface({ input: child.stdout });
  stdoutRl.on("line", (line: string) => {
    const ts = new Date().toISOString();
    let parsed: Record<string, unknown> | null = null;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object" && !Array.isArray(v)) {
        parsed = v as Record<string, unknown>;
      }
    } catch {
      parsed = null;
    }
    if (parsed) {
      // Track tokens via message_end events.
      const msg = parsed.message as
        | { role?: string; content?: Array<{ type?: string; text?: string }>; usage?: PiUsage }
        | undefined;
      if (parsed.type === "message_end" && msg?.usage) {
        totalIn += msg.usage.input ?? 0;
        totalOut += msg.usage.output ?? 0;
        totalCostUsd += msg.usage.costUsd ?? 0;
      }
      if (msg?.role === "assistant" && Array.isArray(msg.content)) {
        for (const c of msg.content) {
          if (c.type === "text" && typeof c.text === "string") {
            lastAssistantText = c.text;
          }
        }
      }
      enqueue({ ts, level: "info", message: "pi", ...parsed });
    } else {
      enqueue({ ts, level: "info", message: line });
    }
  });

  const stderrRl = createInterface({ input: child.stderr });
  stderrRl.on("line", (line: string) => {
    if (line.length > 0) lastStderr = line;
    enqueue({ ts: new Date().toISOString(), level: "error", message: line });
  });

  const exitCode: number = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushing;
  await flush();

  if (exitCode !== 0) {
    await client.fail({
      code: "provider.failed",
      message: lastStderr || `pi exited with code ${exitCode}`,
      detail: { exitCode },
    });
    return;
  }

  // Cost reporting goes through the manager's /v1/tasks/:id/cost route; the
  // sdk surface that's wired in this build only exposes complete/fail/logs so
  // cost is folded into the complete payload for now.
  void totalIn;
  void totalOut;
  void totalCostUsd;

  // Prefer the agent's output file if it wrote one (skills commit results to
  // .am-out/result.json by convention); otherwise fall back to the last
  // assistant text from the event stream.
  const outFile = `${workdir}/.am-out/result.json`;
  let result: Record<string, unknown> = { ok: true };
  try {
    const buf = readFileSync(outFile);
    const parsed = JSON.parse(buf.toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      result = parsed as Record<string, unknown>;
    }
  } catch {
    if (lastAssistantText) {
      result = { text: lastAssistantText.slice(0, 16_000) };
    }
  }

  await client.complete(result);
}
