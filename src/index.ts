import { loadConfig } from "./config.ts";
import {
  HttpHostRunner,
  type PatchAction,
  PatchJobManager,
  patchLabel,
} from "./maintenance.ts";
import { type Json, OpenShipApi, type ServerStats } from "./openship.ts";
import { TelegramApi, type TelegramUpdate } from "./telegram.ts";

const config = loadConfig();
const api = new OpenShipApi(config.openshipUrl, config.openshipApiKey);
const telegram = new TelegramApi(config.telegramBotToken);
const maintenanceRunnerUrl = config.maintenanceRunnerUrl;
const maintenanceRunnerToken = config.maintenanceRunnerToken;
const patchJobs =
  maintenanceRunnerUrl && maintenanceRunnerToken
    ? new PatchJobManager(
        new HttpHostRunner(
          maintenanceRunnerUrl,
          maintenanceRunnerToken,
          config.patchPaths,
        ),
      )
    : undefined;
const activeDeployments = new Set<string>();
const log = (message: string, error?: unknown) =>
  console.error(
    new Date().toISOString(),
    message,
    error instanceof Error ? error.message : (error ?? ""),
  );
const list = (value: Json | Json[]): Json[] =>
  Array.isArray(value)
    ? value
    : Array.isArray(value.items)
      ? (value.items as Json[])
      : Array.isArray(value.data)
        ? (value.data as Json[])
        : [value];
const id = (value: Json) =>
  String(value.id ?? value.projectId ?? value.deployment_id ?? "");
const label = (value: Json) =>
  String(value.name ?? value.slug ?? value.serviceName ?? id(value));
const allowed = (userId: number | undefined, chatId: number) =>
  config.allowedUserIds.has(String(userId)) ||
  config.allowedChatIds.has(String(chatId));
const maintenanceAllowed = (userId: number | undefined) =>
  userId !== undefined && config.allowedUserIds.has(String(userId));
const esc = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const duration = (durationMs: number) => `${(durationMs / 1000).toFixed(1)}s`;
const bytes = (value: number) => {
  if (!Number.isFinite(value)) return "unknown";
  const units = ["B", "MB", "GB", "TB"];
  let amount = Math.max(0, value);
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit++;
  }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};
const percent = (used: number, total: number) =>
  total > 0 ? `${((used / total) * 100).toFixed(1)}%` : "unknown";
const uptime = (value: string) => {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return "unknown";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return [days ? `${days}d` : "", hours ? `${hours}h` : "", `${minutes}m`]
    .filter(Boolean)
    .join(" ");
};
const serverRows = (value: Json | Json[]) =>
  Array.isArray(value)
    ? value
    : Array.isArray(value.items)
      ? (value.items as Json[])
      : [value];

const menuKeyboard = {
  inline_keyboard: [
    [
      { text: "📊 Status", callback_data: "menu|status" },
      { text: "📁 Projects", callback_data: "menu|projects" },
    ],
    [
      { text: "🚀 Deploy", callback_data: "menu|deploy" },
      { text: "🔁 Redeploy", callback_data: "menu|redeploy" },
    ],
    [
      { text: "📦 Deployments", callback_data: "menu|deployments" },
      { text: "🛠 Patches", callback_data: "menu|patch" },
    ],
    [
      { text: "🚨 Issues", callback_data: "menu|issues" },
      { text: "🖥 Server", callback_data: "menu|status" },
    ],
    [
      { text: "💾 Backups", callback_data: "menu|backups" },
      { text: "🔄 Updates", callback_data: "menu|updates" },
    ],
    [
      { text: "🌐 Domains", callback_data: "menu|domains" },
      { text: "⏱ Jobs", callback_data: "menu|jobs" },
    ],
    [{ text: "❓ Help", callback_data: "menu|help" }],
  ],
};

const backKeyboard = {
  inline_keyboard: [[{ text: "⬅️ Main menu", callback_data: "menu|home" }]],
};

const patchActions: Record<string, readonly PatchAction[]> = {
  cache: ["cache"],
  branding: ["branding"],
  all: ["cache", "branding"],
};

function patchKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Apply Cache Patch", callback_data: "patch|cache" }],
      [{ text: "Apply Branding Patch", callback_data: "patch|branding" }],
      [{ text: "Apply All Patches", callback_data: "patch|all" }],
      ...backKeyboard.inline_keyboard,
    ],
  };
}

