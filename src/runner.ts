import { runPi } from "./pi.js";
import { startMonitor } from "./sdk/src/monitor.js";
import { ManagerClient } from "./sdk/src/sdk.js";
import { buildSkillsContext, stageSkillAssets } from "./sdk/src/skills.js";

// Minimal NDJSON event helper that also routes the same line to the monitor's
// transcript buffer. Lets us narrate every phase from bootstrap to closing
// rituals so the UI Live transcript Card shows what is happening even when
// the LLM (pi child process) is silent.
function makeLogger(
  client: ManagerClient,
  appendTranscript?: (line: string) => void,
): (level: string, message: string, extras?: Record<string, unknown>) => void {
  return (level, message, extras) => {
    const evt = { ts: new Date().toISOString(), level, message, ...(extras ?? {}) };
    void client.pushLogs([evt]).catch(() => {});
    try {
      appendTranscript?.(JSON.stringify(evt));
    } catch {
      /* swallow */
    }
    // Also stderr so CloudWatch retains the same trace even if pushLogs fails.
    console.error(JSON.stringify(evt));
  };
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const TASK_ID = process.env.TASK_ID;
  const MANAGER_URL = process.env.MANAGER_URL;
  const BOOTSTRAP_TOKEN = process.env.BOOTSTRAP_TOKEN;
  if (!TASK_ID || !MANAGER_URL || !BOOTSTRAP_TOKEN) {
    console.error("missing required env: TASK_ID, MANAGER_URL, BOOTSTRAP_TOKEN");
    process.exit(2);
  }

  // Phase 1: bootstrap. Pre-bootstrap we cannot pushLogs (no run JWT yet); log
  // to stderr only so it still shows up in CloudWatch.
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "info", message: "runner: bootstrap starting", taskId: TASK_ID }));

  const { client, bootstrap } = await ManagerClient.bootstrap({
    TASK_ID,
    MANAGER_URL,
    BOOTSTRAP_TOKEN,
  });

  const log = makeLogger(client);
  log("info", "runner: bootstrap complete", {
    runId: bootstrap.runId,
    agentName: bootstrap.agent.name,
    agentVersion: bootstrap.agent.version,
    imageUri: bootstrap.agent.imageUri,
    enabledSkills: bootstrap.enabledSkills,
    secretKeys: Object.keys(bootstrap.secrets),
    soulMdLen: bootstrap.soulMd.length,
    elapsedMs: Date.now() - t0,
  });

  const payload = bootstrap.task.payload as Record<string, unknown>;
  // Story 19-1z: soulMd is the only source for the system prompt. The
  // legacy payload.prompt fallback was dropped after the migration window.
  if (!(typeof bootstrap.soulMd === "string" && bootstrap.soulMd.trim().length > 0)) {
    throw new Error("agent.soulMd missing or empty; required after story 19-1z");
  }
  const systemPrompt = bootstrap.soulMd;
  const workdir = "/work";

  const monitor = startMonitor({
    client,
    taskId: TASK_ID,
    workdir,
    heartbeatMs: 30_000,
    stallMs: 180_000,
    onStall: (idleMs) => {
      log("error", "runner: watchdog fired, child stalled", { idleMs });
    },
  });
  log("info", "runner: monitor started", { heartbeatMs: 30_000, stallMs: 180_000 });
  // Re-bind the logger to also append into the monitor transcript buffer so
  // the finalize() artifact contains the same trace the UI streams live.
  const logT = makeLogger(client, (line) => monitor.appendTranscript(line));

  let fullPrompt = "";
  let runResult: Record<string, unknown> | undefined;
  let runError: { code: string; message: string; detail?: Record<string, unknown> } | undefined;
  let stalled = false;

  monitor.bindStallKill(() => {
    stalled = true;
    logT("warn", "runner: stall flag set");
  });

  const finalize = async (reason: string): Promise<void> => {
    logT("info", "runner: finalize starting", {
      reason,
      hasResult: runResult !== undefined,
      hasError: runError !== undefined,
    });
    try {
      await monitor.finalize({
        systemPrompt: fullPrompt,
        payload,
        ...(runResult !== undefined ? { result: runResult } : {}),
        ...(runError !== undefined
          ? { error: { code: runError.code, message: runError.message } }
          : {}),
      });
      logT("info", "runner: finalize complete (artifacts uploaded)");
    } catch (e) {
      logT("error", "runner: finalize failed", { err: (e as Error).message });
    }
  };

  let signalled = false;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      if (signalled) return;
      signalled = true;
      void (async () => {
        logT("warn", `runner: received ${sig}`);
        runError = runError ?? { code: "internal.signal", message: `received ${sig}` };
        await finalize(sig);
        try {
          await client.fail({ code: runError.code, message: runError.message });
        } catch {
          /* swallow */
        }
        process.exit(0);
      })();
    });
  }

  try {
    {
      logT("info", "runner: loading skills");
      const skills = await client.loadSkills();
      logT("info", "runner: skills loaded", {
        count: skills.length,
        skills: skills.map((s) => ({ name: s.name, version: s.version, bodyLen: s.body?.length ?? 0, hasAssets: !!s.assetsRef })),
      });
      const stagedCount = await stageSkillAssets({ client, skills, workdir, log: logT });
      logT("info", "runner: skill assets staged", { count: stagedCount });
      const skillsContext = buildSkillsContext(skills);
      fullPrompt = (systemPrompt + skillsContext).trimStart();
      logT("info", "runner: prompt assembled", {
        chars: fullPrompt.length,
        skillsContextChars: skillsContext.length,
      });
      logT("info", "runner: dispatching to pi runtime", {
        model: bootstrap.agent.model,
      });

      const out = await runPi({
        client,
        bootstrap,
        prompt: fullPrompt,
        payload,
        workdir,
        monitor,
        log: logT,
      });
      logT("info", "runner: pi runtime returned", {
        hasResult: !!out.result,
        hasError: !!out.error,
        tokens: out.tokens,
      });
      if (stalled) {
        runError = {
          code: "agent.stalled",
          message: "child produced no output within stall window; killed by watchdog",
        };
        logT("error", "runner: marking task as stalled");
      } else if (out.error) {
        runError = out.error;
      } else {
        runResult = out.result ?? { ok: true };
      }
    }
  } catch (err) {
    const e = err as Error;
    runError = { code: "internal.error", message: e.message };
    logT("error", "runner: caught exception", { err: e.message, stack: e.stack?.slice(0, 1000) });
  }

  monitor.stop();
  await finalize("normal_exit");

  if (runError) {
    logT("error", "runner: calling client.fail", runError);
    try {
      await client.fail({ code: runError.code, message: runError.message });
    } catch (e) {
      logT("error", "runner: fail call threw", { err: (e as Error).message });
    }
    logT("info", "runner: exiting 1");
    process.exit(1);
  } else {
    logT("info", "runner: calling client.complete");
    try {
      await client.complete(runResult ?? { ok: true });
      logT("info", "runner: complete acknowledged; exiting 0");
    } catch (e) {
      logT("error", "runner: complete call threw", { err: (e as Error).message });
    }
  }
}

main().catch((err) => {
  console.error("pi-agent runner failed:", err);
  process.exit(1);
});
