import { runPi } from "./pi.js";
import { startMonitor } from "./sdk/src/monitor.js";
import { ManagerClient } from "./sdk/src/sdk.js";
import { buildSkillsContext } from "./sdk/src/skills.js";

async function main(): Promise<void> {
  const TASK_ID = process.env.TASK_ID;
  const MANAGER_URL = process.env.MANAGER_URL;
  const BOOTSTRAP_TOKEN = process.env.BOOTSTRAP_TOKEN;
  if (!TASK_ID || !MANAGER_URL || !BOOTSTRAP_TOKEN) {
    console.error("missing required env: TASK_ID, MANAGER_URL, BOOTSTRAP_TOKEN");
    process.exit(2);
  }

  const { client, bootstrap } = await ManagerClient.bootstrap({
    TASK_ID,
    MANAGER_URL,
    BOOTSTRAP_TOKEN,
  });

  const payload = bootstrap.task.payload as Record<string, unknown>;
  const prompt = payload.prompt;
  const workdir = "/work";

  const monitor = startMonitor({
    client,
    taskId: TASK_ID,
    workdir,
    heartbeatMs: 30_000,
    stallMs: 180_000,
    onStall: (idleMs) => {
      console.error(`[monitor] child stalled for ${idleMs}ms; killing`);
    },
  });

  let fullPrompt = "";
  let runResult: Record<string, unknown> | undefined;
  let runError: { code: string; message: string; detail?: Record<string, unknown> } | undefined;
  let stalled = false;

  monitor.bindStallKill(() => {
    stalled = true;
  });

  const finalize = async (): Promise<void> => {
    try {
      await monitor.finalize({
        systemPrompt: fullPrompt,
        payload,
        ...(runResult !== undefined ? { result: runResult } : {}),
        ...(runError !== undefined
          ? { error: { code: runError.code, message: runError.message } }
          : {}),
      });
    } catch {
      /* finalize is best effort */
    }
  };

  let signalled = false;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      if (signalled) return;
      signalled = true;
      void (async () => {
        runError = runError ?? { code: "internal.signal", message: `received ${sig}` };
        await finalize();
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
    if (typeof prompt === "string" && prompt.length > 0) {
      const skills = await client.loadSkills();
      const skillsContext = buildSkillsContext(skills);
      fullPrompt = `${bootstrap.soulMd}${skillsContext}\n\n# Task\n\n${prompt}`.trimStart();
      const out = await runPi({
        client,
        bootstrap,
        prompt: fullPrompt,
        payload,
        workdir,
        monitor,
      });
      if (stalled) {
        runError = {
          code: "agent.stalled",
          message: "child produced no output within stall window; killed by watchdog",
        };
      } else if (out.error) {
        runError = out.error;
      } else {
        runResult = out.result ?? { ok: true };
      }
    } else {
      runResult = { ok: true, echo: payload };
    }
  } catch (err) {
    const e = err as Error;
    runError = { code: "internal.error", message: e.message };
  }

  // Order: stop timers, upload artifacts, then close out the task. Artifact
  // upload still works while the run JWT is alive; complete/fail revokes it,
  // so do uploads first.
  monitor.stop();
  await finalize();

  if (runError) {
    try {
      await client.fail({ code: runError.code, message: runError.message });
    } catch {
      /* swallow */
    }
    process.exit(1);
  } else {
    try {
      await client.complete(runResult ?? { ok: true });
    } catch {
      /* swallow */
    }
  }
}

main().catch((err) => {
  console.error("pi-agent runner failed:", err);
  process.exit(1);
});
