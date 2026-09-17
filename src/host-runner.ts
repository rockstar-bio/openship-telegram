import { createHash, timingSafeEqual } from "node:crypto";

import type { PatchAction, PatchPaths } from "./maintenance.ts";

export type HostRunnerConfig = {
  bindAddress: string;
  port: number;
  token: string;
  paths: PatchPaths;
  timeoutMs: number;
};

type ScriptResult = { ok: boolean };
type ScriptExecutor = (
  path: string,
  timeoutMs: number,
) => Promise<ScriptResult>;

const ACTIONS = ["cache", "branding"] as const satisfies readonly PatchAction[];
const MAX_BODY_BYTES = 4096;

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });

function validAction(value: unknown): value is PatchAction {
  return ACTIONS.includes(value as PatchAction);
}

function tokenMatches(received: string, expected: string) {
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(received), hash(expected));
}

/** Do not expose script output: patch scripts may contain operational secrets. */
export function sanitizeOutput(ok: boolean) {
  return ok ? "completed" : "failed";
}

async function executeScript(
  path: string,
  timeoutMs: number,
): Promise<ScriptResult> {
  // The executable is selected only from the fixed action map. No shell,
  // command string, user arguments, or request-controlled executable is used.
  const child = Bun.spawn([path], { stdout: "ignore", stderr: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);
  try {
    const exitCode = await child.exited;
    return { ok: !timedOut && exitCode === 0 };
  } finally {
    clearTimeout(timer);
  }
}

export function createHostRunner(
  config: HostRunnerConfig,
  executor: ScriptExecutor = executeScript,
) {
  let running = false;

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/actions")
      return json({ ok: false, error: "not found" }, 404);

    const authorization = request.headers.get("authorization") ?? "";
    const receivedToken = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";
    if (!receivedToken || !tokenMatches(receivedToken, config.token))
      return json({ ok: false, error: "unauthorized" }, 401);

    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > MAX_BODY_BYTES)
      return json({ ok: false, error: "request too large" }, 413);

    let body: { action?: unknown; path?: unknown };
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES)
        return json({ ok: false, error: "request too large" }, 413);
      body = JSON.parse(raw) as { action?: unknown; path?: unknown };
    } catch {
      return json({ ok: false, error: "invalid request" }, 400);
    }

    if (!validAction(body.action) || body.path !== config.paths[body.action])
      return json({ ok: false, error: "unsupported action" }, 400);
    if (running)
      return json({ ok: false, error: "maintenance job already running" }, 409);

    running = true;
    const started = Date.now();
    try {
      const result = await executor(
        config.paths[body.action],
        config.timeoutMs,
      );
      const durationMs = Date.now() - started;
      return json(
        {
          ok: result.ok,
          action: body.action,
          durationMs,
          output: sanitizeOutput(result.ok),
        },
        result.ok ? 200 : 500,
      );
    } catch {
      return json(
        {
          ok: false,
          action: body.action,
          durationMs: Date.now() - started,
          output: sanitizeOutput(false),
        },
        500,
      );
    } finally {
      running = false;
    }
  };
}

function required(name: string) {
  const value = Bun.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function main() {
  const config: HostRunnerConfig = {
    bindAddress: Bun.env.MAINTENANCE_RUNNER_BIND_ADDRESS?.trim() || "127.0.0.1",
    port: Number(Bun.env.MAINTENANCE_RUNNER_PORT ?? 8787),
    token: required("MAINTENANCE_RUNNER_TOKEN"),
    paths: {
      cache:
        Bun.env.PATCH_CACHE_PATH?.trim() ||
        "/root/openship-patches/patch-cache.sh",
      branding:
        Bun.env.PATCH_BRANDING_PATH?.trim() ||
        "/root/openship-branding/patch-branding.sh",
    },
    timeoutMs: Number(Bun.env.PATCH_RUN_TIMEOUT_MS ?? 15 * 60_000),
  };
  const server = Bun.serve({
    hostname: config.bindAddress,
    port: config.port,
    fetch: createHostRunner(config),
  });
  console.log(
    `OpenShip maintenance runner listening on ${config.bindAddress}:${server.port}`,
  );
}

if (import.meta.main) main();