function confirmationKeyboard(action: string) {
  return {
    inline_keyboard: [
      [{ text: "✅ Confirm", callback_data: `patch-confirm|${action}` }],
      [{ text: "Cancel", callback_data: "patch-cancel" }],
    ],
  };
}

function operationConfirmation(action: string, ...values: string[]) {
  return {
    inline_keyboard: [
      [
        {
          text: "✅ Confirm",
          callback_data: ["confirm", action, ...values].join("|"),
        },
      ],
      [{ text: "Cancel", callback_data: "operation-cancel" }],
    ],
  };
}

async function home(chatId: number) {
  return telegram.sendMessage(
    chatId,
    `<b>${esc(config.hostName)}</b>\nChoose an action below or use the / commands menu.`,
    menuKeyboard,
  );
}

async function help(chatId: number) {
  return telegram.sendMessage(
    chatId,
    `<b>${esc(config.hostName)} commands</b>\n\n/status — health and server resources\n/projects — projects, services, logs, and restart buttons\n/issues — current outages and action-required items\n/deploy — deploy a linked project\n/redeploy — redeploy a project\n/deployments — recent deployments and logs\n/backups — backup policies and recent runs\n/updates — available updates\n/domains — domain and SSL status\n/jobs — scheduled jobs and last runs\n/patch — confirmed maintenance patches\n/help — show this help`,
    menuKeyboard,
  );
}

const issueSeverity = (value: unknown) => {
  const severity = String(value ?? "advisory").toLowerCase();
  return severity === "outage"
    ? "🔴"
    : severity.includes("action")
      ? "🟠"
      : "🟡";
};

async function issues(chatId: number) {
  const result = await api.issues();
  const rows = list(result);
  const counts = (result.counts ?? {}) as Json;
  if (!rows.length)
    return telegram.sendMessage(
      chatId,
      "✅ <b>No active issues</b>\nAll monitored projects and services look healthy.",
      backKeyboard,
    );
  const text = rows
    .slice(0, 20)
    .map(
      (issue) =>
        `${issueSeverity(issue.severity)} <b>${esc(String(issue.title ?? issue.name ?? "Issue"))}</b>\n${esc(String(issue.description ?? issue.message ?? "No details"))}`,
    )
    .join("\n\n");
  return telegram.sendMessage(
    chatId,
    `🚨 <b>Issues</b>\nOutage: ${esc(String(counts.outage ?? "?"))} · Action required: ${esc(String(counts.actionRequired ?? "?"))} · Advisory: ${esc(String(counts.advisory ?? "?"))}\n\n${text}`,
    backKeyboard,
  );
}

async function updates(chatId: number) {
  const rows = list(await api.updates());
  if (!rows.length)
    return telegram.sendMessage(
      chatId,
      "✅ No update information available.",
      backKeyboard,
    );
  const text = rows
    .slice(0, 20)
    .map(
      (row) =>
        `${row.behind || row.updateAvailable || row.available ? "🔄" : "✅"} <b>${esc(label(row))}</b> — ${esc(String(row.status ?? row.version ?? (row.behind ? "update available" : "current")))}`,
    )
    .join("\n");
  const buttons = rows
    .filter(
      (row) =>
        row.projectId && (row.behind || row.updateAvailable || row.available),
    )
    .slice(0, 10)
    .map((row) => [
      {
        text: `✅ Apply ${label(row)}`,
        callback_data: `update|${String(row.projectId)}`,
      },
    ]);
  return telegram.sendMessage(
    chatId,
    `🔄 <b>Updates</b>\n\n${text}\n\nUse the dashboard to apply project updates safely.`,
    { inline_keyboard: [...buttons, ...backKeyboard.inline_keyboard] },
  );
}

