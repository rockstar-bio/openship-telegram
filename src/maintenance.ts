export type PatchAction = "cache" | "branding";

export const PATCH_ACTIONS = [
  "cache",
  "branding",
] as const satisfies readonly PatchAction[];

export type PatchPaths = Record<PatchAction, string>;

export type PatchProgress = (message: string) => void | Promise<void>;

export type PatchResult = {
  durationMs: number;
};

export interface HostRunner {
  run(action: PatchAction): Promise<void>;
}

const actionLabel = (action: PatchAction) =>
  action === "cache" ? "Cache Patch" : "Branding Patch";

export function patchLabel(action: PatchAction) {
  return actionLabel(action);
}

function isPatchAction(value: unknown): value is PatchAction {
  return PATCH_ACTIONS.includes(value as PatchAction);
}

/**
 * Client for a separate, privileged host-runner service.
 *
 * This process never executes the configured paths. The host runner must
 * independently allowlist both the action and its path before executing it.
 */
export class HttpHostRunner implements HostRunner {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly paths: PatchPaths,
    private readonly timeoutMs = 15 * 60_000,
  ) {}

  async run(action: PatchAction): Promise<void> {
    if (!isPatchAction(action))
      throw new Error("Unsupported maintenance action");
    const response = await fetch(`${this.baseUrl}/v1/actions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action, path: this.paths[action] }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Host runner returned HTTP ${response.status}`);
    }
  }
}

export class PatchJobManager {
  private running = false;

  constructor(private readonly runner: HostRunner) {}

  get isRunning() {
    return this.running;
  }

  async run(
    actions: readonly PatchAction[],
    onProgress: PatchProgress,
  ): Promise<PatchResult> {
    if (this.running) throw new Error("A maintenance job is already running");
    if (!actions.length) throw new Error("No maintenance actions requested");

    this.running = true;
    const started = Date.now();
    try {
      for (const action of actions) {
        await onProgress(`Starting ${actionLabel(action)}…`);
        await this.runner.run(action);
        await onProgress(`${actionLabel(action)} complete.`);
      }
      return { durationMs: Date.now() - started };
    } finally {
      this.running = false;
    }
  }
}
