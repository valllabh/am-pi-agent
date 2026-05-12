import { runPi } from "./pi.js";
import { ManagerClient } from "./sdk.js";
import { buildSkillsContext } from "./skills.js";

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

  try {
    if (typeof prompt === "string" && prompt.length > 0) {
      const skills = await client.loadSkills();
      const skillsContext = buildSkillsContext(skills);
      const fullPrompt = `${bootstrap.soulMd}${skillsContext}\n\n# Task\n\n${prompt}`.trimStart();
      await runPi({ client, bootstrap, prompt: fullPrompt, payload });
    } else {
      await client.pushLogs([
        {
          ts: new Date().toISOString(),
          level: "info",
          message: "pi-agent booted (no-op echo)",
          taskId: bootstrap.task.id,
        },
      ]);
      await client.complete({ ok: true, echo: bootstrap.task.payload });
    }
  } catch (err) {
    const e = err as Error;
    try {
      await client.fail({ code: "internal.error", message: e.message });
    } catch {
      /* swallow */
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("pi-agent runner failed:", err);
  process.exit(1);
});
