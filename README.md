# am-pi-agent

agent-manager sandbox runner that drives an LLM via [`pi`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) against Amazon Bedrock using the ECS task role for IAM auth. Built and pushed to ECR by AWS CodeBuild; consumed by the agent-manager api when an agent's `imageUri` points at `agent-manager/sandbox-pi`.

## Repo lives as a submodule

This repo is consumed from the parent agent-manager repo at `sandbox/pi-agent/` as a git submodule.

## Build

Local (when corp network allows):

```
make docker
```

Remote (canonical): push to `main` triggers AWS CodeBuild project `am-pi-agent`, which runs `buildspec.yml`, builds the image and pushes it to `agent-manager/sandbox-pi:latest` and `:<git-sha>` in ECR.

## Runtime contract

The container expects three env vars at start time:

| env | source |
|---|---|
| `TASK_ID` | passed by the api via ECS RunTask container override |
| `MANAGER_URL` | same |
| `BOOTSTRAP_TOKEN` | same |

It calls `POST /v1/bootstrap` on the manager, loads skill bodies via `GET /v1/runs/:runId/skills`, then spawns `pi -p --mode json --provider amazon-bedrock --model <model>` with the assembled system prompt. NDJSON events from pi are forwarded to the manager log endpoint; the agent's final output file (`./.am-out/result.json`) is read at exit and sent to `POST /v1/runs/:runId/complete`.

## Tools available inside the sandbox

`bash`, `read`, `write` (pi built-ins) plus everything in the image: `curl`, `jq`, `python3`, `unzip`, `nuclei`.
