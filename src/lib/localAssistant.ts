export interface LocalAssistantStatus {
  connected: boolean;
  state?: "checking" | "connected" | "disconnected" | "incompatible";
  service?: string;
  version?: string;
  protocolVersion?: number;
  compatible?: boolean;
  deviceFingerprint?: string;
  webAppUrl?: string;
  capabilities?: string[];
  error?: string;
}

const LOCAL_ASSISTANT_URL = "http://127.0.0.1:17641";
export const LOCAL_ASSISTANT_PROTOCOL_VERSION = 4;
export const LOCAL_ASSISTANT_DEEP_LINK = "ozon-sjsq://open";
const NORMAL_HEALTH_TIMEOUT_MS = 2_000;
let activeProbe: Promise<LocalAssistantStatus> | null = null;

export interface CloudSyncStatus {
  accountId: string;
  scope: string;
  completed: boolean;
  syncing: boolean;
  cursor: number;
  lastSuccessAt?: string;
  lastError?: string;
}

export function checkLocalAssistant(timeoutMs = NORMAL_HEALTH_TIMEOUT_MS): Promise<LocalAssistantStatus> {
  if (!activeProbe) {
    activeProbe = probeLocalAssistant(timeoutMs).finally(() => {
      activeProbe = null;
    });
  }
  return activeProbe;
}

export async function checkLocalAssistantWithGracePeriod(options: {
  timeoutMs?: number;
  settleForMs?: number;
  retryDelayMs?: number;
} = {}): Promise<LocalAssistantStatus> {
  const timeoutMs = options.timeoutMs ?? 700;
  const settleForMs = options.settleForMs ?? 5000;
  const retryDelayMs = options.retryDelayMs ?? 250;
  const startedAt = Date.now();
  let lastStatus: LocalAssistantStatus = { connected: false, state: "disconnected", error: "本地助手未启动" };

  while (Date.now() - startedAt <= settleForMs) {
    const status = await checkLocalAssistant(timeoutMs);
    lastStatus = status;
    if (status.connected) {
      return status;
    }
    if (Date.now() - startedAt > settleForMs) {
      break;
    }
    await delay(retryDelayMs);
  }

  return lastStatus;
}

async function probeLocalAssistant(timeoutMs = 1200): Promise<LocalAssistantStatus> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${LOCAL_ASSISTANT_URL}/health`, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        connected: false,
        state: "disconnected",
        error: `本地助手响应异常：HTTP ${response.status}`,
      };
    }
    const data = await response.json();
    const protocolVersion = Number(data.protocolVersion ?? 0);
    const compatible = protocolVersion === LOCAL_ASSISTANT_PROTOCOL_VERSION;
    return {
      connected: true,
      state: compatible ? "connected" : "incompatible",
      service: data.service,
      version: data.version,
      protocolVersion,
      compatible,
      deviceFingerprint: data.deviceFingerprint,
      webAppUrl: data.webAppUrl,
      capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
      error: compatible
        ? undefined
        : `本地助手协议版本不兼容：网页需要 ${LOCAL_ASSISTANT_PROTOCOL_VERSION}，当前为 ${protocolVersion || "未知"}`,
    };
  } catch (error) {
    return {
      connected: false,
      state: "disconnected",
      error: error instanceof Error && error.name === "AbortError" ? "本地助手连接超时" : "本地助手未启动",
    };
  } finally {
    window.clearTimeout(timer);
  }
}

export function openLocalAssistant() {
  window.location.href = LOCAL_ASSISTANT_DEEP_LINK;
}

export async function callLocalAssistantCommand<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`${LOCAL_ASSISTANT_URL}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, args }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data.message === "string" ? data.message : `本地助手执行失败：HTTP ${response.status}`;
    throw new Error(message);
  }
  return data as T;
}

export function startCloudSync(input: { baseUrl: string; authToken: string; accountId: string }) {
  return callLocalAssistantCommand<{ ok: boolean; started: boolean }>("start_cloud_sync", { request: input });
}

export function getCloudSyncStatus(accountId: string) {
  return callLocalAssistantCommand<CloudSyncStatus[]>("cloud_sync_status", { accountId });
}

export function startProductCatalogSync(input: { baseUrl: string; authToken: string; force?: boolean }) {
  return callLocalAssistantCommand<{ ok: boolean; started: boolean; reason?: string }>("start_product_catalog_sync", {
    request: input,
  });
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export async function resolveWebDeviceFingerprint(assistant: LocalAssistantStatus) {
  if (assistant.connected && assistant.deviceFingerprint) {
    return assistant.deviceFingerprint;
  }
  return `web-${await sha256Hex(`${window.location.origin}|${window.navigator.userAgent}`)}`;
}

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await window.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
}
