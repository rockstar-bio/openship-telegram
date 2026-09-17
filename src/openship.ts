export type Json = Record<string, unknown>;

export class OpenShipApi {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}/api${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(15_000),
    });
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
}
