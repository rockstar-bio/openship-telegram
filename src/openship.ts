export type Json = Record<string, unknown>;

export type ServerStats = {
  cpu: number;
  memTotal: number;
  memUsed: number;
  memAvail: number;
  diskTotal: number;
  diskUsed: number;
  diskAvail: number;
  uptime: string;
  load1: string;
  load5: string;
  load15: string;
};

// OpenShip 0.7.2's VPS/dashboard deployment exposes the API through the
// dashboard's same-host proxy. The proxy forwards /api/proxy/<path> to the
// internal API, so the public REST base is /api/proxy/api rather than /api.
const PUBLIC_API_BASE_PATH = "/api/proxy/api";

export class OpenShipApi {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(
      `${this.baseUrl}${PUBLIC_API_BASE_PATH}${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          ...init.headers,
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    const body = await response.text();
    let data: unknown;
    try {
      data = body ? JSON.parse(body) : {};
    } catch {
      data = body;
    }
    if (!response.ok)
      throw new Error(
        `OpenShip ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`,
      );
    return data as T;
  }

  health() {
    return this.request<Json>("/health");
  }
  healthEnv() {
    return this.request<Json>("/health/env");
  }
  servers() {
    return this.request<Json | Json[]>("/system/servers");
  }
  async serverStats(serverId: string): Promise<ServerStats> {
    const response = await fetch(
      `${this.baseUrl}${PUBLIC_API_BASE_PATH}/system/monitor/stream?serverId=${encodeURIComponent(serverId)}`,
      {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "text/event-stream",
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok || !response.body)
      throw new Error(`OpenShip monitor ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const event of events) {
          const type = event.match(/^event:\s*(.+)$/m)?.[1]?.trim();
          const data = event.match(/^data:\s*(.+)$/m)?.[1]?.trim();
          if (type === "error") throw new Error("OpenShip monitor error");
          if (type === "stats" && data) return JSON.parse(data) as ServerStats;
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    throw new Error("OpenShip monitor ended before stats were received");
  }
  projects() {
    return this.request<Json | Json[]>("/projects");
  }
  services(projectId: string) {
    return this.request<Json | Json[]>(
      `/projects/${encodeURIComponent(projectId)}/services`,
    );
  }
  deployments(projectId?: string) {
    return this.request<Json | Json[]>(
      `/deployments${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
    );
  }
  deployment(id: string) {
    return this.request<Json>(`/deployments/${encodeURIComponent(id)}`);
  }
  deploymentLogs(id: string) {
    return this.request<Json | string>(
      `/deployments/${encodeURIComponent(id)}/logs`,
    );
  }
  deploy(projectId: string) {
    return this.request<Json>("/deployments", {
      method: "POST",
      body: JSON.stringify({ projectId }),
    });
  }
  redeploy(id: string) {
    return this.request<Json>(
      `/deployments/${encodeURIComponent(id)}/redeploy`,
      { method: "POST", body: "{}" },
    );
  }
  restartService(projectId: string, serviceId: string) {
    return this.request<Json>(
      `/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}/restart`,
      { method: "POST", body: "{}" },
    );
  }
  serviceLogs(projectId: string, serviceId: string) {
    return this.request<Json | string>(
      `/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}/logs`,
    );
  }

  issues() {
    return this.request<Json>("/issues");
  }
  updates() {
    return this.request<Json | Json[]>("/updates");
  }
  domains() {
    return this.request<Json | Json[]>("/domains");
  }
  jobs() {
    return this.request<Json | Json[]>("/jobs");
  }
  projectBackupPolicies(projectId: string) {
    return this.request<Json | Json[]>(
      `/projects/${encodeURIComponent(projectId)}/backup-policies`,
    );
  }
  projectBackupRuns(projectId: string) {
    return this.request<Json | Json[]>(
      `/projects/${encodeURIComponent(projectId)}/backup-runs`,
    );
  }
  deploymentBuild(id: string) {
    return this.request<Json>(`/deployments/${encodeURIComponent(id)}/build`);
  }
  runBackup(policyId: string) {
    return this.request<Json>(
      `/backup-policies/${encodeURIComponent(policyId)}/run`,
      { method: "POST", body: "{}" },
    );
  }
  scanUpdates() {
    return this.request<Json>("/updates/scan", {
      method: "POST",
      body: "{}",
    });
  }
  applyUpdate(projectId: string) {
    return this.request<Json>(
      `/updates/${encodeURIComponent(projectId)}/apply`,
      { method: "POST", body: "{}" },
    );
  }
}