async function domains(chatId: number) {
  const rows = list(await api.domains());
  if (!rows.length)
    return telegram.sendMessage(chatId, "🌐 No domains found.", backKeyboard);
  const text = rows
    .slice(0, 30)
    .map(
      (row) =>
        `${(row.ssl as Json | undefined)?.enabled || row.sslStatus === "valid" ? "🔒" : "🌐"} <b>${esc(String(row.hostname ?? row.domain ?? label(row)))}</b>\nVerified: ${esc(String(row.verified ?? row.status ?? "unknown"))} · SSL: ${esc(String(row.sslStatus ?? row.certificateStatus ?? "unknown"))}`,
    )
    .join("\n\n");
  return telegram.sendMessage(
    chatId,
    `🌐 <b>Domains</b>\n\n${text}`,
    backKeyboard,
  );
}

async function jobs(chatId: number) {
  const rows = list(await api.jobs());
  if (!rows.length)
    return telegram.sendMessage(
      chatId,
      "⏱ No scheduled jobs found.",
      backKeyboard,
    );
  const text = rows
    .slice(0, 30)
    .map(
      (row) =>
        `${row.enabled === false ? "⏸" : "⏱"} <b>${esc(String(row.label ?? row.key ?? label(row)))}</b>\nNext: ${esc(String(row.nextRunAt ?? "manual"))} · Last: ${esc(String((row.lastRun as Json | undefined)?.status ?? "none"))}`,
    )
    .join("\n\n");
  return telegram.sendMessage(
    chatId,
    `⏱ <b>Scheduled jobs</b>\n\n${text}`,
    backKeyboard,
  );
}

async function backups(chatId: number) {
  const projectsRows = list(await api.projects());
  if (!projectsRows.length)
    return telegram.sendMessage(chatId, "💾 No projects found.", backKeyboard);
  const lines: string[] = [];
  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const project of projectsRows.slice(0, 10)) {
    const [policies, runs] = await Promise.all([
      api.projectBackupPolicies(id(project)).catch(() => [] as Json[]),
      api.projectBackupRuns(id(project)).catch(() => [] as Json[]),
    ]);
    const policyRows = list(policies);
    const runRows = list(runs);
    const last = runRows[0];
    lines.push(
      `<b>${esc(label(project))}</b>\nPolicies: ${policyRows.length} · Last run: ${esc(String(last?.status ?? "none"))}`,
    );
    for (const policy of policyRows.slice(0, 3)) {
      if (policy.id) {
        buttons.push([
          {
            text: `▶️ Run backup: ${String(policy.name ?? policy.id)}`,
            callback_data: `backup|${String(policy.id)}`,
          },
        ]);
      }
    }
  }
  return telegram.sendMessage(
    chatId,
    `💾 <b>Backups</b>\n\n${lines.join("\n\n")}\n\nBackup execution is intentionally kept behind explicit confirmation.`,
    { inline_keyboard: [...buttons, ...backKeyboard.inline_keyboard] },
  );
}

async function status(chatId: number) {
  const [health, env, serverResponse] = await Promise.all([
    api.health(),
    api.healthEnv(),
    api.servers(),
  ]);
  const server =
    serverRows(serverResponse).find((row) => row.isLocal) ??
    serverRows(serverResponse)[0];
  let stats: ServerStats | undefined;
  if (server?.id) {
    stats = await api.serverStats(String(server.id)).catch(() => undefined);
  }
  const statsText = stats
    ? `\n\n<b>Server resources</b>\nCPU: <b>${esc(String(stats.cpu))}%</b>\nMemory: <b>${bytes(stats.memUsed)}</b> / ${bytes(stats.memTotal)} (${percent(stats.memUsed, stats.memTotal)})\nDisk: <b>${bytes(stats.diskUsed)}</b> / ${bytes(stats.diskTotal)} (${percent(stats.diskUsed, stats.diskTotal)})\nDisk free: <b>${bytes(stats.diskAvail)}</b>\nUptime: <b>${esc(uptime(stats.uptime))}</b>\nLoad: <b>${esc(stats.load1)} / ${esc(stats.load5)} / ${esc(stats.load15)}</b>`
    : "\n\n<b>Server resources</b>\nMetrics unavailable.";
  const connectionText = server
    ? `\nConnected server: <b>${esc(String(server.name ?? "local server"))}</b>\nProjects: <b>${esc(String(server.projectCount ?? "unknown"))}</b>\nHost channel: <b>${server.hostChannel && (server.hostChannel as Json).ok ? "connected" : "unknown"}</b>`
    : "";
  return telegram.sendMessage(
    chatId,
    `📊 <a href="${esc(config.openshipUrl)}"><b>${esc(config.hostName)} status</b></a>\nHealth: <b>${esc(String(health.status ?? "unknown"))}</b>\nVersion: <b>${esc(String(env.version ?? "unknown"))}</b>${connectionText}${statsText}`,
    backKeyboard,
  );
}

