// Runtime adapter for `pi` (npm @mariozechner/pi-coding-agent). Pattern
// borrowed from web-exposure-detection/src/pkg/webexposure/ai/pi/pi.go.
//
// pi takes a system prompt + a user message + a provider/model and emits an
// NDJSON event stream on stdout. The agent inside runs a tool-use loop with
// bash + write + read built in. Bedrock auth comes from the ECS task role.
//
// runPi returns the result and lets the caller (runner.ts) drive
// `complete`/`fail` so the monitor can upload artifacts in between.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

import type { Monitor } from "./sdk/src/monitor.js";
import type { BootstrapResponse, ManagerClient } from "./sdk/src/sdk.js";

export interface RunPiArgs {
  client: ManagerClient;
  bootstrap: BootstrapResponse;
  prompt: string;
  payload: Record<string, unknown>;
  workdir?: string;
  monitor?: Monitor;
  log?: (level: string, message: string, extras?: Record<string, unknown>) => void;
}

export interface RunPiResult {
  result?: Record<string, unknown>;
  error?: { code: string; message: string; detail?: Record<string, unknown> };
  tokens: { in: number; out: number; costUsd: number };
}

interface PiUsage {
  input?: number;
  output?: number;
  totalTokens?: number;
  cacheRead?: number;
  costUsd?: number;
}

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

export async function runPi(args: RunPiArgs): Promise<RunPiResult> {
  const { client, bootstrap, prompt, payload, monitor, log } = args;
  const narrate = (level: string, message: string, extras?: Record<string, unknown>): void => {
    if (log) log(level, message, extras);
  };
  const workdir = args.workdir ?? "/work";

  const requestedModel =
    typeof payload.model === "string" && payload.model.length > 0
      ? payload.model
      : "amazon-bedrock/us.amazon.nova-pro-v1:0";

  const piProvider = piProviderFor(requestedModel);
  if (!piProvider) {
    return {
      error: {
        code: "agent.unknown_secret_key",
        message: `model id missing provider prefix: ${requestedModel}`,
      },
      tokens: { in: 0, out: 0, costUsd: 0 },
    };
  }
  const piModel = modelFor(piProvider, requestedModel);

  mkdirSync(workdir, { recursive: true });

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (piProvider === "amazon-bedrock") {
    env.AWS_REGION = env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1";
    env.AWS_DEFAULT_REGION = env.AWS_REGION;
  }
  for (const [k, v] of Object.entries(bootstrap.secrets)) {
    env[k] = v;
  }

  const queue: Array<{ ts: string; level: string; message: string; [k: string]: unknown }> = [];
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
  const enqueue = (e: { ts: string; level: string; message: string; [k: string]: unknown }): void => {
    queue.push(e);
    monitor?.appendTranscript(JSON.stringify(e));
    monitor?.markActivity();
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
      "go",
    ],
    { cwd: workdir, env },
  );

  monitor?.markActivity();
  narrate("info", "pi: child spawned", {
    provider: piProvider,
    model: piModel,
    pid: child.pid,
    workdir,
    awsRegion: env.AWS_REGION,
    secretEnvKeys: Object.keys(bootstrap.secrets),
    argv: ["-p", "--mode", "json", "--provider", piProvider, "--model", piModel, "--system-prompt", `<${prompt.length} chars>`, "go"],
  });
  enqueue({
    ts: new Date().toISOString(),
    level: "info",
    message: "pi spawned",
    provider: piProvider,
    model: piModel,
    pid: child.pid,
  });

  // Let the monitor kill us on stall by setting a hook that signals the child.
  if (monitor) {
    monitor.bindStallKill?.(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* swallow */
      }
    });
  }

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

  // Periodic liveness narration while we wait on the child. Helps confirm
  // the runner is alive even when pi has not emitted anything.
  const liveTicker = setInterval(() => {
    narrate("info", "pi: still waiting on child", {
      pid: child.pid,
      stdoutBytesSeen: lastAssistantText.length,
      stderrLastLine: lastStderr.slice(0, 200),
    });
  }, 30_000);

  const exitCode: number = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  clearInterval(liveTicker);

  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushing;
  await flush();
  narrate("info", "pi: child closed", {
    exitCode,
    lastStderr: lastStderr.slice(0, 500),
    assistantTextBytes: lastAssistantText.length,
  });

  const tokens = { in: totalIn, out: totalOut, costUsd: totalCostUsd };

  if (exitCode !== 0) {
    return {
      error: {
        code: "provider.failed",
        message: lastStderr || `pi exited with code ${exitCode}`,
        detail: { exitCode },
      },
      tokens,
    };
  }

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

  return { result, tokens };
}
