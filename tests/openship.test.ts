import { describe, expect, test } from "bun:test";
import { OpenShipApi } from "../src/openship.ts";

describe("OpenShipApi", () => {
  test("uses the public dashboard proxy and bearer auth", async () => {
    const original = globalThis.fetch;
    let request: Request | undefined;
    globalThis.fetch = (async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }) as typeof fetch;
    await new OpenShipApi("https://example.test", "secret").health();
    expect(request?.url).toBe("https://example.test/api/proxy/api/health");
    expect(request?.headers.get("authorization")).toBe("Bearer secret");
    globalThis.fetch = original;
  });

  test("uses the same public API base for project and deployment actions", async () => {
    const original = globalThis.fetch;
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    const api = new OpenShipApi("https://example.test", "secret");
    await api.healthEnv();
    await api.projects();
    await api.services("project/id");
    await api.deployments("project/id");
    await api.deployment("deployment/id");
    await api.deploymentLogs("deployment/id");
    await api.deploy("project/id");
    await api.redeploy("deployment/id");
    await api.restartService("project/id", "service/id");

    expect(
      requests.map((request) => `${request.method} ${request.url}`),
    ).toEqual([
      "GET https://example.test/api/proxy/api/health/env",
      "GET https://example.test/api/proxy/api/projects",
      "GET https://example.test/api/proxy/api/projects/project%2Fid/services",
      "GET https://example.test/api/proxy/api/deployments?projectId=project%2Fid",
      "GET https://example.test/api/proxy/api/deployments/deployment%2Fid",
      "GET https://example.test/api/proxy/api/deployments/deployment%2Fid/logs",
      "POST https://example.test/api/proxy/api/deployments",
      "POST https://example.test/api/proxy/api/deployments/deployment%2Fid/redeploy",
      "POST https://example.test/api/proxy/api/projects/project%2Fid/services/service%2Fid/restart",
    ]);

    globalThis.fetch = original;
  });

  test("reads connected server details and the monitor SSE stats", async () => {
    const original = globalThis.fetch;
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.includes("/system/servers")) {
        return new Response(
          JSON.stringify([{ id: "server-1", isLocal: true }]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response(
        'event: stats\ndata: {"cpu":5,"memTotal":100,"memUsed":25,"memAvail":75,"diskTotal":1000,"diskUsed":400,"diskAvail":600,"uptime":"120","load1":"0.1","load5":"0.2","load15":"0.3"}\n\n',
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }) as typeof fetch;

    const api = new OpenShipApi("https://example.test", "secret");
    expect(await api.servers()).toEqual([{ id: "server-1", isLocal: true }]);
    expect(await api.serverStats("server/1")).toMatchObject({
      cpu: 5,
      memUsed: 25,
      diskAvail: 600,
      uptime: "120",
    });
    expect(requests[1]?.url).toBe(
      "https://example.test/api/proxy/api/system/monitor/stream?serverId=server%2F1",
    );
    expect(requests[1]?.headers.get("authorization")).toBe("Bearer secret");
    globalThis.fetch = original;
  });

  test("uses OpenShip 0.7.2 routes for operations screens", async () => {
    const original = globalThis.fetch;
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;

    const api = new OpenShipApi("https://example.test", "secret");
    await api.issues();
    await api.updates();
    await api.domains();
    await api.jobs();
    await api.projectBackupPolicies("project/id");
    await api.projectBackupRuns("project/id");
    await api.deploymentBuild("deployment/id");
    await api.applyUpdate("project/id");
    await api.runBackup("policy/id");
    await api.runJob("images:gc");

    expect(
      requests.map((request) => `${request.method} ${request.url}`),
    ).toEqual([
      "GET https://example.test/api/proxy/api/issues",
      "GET https://example.test/api/proxy/api/updates",
      "GET https://example.test/api/proxy/api/domains",
      "GET https://example.test/api/proxy/api/jobs",
      "GET https://example.test/api/proxy/api/projects/project%2Fid/backup-policies",
      "GET https://example.test/api/proxy/api/projects/project%2Fid/backup-runs",
      "GET https://example.test/api/proxy/api/deployments/deployment%2Fid/build",
      "POST https://example.test/api/proxy/api/updates/project%2Fid/apply",
      "POST https://example.test/api/proxy/api/backup-policies/policy%2Fid/run",
      "POST https://example.test/api/proxy/api/jobs/images%3Agc/run",
    ]);
    globalThis.fetch = original;
  });
});
