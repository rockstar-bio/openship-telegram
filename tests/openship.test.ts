import { describe, expect, test } from "bun:test";
import { OpenShipApi } from "../src/openship.ts";

describe("OpenShipApi", () => {
  test("uses documented API paths and bearer auth", async () => {
    const original = globalThis.fetch;
    let request: Request | undefined;
    globalThis.fetch = (async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }) as typeof fetch;
    await new OpenShipApi("https://example.test", "secret").health();
    expect(request?.url).toBe("https://example.test/api/health");
    expect(request?.headers.get("authorization")).toBe("Bearer secret");
    globalThis.fetch = original;
  });
});
