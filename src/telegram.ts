export type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    from?: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number };
    message?: { message_id: number; chat: { id: number } };
  };
};
type ApiResponse<T> = { ok: boolean; result: T; description?: string };
export type TelegramMessage = { message_id: number };
export type TelegramCommand = { command: string; description: string };

export class TelegramApi {
  private offset = 0;
  constructor(private readonly token: string) {}
  private async call<T>(
    method: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch(
      `https://api.telegram.org/bot${this.token}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(35_000),
      },
    );
    const data = (await response.json()) as ApiResponse<T>;
    if (!data.ok)
      throw new Error(
        `Telegram ${method}: ${data.description ?? "unknown error"}`,
      );
    return data.result;
  }
  async updates(timeout = 30) {
    const result = await this.call<TelegramUpdate[]>("getUpdates", {
      offset: this.offset,
      timeout,
      allowed_updates: ["message", "callback_query"],
    });
    const last = result.at(-1);
    if (last) this.offset = last.update_id + 1;
    return result;
  }
  setMyCommands(commands: TelegramCommand[]) {
    return this.call("setMyCommands", { commands });
  }
  sendMessage(
    chatId: number,
    text: string,
    replyMarkup?: Record<string, unknown>,
  ): Promise<TelegramMessage> {
    return this.call<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup?: Record<string, unknown>,
  ) {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }
  answerCallbackQuery(id: string, text?: string) {
    return this.call("answerCallbackQuery", {
      callback_query_id: id,
      ...(text ? { text } : {}),
    });
  }
}
