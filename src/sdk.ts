// Typed client for sandboxes to call the manager API.
// Knows nothing except TASK_ID, MANAGER_URL, BOOTSTRAP_TOKEN at start.

// Story 18-1e: a single resolved skill returned by the manager runtime route.
export interface LoadedSkill {
  name: string;
  version: string;
  status: string;
  body: string | null;
  frontmatter: { name?: string; description?: string; whenToUse?: string } | null;
  assetsRef: string | null;
}

export interface BootstrapResponse {
  runId: string;
  runCredential: string;
  runCredentialExpiresAt: string;
  task: {
    id: string;
    agentId: string;
    payload: Record<string, unknown>;
    parentTaskId: string | null;
  };
  agent: { id: string; name: string; version: string; imageUri: string };
  enabledSkills: { name: string; version: string }[];
  soulMd: string;
  secrets: Record<string, string>;
  uploadHints: { artifacts: string; logs: string };
}

// Story 18-1f: typed error so callers can branch on missing assets without
// parsing fetch error strings.
export class SkillAssetNotFoundError extends Error {
  constructor(
    public readonly skillName: string,
    public readonly skillVersion: string,
    public readonly path: string,
  ) {
    super(`skill asset not found: ${skillName}@${skillVersion}/${path}`);
    this.name = "SkillAssetNotFoundError";
  }
}

export class ManagerClient {
  private constructor(
    public readonly managerUrl: string,
    private readonly runCredential: string,
    public readonly runId: string,
    public readonly taskId: string,
  ) {}

  static async bootstrap(env: {
    TASK_ID: string;
    MANAGER_URL: string;
    BOOTSTRAP_TOKEN: string;
  }): Promise<{
    client: ManagerClient;
    bootstrap: BootstrapResponse;
  }> {
    // Story 15.5: bootstrap takes no body. Sending content-type without a
    // body trips Fastify's `FST_ERR_CTP_EMPTY_JSON_BODY` and the api returns
    // 500. Drop content-type from this request.
    const r = await fetch(`${env.MANAGER_URL.replace(/\/$/, "")}/v1/bootstrap`, {
      method: "POST",
      headers: { "x-bootstrap-token": env.BOOTSTRAP_TOKEN },
    });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`bootstrap failed: ${r.status} ${text}`);
    }
    const body = (await r.json()) as BootstrapResponse;
    if (body.task.id !== env.TASK_ID) {
      throw new Error(`bootstrap returned mismatched task id: ${body.task.id} != ${env.TASK_ID}`);
    }
    const client = new ManagerClient(env.MANAGER_URL, body.runCredential, body.runId, body.task.id);
    return { client, bootstrap: body };
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { authorization: `Bearer ${this.runCredential}`, ...(extra ?? {}) };
  }

  // Story 18-1e: fetch the resolved skills manifest with bodies. Asset bytes
  // are not served yet; assetsRef is always null until 18-1f.
  async loadSkills(): Promise<LoadedSkill[]> {
    const r = await fetch(this.url(`/v1/runs/${this.runId}/skills`), {
      headers: this.headers(),
    });
    if (!r.ok) throw new Error(`loadSkills failed: ${r.status}`);
    const body = (await r.json()) as { items: LoadedSkill[] };
    return body.items;
  }

  async getSecret(key: string): Promise<string | undefined> {
    const r = await fetch(this.url(`/v1/runs/${this.runId}/secrets/${encodeURIComponent(key)}`), {
      headers: this.headers(),
    });
    if (r.status === 404) return undefined;
    if (!r.ok) throw new Error(`getSecret failed: ${r.status}`);
    const body = (await r.json()) as { value: string };
    return body.value;
  }

  // Story 18-1f: fetch a single skill asset file as bytes. The api gates the
  // request by manifest membership; non members surface as 404. Callers that
  // want to stage a tree should call this per file from the loaded skill's
  // assetsRef listing (a future story will add a manifest aware tree helper).
  async loadSkillAsset(opts: {
    name: string;
    version: string;
    path: string;
  }): Promise<Buffer> {
    const segs = opts.path
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/");
    const r = await fetch(
      this.url(
        `/v1/runs/${this.runId}/skills/${encodeURIComponent(opts.name)}/${encodeURIComponent(
          opts.version,
        )}/assets/${segs}`,
      ),
      { headers: this.headers() },
    );
    if (r.status === 404) {
      throw new SkillAssetNotFoundError(opts.name, opts.version, opts.path);
    }
    if (!r.ok) {
      throw new Error(`loadSkillAsset failed: ${r.status}`);
    }
    const ab = await r.arrayBuffer();
    return Buffer.from(ab);
  }

  async uploadArtifact(
    key: string,
    body: Buffer | Uint8Array,
    contentType = "application/octet-stream",
  ): Promise<void> {
    const r = await fetch(this.url(`/v1/runs/${this.runId}/artifacts/${encodeURIComponent(key)}`), {
      method: "PUT",
      headers: this.headers({ "content-type": contentType }),
      body,
    });
    if (!r.ok) throw new Error(`uploadArtifact failed: ${r.status}`);
  }

  async pushLogs(
    events: { ts: string; level: string; message: string; [k: string]: unknown }[],
  ): Promise<void> {
    const body = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
    const r = await fetch(this.url(`/v1/runs/${this.runId}/logs`), {
      method: "POST",
      headers: this.headers({ "content-type": "application/x-ndjson" }),
      body,
    });
    if (!r.ok) throw new Error(`pushLogs failed: ${r.status}`);
  }

  async complete(results: Record<string, unknown>): Promise<void> {
    const r = await fetch(this.url(`/v1/runs/${this.runId}/complete`), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ results }),
    });
    if (!r.ok) throw new Error(`complete failed: ${r.status}`);
  }

  async fail(error: {
    code: string;
    message: string;
    detail?: Record<string, unknown>;
  }): Promise<void> {
    const r = await fetch(this.url(`/v1/runs/${this.runId}/fail`), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(error),
    });
    if (!r.ok) throw new Error(`fail failed: ${r.status}`);
  }

  private url(path: string): string {
    return `${this.managerUrl.replace(/\/$/, "")}${path}`;
  }
}
