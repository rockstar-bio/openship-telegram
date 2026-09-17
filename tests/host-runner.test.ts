import { describe, expect, test } from "bun:test";
import { createHostRunner, type HostRunnerConfig } from "../src/host-runner.ts";

const config: HostRunnerConfig = {
  bindAddress: "127.0.0.1",
  port: 8787,
  token: "runner-secret",
  paths: { cache: "/root/cache.sh", branding: "/root/branding.sh" },
  timeoutMs: 1000,
};

const request = (body: unknown, token = "runner-secret") =>
  new Request("http://127.0.0.1:8787/v1/actions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

describe("host runner", () => {
  test("authenticates and executes only the configured named path", async () => {
    const calls: string[] = [];
    const app = createHostRunner(config, async (path) => {
      calls.push(path);
      return { ok: true };
    });

    const response = await app(
      request({ action: "cache", path: "/root/cache.sh" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      action: "cache",
      output: "completed",
    });
    expect(calls).toEqual(["/root/cache.sh"]);
  });

  test("rejects bad tokens, unknown actions, and path substitution", async () => {
    const app = createHostRunner(config, async () => ({ ok: true }));
    expect(
      (await app(request({ action: "cache", path: "/root/cache.sh" }, "bad")))
        .status,
    ).toBe(401);
    expect(
      (await app(request({ action: "shell", path: "/bin/sh" }))).status,
    ).toBe(400);
    expect(
      (await app(request({ action: "cache", path: "/tmp/other.sh" }))).status,
    ).toBe(400);
  });

  test("returns sanitized failure and prevents concurrent execution", async () => {
    let release!: () => void;
    const app = createHostRunner(
      config,
      () => new Promise((resolve) => (release = () => resolve({ ok: false }))),
    );
    const first = app(
      request({ action: "branding", path: "/root/branding.sh" }),
    );
    expect(
      (await app(request({ action: "cache", path: "/root/cache.sh" }))).status,
    ).toBe(409);
    release();
    const response = await first;
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      ok: false,
      output: "failed",
    });
  });
});
