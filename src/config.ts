export type Config = {
  hostName: string;
  openshipUrl: string;
  openshipApiKey: string;
  telegramBotToken: string;
  allowedUserIds: Set<string>;
  allowedChatIds: Set<string>;
  pollIntervalMs: number;
  deploymentPollIntervalMs: number;
  maintenanceRunnerUrl?: string;
  maintenanceRunnerToken?: string;
  patchPaths: { cache: string; branding: string };
  patchProgressIntervalMs: number;
};

const required = (name: string) => {
  const value = Bun.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const ids = (name: string) =>
  new Set(
    (Bun.env[name] ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );

export function loadConfig(): Config {
  const config = {
    hostName: Bun.env.HOST_NAME?.trim() || "OpenShip Host",
    openshipUrl: required("OPENSHIP_URL").replace(/\/$/, ""),
    openshipApiKey: required("OPENSHIP_API_KEY"),
    telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
    allowedUserIds: ids("TELEGRAM_ALLOWED_USER_IDS"),
    allowedChatIds: ids("TELEGRAM_ALLOWED_CHAT_IDS"),
    pollIntervalMs: Number(Bun.env.POLL_INTERVAL_MS ?? 5000),
    deploymentPollIntervalMs: Number(
      Bun.env.DEPLOYMENT_POLL_INTERVAL_MS ?? 10000,
    ),
    maintenanceRunnerUrl: Bun.env.MAINTENANCE_RUNNER_URL?.trim() || undefined,
    maintenanceRunnerToken:
      Bun.env.MAINTENANCE_RUNNER_TOKEN?.trim() || undefined,
    patchPaths: {
      cache:
        Bun.env.PATCH_CACHE_PATH?.trim() ||
        "/root/openship-patches/patch-cache.sh",
      branding:
        Bun.env.PATCH_BRANDING_PATH?.trim() ||
        "/root/openship-branding/patch-branding.sh",
    },
    patchProgressIntervalMs: Number(
      Bun.env.PATCH_PROGRESS_INTERVAL_MS ?? 15_000,
    ),
  } satisfies Config;
  if (config.allowedUserIds.size === 0 && config.allowedChatIds.size === 0)
    throw new Error("Configure at least one allowed Telegram user or chat ID");
  if (config.maintenanceRunnerUrl && !config.maintenanceRunnerToken)
    throw new Error(
      "MAINTENANCE_RUNNER_TOKEN is required when MAINTENANCE_RUNNER_URL is set",
    );
  return config;
}
