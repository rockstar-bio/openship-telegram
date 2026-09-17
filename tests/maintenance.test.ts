import { describe, expect, test } from "bun:test";
import {
  type HostRunner,
  HttpHostRunner,
  PatchJobManager,
} from "../src/maintenance.ts";

describe("HttpHostRunner", () => {
  test("sends only an allowlisted named action and configured path", async () => {
    const original = globalThis.fetch;
    let request: Request | undefined;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      request = new Request(input, init);
      return new Response("{}", { status: 202 });
    }) as unknown as typeof fetch;

    await new HttpHostRunner("https://runner.example.test", "runner-secret", {
      cache: "/root/cache.sh",
      branding: "/root/branding.sh",
    }).run("cache");

    expect(request?.url).toBe("https://runner.example.test/v1/actions");
    expect(request?.headers.get("authorization")).toBe("Bearer runner-secret");
    expect(await request?.json()).toEqual({
      action: "cache",
      path: "/root/cache.sh",
    });
    globalThis.fetch = original;
  });

  test("rejects an unknown action before making a request", async () => {
    const original = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      new HttpHostRunner("https://runner.example.test", "secret", {
        cache: "/root/cache.sh",
        branding: "/root/branding.sh",
      }).run("shell" as "cache"),
    ).rejects.toThrow("Unsupported maintenance action");
    expect(called).toBe(false);
    globalThis.fetch = original;
  });
});

describe("PatchJobManager", () => {
  test("runs all actions in order and releases the lock after failure", async () => {
    const calls: string[] = [];
    const runner: HostRunner = {
      async run(action) {
        calls.push(action);
        if (action === "cache") throw new Error("cache failed");
      },
    };
    const manager = new PatchJobManager(runner);
    const progress: string[] = [];

    await expect(
      manager.run(["cache", "branding"], (message) => {
        progress.push(message);
      }),
    ).rejects.toThrow("cache failed");
    expect(calls).toEqual(["cache"]);
    expect(progress).toEqual(["Starting Cache Patch…"]);
    expect(manager.isRunning).toBe(false);
  });

  test("prevents concurrent jobs", async () => {
    let release!: () => void;
    const runner: HostRunner = {
      run: () => new Promise<void>((resolve) => (release = resolve)),
    };
    const manager = new PatchJobManager(runner);
    const first = manager.run(["branding"], () => {});
    await expect(manager.run(["cache"], () => undefined)).rejects.toThrow(
      "already running",
    );
    release();
    await first;
  });

  test("runs all successful actions in order", async () => {
    const calls: string[] = [];
    const manager = new PatchJobManager({
      async run(action) {
        calls.push(action);
      },
    });
    await manager.run(["cache", "branding"], () => {});
    expect(calls).toEqual(["cache", "branding"]);
  });
});
