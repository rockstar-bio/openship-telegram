import { loadConfig } from "./config.ts";
import { type Json, OpenShipApi } from "./openship.ts";
import { TelegramApi, type TelegramUpdate } from "./telegram.ts";

const config = loadConfig();
const api = new OpenShipApi(config.openshipUrl, config.openshipApiKey);
const telegram = new TelegramApi(config.telegramBotToken);
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
const esc = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

async function projects(chatId: number) {
  const rows = list(await api.projects());
  if (!rows.length) return telegram.sendMessage(chatId, "No projects found.");
  const lines: string[] = [];
  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const project of rows) {
    const services = list(await api.services(id(project)));
    lines.push(`<b>${esc(label(project))}</b> (${esc(id(project))})`);
    for (const service of services) {
      lines.push(`  • ${esc(label(service))} (${esc(id(service))})`);
      buttons.push([
        {
          text: `Restart ${label(service)}`,
          callback_data: `restart|${id(project)}|${id(service)}`,
        },
      ]);
    }
  }
  return telegram.sendMessage(
    chatId,
    lines.join("\n"),
    buttons.length ? { inline_keyboard: buttons } : undefined,
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
    buttons.length ? { inline_keyboard: buttons } : undefined,
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
    for (let i = 0; i < 180; i++) {
      await Bun.sleep(config.deploymentPollIntervalMs);
      const deployment = await api.deployment(deploymentId);
      const status = String(deployment.status ?? "").toLowerCase();
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
    await telegram.answerCallbackQuery(callback.id);
    const [action, first, second] = (callback.data ?? "").split("|");
    if (action === "deploy" && first) await deploy(chatId, first);
    else if (action === "redeploy" && first) {
      const result = await api.redeploy(first);
      await telegram.sendMessage(
        chatId,
        `Redeploy started: <code>${esc(String(result.deployment_id ?? result.id ?? first))}</code>`,
      );
    } else if (action === "restart" && first && second) {
      await api.restartService(first, second);
      await telegram.sendMessage(
        chatId,
        `Restart requested for <code>${esc(second)}</code>.`,
      );
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
  const command = message?.text?.trim().split(/\s+/)[0]?.toLowerCase();
  if (!command) return;
  if (command === "/status") {
    const [health, env] = await Promise.all([api.health(), api.healthEnv()]);
    await telegram.sendMessage(
      chatId,
      `OpenShip: <b>${esc(String(health.status ?? "unknown"))}</b>\nVersion: ${esc(String(env.version ?? "unknown"))}`,
    );
  } else if (command === "/projects") await projects(chatId);
  else if (command === "/deploy" || command === "/redeploy") {
    const rows = list(await api.projects());
    await telegram.sendMessage(chatId, "Choose a project:", {
      inline_keyboard: rows.map((p) => [
        {
          text: `${command === "/deploy" ? "Deploy" : "Redeploy"} ${label(p)}`,
          callback_data: `${command.slice(1)}|${id(p)}`,
        },
      ]),
    });
  } else if (command === "/deployments") await deployments(chatId);
  else if (command === "/help" || command === "/start")
    await telegram.sendMessage(
      chatId,
      "<b>OpenShip controller</b>\n/status — health\n/projects — projects and services\n/deploy — deploy a linked project\n/redeploy — redeploy a project\n/deployments — recent deployments",
    );
}

async function main() {
  log("starting OpenShip Telegram controller");
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