async function chooseProject(chatId: number, command: "/deploy" | "/redeploy") {
  const rows = list(await api.projects());
  if (!rows.length)
    return telegram.sendMessage(chatId, "No projects found.", backKeyboard);
  return telegram.sendMessage(chatId, "Choose a project:", {
    inline_keyboard: [
      ...rows.map((p) => [
        {
          text: `${command === "/deploy" ? "🚀 Deploy" : "🔁 Redeploy"} ${label(p)}`,
          callback_data: `${command.slice(1)}|${id(p)}`,
        },
      ]),
      ...backKeyboard.inline_keyboard,
    ],
  });
}

async function showPatches(chatId: number, userId: number | undefined) {
  if (!maintenanceAllowed(userId)) return;
  if (!patchJobs) {
    await telegram.sendMessage(
      chatId,
      "Maintenance is not configured. Set MAINTENANCE_RUNNER_URL and MAINTENANCE_RUNNER_TOKEN.",
      backKeyboard,
    );
  } else if (patchJobs.isRunning) {
    await telegram.sendMessage(
      chatId,
      "A patch job is already running.",
      backKeyboard,
    );
  } else {
    await telegram.sendMessage(
      chatId,
      "Choose a maintenance action:",
      patchKeyboard(),
    );
  }
}

async function updatePatchMessage(
  chatId: number,
  messageId: number | undefined,
  text: string,
) {
  if (messageId !== undefined) {
    await telegram
      .editMessageText(chatId, messageId, text)
      .catch(() => undefined);
  } else {
    await telegram.sendMessage(chatId, text);
  }
}

async function executePatches(
  chatId: number,
  messageId: number | undefined,
  actions: readonly PatchAction[],
) {
  if (!patchJobs) {
    await updatePatchMessage(
      chatId,
      messageId,
      "Maintenance is not configured. Set MAINTENANCE_RUNNER_URL and MAINTENANCE_RUNNER_TOKEN.",
    );
    return;
  }
  const started = Date.now();
  let ticker: Timer | undefined;
  try {
    ticker = setInterval(() => {
      void updatePatchMessage(
        chatId,
        messageId,
        `🛠 Maintenance is still running… (${duration(Date.now() - started)})`,
      );
    }, config.patchProgressIntervalMs);
    await patchJobs.run(actions, (progress) =>
      updatePatchMessage(chatId, messageId, `🛠 ${esc(progress)}`),
    );
    await updatePatchMessage(
      chatId,
      messageId,
      `✅ Patch job completed successfully in <b>${duration(Date.now() - started)}</b>.`,
    );
  } catch (error) {
    await updatePatchMessage(
      chatId,
      messageId,
      `❌ Patch job failed after <b>${duration(Date.now() - started)}</b>. The remaining actions were not run.`,
    );
    log("patch job failed", error);
  } finally {
    if (ticker) clearInterval(ticker);
  }
}

async function projects(chatId: number) {
  const rows = list(await api.projects());
  if (!rows.length) return telegram.sendMessage(chatId, "No projects found.");
  const lines: string[] = [];
  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const project of rows) {
    const services = list(await api.services(id(project)));
    lines.push(`<b>${esc(label(project))}</b> (${esc(id(project))})`);
    buttons.push([
      {
        text: `📋 Details ${label(project)}`,
        callback_data: `project|${id(project)}`,
      },
    ]);
    for (const service of services) {
      lines.push(`  • ${esc(label(service))} (${esc(id(service))})`);
      buttons.push([
        {
          text: `🔄 Restart ${label(service)}`,
          callback_data: `restart|${id(project)}|${id(service)}`,
        },
        {
          text: `📜 Logs ${label(service)}`,
          callback_data: `service-logs|${id(project)}|${id(service)}`,
        },
      ]);
    }
  }
  return telegram.sendMessage(chatId, lines.join("\n"), {
    inline_keyboard: [...buttons, ...backKeyboard.inline_keyboard],
  });
}

