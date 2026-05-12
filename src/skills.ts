// Story 18-1e: prompt assembly helpers for skill bodies fetched from the
// manager. We deliberately ship a tiny inline helper rather than reusing the
// api parser; the sandbox does not depend on api source.

import type { LoadedSkill, ManagerClient } from "./sdk.js";

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/** Strip a leading `--- ... ---` YAML frontmatter block, if any. */
export function stripFrontmatter(body: string): string {
  return body.replace(FRONTMATTER_RE, "");
}

/**
 * Build a Level 2 disclosure block: one `# Skill: name@version` heading per
 * loaded skill, followed by its body with the frontmatter stripped. Allowlist
 * only skills (body null) are skipped silently.
 */
/**
 * Story 18-1f: optional helper that the runner can call per skill that has an
 * `assetsRef`. The current implementation is a no-op intentionally: staging
 * asset bytes onto the sandbox workdir requires a per-runner directory layout
 * decision that is out of scope for 18-1f. The SDK helper
 * (`ManagerClient.loadSkillAsset`) exists so the next story can wire actual
 * staging without touching the api side.
 */
export async function fetchAssetsForSkill(
  _skill: LoadedSkill,
  _client: Pick<ManagerClient, "loadSkillAsset">,
): Promise<void> {
  // Intentional no-op. See doc comment.
}

export function buildSkillsContext(skills: LoadedSkill[]): string {
  let out = "";
  for (const s of skills) {
    if (!s.body) continue;
    const stripped = stripFrontmatter(s.body);
    out += `\n\n# Skill: ${s.name}@${s.version}\n\n${stripped}`;
  }
  return out;
}