async function projectDetails(chatId: number, projectId: string) {
  const [project, services, deployments] = await Promise.all([
    api
      .projects()
      .then((value) => list(value).find((row) => id(row) === projectId)),
    api.services(projectId),
    api.deployments(projectId),
  ]);
  if (!project)
    return telegram.sendMessage(chatId, "Project not found.", backKeyboard);
  const latest = list(deployments)[0];
  const serviceRows = list(services);
  return telegram.sendMessage(
    chatId,
    `📁 <b>${esc(label(project))}</b>\nStatus: <b>${esc(String(project.status ?? "configured"))}</b>\nBranch: ${esc(String(project.gitBranch ?? "unknown"))}\nURL: ${esc(String(project.url ?? project.favicon ?? "not configured"))}\nLatest deployment: ${esc(String(latest?.status ?? "none"))}\nServices: ${serviceRows.length}`,
    {
      inline_keyboard: [
        ...serviceRows.map((service) => [
          {
            text: `📜 ${label(service)} logs`,
            callback_data: `service-logs|${projectId}|${id(service)}`,
          },
        ]),
        [{ text: "🚀 Deploy", callback_data: `deploy|${projectId}` }],
        ...backKeyboard.inline_keyboard,
      ],
    },
  );
}

async function serviceLogs(
  chatId: number,
  projectId: string,
  serviceId: string,
) {
  const result = await api.serviceLogs(projectId, serviceId);
  const text =
    typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return telegram.sendMessage(
    chatId,
    `📜 <b>Service logs</b>\n<pre>${esc(text).slice(-3800)}</pre>`,
    backKeyboard,
  );
}

async function deployments(chatId: number) {
  const rows = list(await api.deployments());
  const buttons = rows
    .slice(0, 20)
    .map((d) => [
      { text: `Status ${label(d)}`, callback_data: `details|${id(d)}` },
    ]);
  return telegram.sendMessage(
    chatId,
    rows.length
      ? rows
          .slice(0, 20)
          .map(
            (d) =>
              `${esc(label(d))} — <b>${esc(String(d.status ?? "unknown"))}</b> (${esc(id(d))})`,
          )
          .join("\n")
      : "No deployments found.",
    {
      inline_keyboard: [...buttons, ...backKeyboard.inline_keyboard],
    },
  );
}
async function deploy(chatId: number, projectId: string) {
  const result = await api.deploy(projectId);
  const deploymentId = String(result.deployment_id ?? result.id ?? "");
  await telegram.sendMessage(
    chatId,
    `Deployment started: <code>${esc(deploymentId)}</code>`,
  );
  if (deploymentId) void watchDeployment(chatId, deploymentId);
}
async function watchDeployment(chatId: number, deploymentId: string) {
  if (activeDeployments.has(deploymentId)) return;
  activeDeployments.add(deploymentId);
  try {
    let lastProgress = "";
    for (let i = 0; i < 180; i++) {
      await Bun.sleep(config.deploymentPollIntervalMs);
      const deployment = await api.deployment(deploymentId);
      const status = String(deployment.status ?? "").toLowerCase();
      if (
        i % 3 === 0 &&
        ![
          "success",
          "succeeded",
          "failed",
          "error",
          "cancelled",
          "partial_failure",
        ].includes(status)
      ) {
        const build = (await api
          .deploymentBuild(deploymentId)
          .catch(() => ({}))) as Json;
        const progress = `${status || "running"}${build.currentStep ? ` · ${String(build.currentStep)}` : ""}${build.progress !== undefined ? ` · ${String(build.progress)}%` : ""}`;
        if (progress !== lastProgress) {
          lastProgress = progress;
          await telegram.sendMessage(
            chatId,
            `⏳ Deployment <code>${esc(deploymentId)}</code>\n${esc(progress)}`,
          );
        }
      }
      if (
        [
          "success",
          "succeeded",
          "failed",
          "error",
          "cancelled",
          "partial_failure",
        ].includes(status)
      ) {
        await telegram.sendMessage(
          chatId,
          `${status === "success" || status === "succeeded" ? "✅" : "❌"} Deployment <code>${esc(deploymentId)}</code>: <b>${esc(status)}</b>`,
        );
        return;
      }
    }
  } catch (error) {
    log(`deployment watcher ${deploymentId}`, error);
  } finally {
    activeDeployments.delete(deploymentId);
  }
}

async function handle(update: TelegramUpdate) {
  const message = update.message;
  const callback = update.callback_query;
  const chatId = message?.chat.id ?? callback?.message?.chat.id;
  const userId = message?.from?.id ?? callback?.from.id;
  if (!chatId || !allowed(userId, chatId)) {
    if (callback)
      await telegram.answerCallbackQuery(callback.id, "Not authorized");
    return;
  }
  if (callback) {
    const isMaintenanceCallback =
      callback.data?.startsWith("patch") || callback.data === "menu|patch";
    if (isMaintenanceCallback && !maintenanceAllowed(userId)) {
      await telegram.answerCallbackQuery(
        callback.id,
        "Not authorized for maintenance",
      );
      return;
    }
    await telegram.answerCallbackQuery(callback.id);
    const [action, first, second] = (callback.data ?? "").split("|");
    if (action === "menu" && first === "home") await home(chatId);
    else if (action === "menu" && first === "help") await help(chatId);
    else if (action === "menu" && first === "status") await status(chatId);
    else if (action === "menu" && first === "projects") await projects(chatId);
    else if (action === "menu" && first === "deploy")
      await chooseProject(chatId, "/deploy");
    else if (action === "menu" && first === "redeploy")
      await chooseProject(chatId, "/redeploy");
    else if (action === "menu" && first === "deployments")
      await deployments(chatId);
    else if (action === "menu" && first === "issues") await issues(chatId);
    else if (action === "menu" && first === "backups") await backups(chatId);
    else if (action === "menu" && first === "updates") await updates(chatId);
    else if (action === "menu" && first === "domains") await domains(chatId);
    else if (action === "menu" && first === "jobs") await jobs(chatId);
    else if (action === "menu" && first === "patch")
      await showPatches(chatId, userId);
    else if (action === "patch" && first && patchActions[first]) {
      if (!patchJobs) {
        await telegram.sendMessage(
          chatId,
          "Maintenance is not configured. Set MAINTENANCE_RUNNER_URL and MAINTENANCE_RUNNER_TOKEN.",
        );
      } else if (patchJobs.isRunning) {
        await telegram.sendMessage(chatId, "A patch job is already running.");
      } else {
        const names = patchActions[first].map(patchLabel).join(" then ");
        const confirmation = `Confirm maintenance action: <b>${esc(names)}</b>?`;
        if (callback.message) {
          await telegram.editMessageText(
            chatId,
            callback.message.message_id,
            confirmation,
            confirmationKeyboard(first),
          );
        } else {
          await telegram.sendMessage(
            chatId,
            confirmation,
            confirmationKeyboard(first),
          );
        }
      }
    } else if (action === "patch-confirm" && first && patchActions[first]) {
      if (patchJobs?.isRunning) {
        await telegram.sendMessage(chatId, "A patch job is already running.");
      } else {
        void executePatches(
          chatId,
          callback.message?.message_id,
          patchActions[first],
        );
      }
    } else if (action === "patch-cancel") {
      await updatePatchMessage(
        chatId,
        callback.message?.message_id,
        "Maintenance cancelled.",
      );
    } else if (action === "project" && first)
      await projectDetails(chatId, first);
    else if (action === "service-logs" && first && second)
      await serviceLogs(chatId, first, second);
    else if (action === "update" && first) {
      await telegram.sendMessage(
        chatId,
        "Confirm applying this project update? OpenShip may create a backup and redeploy the project.",
        operationConfirmation("update", first),
      );
    } else if (action === "confirm" && first === "update" && second) {
      const result = await api.applyUpdate(second);
      await telegram.sendMessage(
        chatId,
        `🔄 Update started: <code>${esc(String(result.deployment_id ?? result.id ?? second))}</code>`,
      );
    } else if (action === "backup" && first) {
      await telegram.sendMessage(
        chatId,
        "Confirm starting this backup now?",
        operationConfirmation("backup", first),
      );
    } else if (action === "confirm" && first === "backup" && second) {
      const result = await api.runBackup(second);
      await telegram.sendMessage(
        chatId,
        `💾 Backup started: <code>${esc(String(result.id ?? result.runId ?? second))}</code>`,
      );
    } else if (action === "deploy" && first) {
      await telegram.sendMessage(
        chatId,
        "Confirm starting a new deployment?",
        operationConfirmation("deploy", first),
      );
    } else if (action === "redeploy" && first) {
      await telegram.sendMessage(
        chatId,
        "Confirm redeploying this project?",
        operationConfirmation("redeploy", first),
      );
    } else if (action === "confirm" && first === "deploy" && second)
      await deploy(chatId, second);
    else if (action === "confirm" && first === "redeploy" && second) {
      const result = await api.redeploy(second);
      const deploymentId = String(result.deployment_id ?? result.id ?? second);
      await telegram.sendMessage(
        chatId,
        `Redeploy started: <code>${esc(deploymentId)}</code>`,
      );
      void watchDeployment(chatId, deploymentId);
    } else if (action === "restart" && first && second) {
      await telegram.sendMessage(
        chatId,
        "Confirm restarting this service?",
        operationConfirmation("restart", first, second),
      );
    } else if (
      action === "confirm" &&
      first === "restart" &&
      second &&
      callback.data?.split("|")[2]
    ) {
      const serviceId = callback.data.split("|")[2];
      await api.restartService(second, serviceId);
      await telegram.sendMessage(
        chatId,
        `✅ Restart requested for <code>${esc(serviceId)}</code>.`,
      );
    } else if (action === "operation-cancel") {
      await telegram.sendMessage(chatId, "Action cancelled.", backKeyboard);
    } else if (action === "details" && first) {
      const [deployment, logs] = await Promise.all([
        api.deployment(first),
        api.deploymentLogs(first),
      ]);
      await telegram.sendMessage(
        chatId,
        `<b>Deployment ${esc(first)}</b>\nStatus: ${esc(String(deployment.status ?? "unknown"))}\n<pre>${esc(typeof logs === "string" ? logs : JSON.stringify(logs, null, 2)).slice(-3500)}</pre>`,
      );
    }
    return;
  }
  const command = message?.text
    ?.trim()
    .split(/\s+/)[0]
    ?.toLowerCase()
    .split("@")[0];
  if (!command) return;
  if (command === "/status") await status(chatId);
  else if (command === "/projects") await projects(chatId);
  else if (command === "/issues") await issues(chatId);
  else if (command === "/deploy" || command === "/redeploy")
    await chooseProject(chatId, command);
  else if (command === "/deployments") await deployments(chatId);
  else if (command === "/backups") await backups(chatId);
  else if (command === "/updates") await updates(chatId);
  else if (command === "/domains") await domains(chatId);
  else if (command === "/jobs") await jobs(chatId);
  else if (command === "/patch") await showPatches(chatId, userId);
  else if (command === "/help") await help(chatId);
  else if (command === "/start" || command === "/menu") await home(chatId);
}

async function main() {
  log("starting OpenShip Telegram controller");
  await telegram
    .setMyCommands([
      { command: "start", description: "Open the main menu" },
      { command: "status", description: "Check host health" },
      { command: "projects", description: "View projects and services" },
      { command: "issues", description: "View active issues" },
      { command: "deploy", description: "Deploy a linked project" },
      { command: "redeploy", description: "Redeploy a project" },
      { command: "deployments", description: "View recent deployments" },
      { command: "backups", description: "View backup status" },
      { command: "updates", description: "View available updates" },
      { command: "domains", description: "View domains and SSL" },
      { command: "jobs", description: "View scheduled jobs" },
      { command: "patch", description: "Run confirmed maintenance patches" },
      { command: "help", description: "Show command help" },
    ])
    .catch((error) => log("could not register Telegram commands", error));
  while (true) {
    try {
      for (const update of await telegram.updates()) {
        try {
          await handle(update);
        } catch (error) {
          log("update failed", error);
          const chatId =
            update.message?.chat.id ?? update.callback_query?.message?.chat.id;
          if (chatId)
            await telegram
              .sendMessage(chatId, "Request failed. Check controller logs.")
              .catch(() => undefined);
        }
      }
    } catch (error) {
      log("poll failed", error);
      await Bun.sleep(config.pollIntervalMs);
    }
  }
}
main().catch((error) => {
  log("fatal", error);
  process.exit(1);
});
