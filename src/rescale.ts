import type { HCloudClient } from "./client.js";
import { log } from "./log.js";

export class HCloudApiError extends Error {
  constructor(
    message: string,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "HCloudApiError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface LabeledServer {
  id: number;
  name: string;
  status: string;
  currentTypeId: number;
  currentTypeName: string;
  datacenterId: number;
  datacenterName: string;
  labels: Record<string, string>;
}

export async function listLabeledServers(client: HCloudClient, labelKey: string): Promise<LabeledServer[]> {
  const result: LabeledServer[] = [];
  let page = 1;
  for (;;) {
    const { data, error } = await client.GET("/servers", {
      params: { query: { label_selector: labelKey, page, per_page: 50 } },
    });
    if (error || !data) {
      throw new HCloudApiError(`Failed to list servers with label '${labelKey}'`, error);
    }
    for (const s of data.servers) {
      result.push({
        id: s.id,
        name: s.name,
        status: s.status,
        currentTypeId: s.server_type.id,
        currentTypeName: s.server_type.name,
        datacenterId: s.datacenter.id,
        datacenterName: s.datacenter.name,
        labels: s.labels,
      });
    }
    const nextPage = data.meta?.pagination?.next_page;
    if (!nextPage) break;
    page = nextPage;
  }
  return result;
}

export interface ServerTypeInfo {
  id: number;
  name: string;
  cores: number;
  memory: number;
  disk: number;
}

export async function listServerTypes(client: HCloudClient): Promise<ServerTypeInfo[]> {
  const result: ServerTypeInfo[] = [];
  let page = 1;
  for (;;) {
    const { data, error } = await client.GET("/server_types", {
      params: { query: { page, per_page: 50 } },
    });
    if (error || !data) {
      throw new HCloudApiError("Failed to list server types", error);
    }
    for (const t of data.server_types) {
      result.push({ id: t.id, name: t.name, cores: t.cores, memory: t.memory, disk: t.disk });
    }
    const nextPage = data.meta?.pagination?.next_page;
    if (!nextPage) break;
    page = nextPage;
  }
  return result;
}

export async function getAvailableForMigration(client: HCloudClient, datacenterId: number): Promise<number[]> {
  const { data, error } = await client.GET("/datacenters/{id}", {
    params: { path: { id: datacenterId } },
  });
  if (error || !data || !data.datacenter) {
    throw new HCloudApiError(`Failed to fetch datacenter ${datacenterId}`, error);
  }
  return data.datacenter.server_types.available_for_migration;
}

interface ActionRef {
  id: number;
  status: "error" | "running" | "success";
  command: string;
}

async function pollAction(
  client: HCloudClient,
  actionId: number,
  command: string,
  pollIntervalMs: number,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  const deadline = start + timeoutMs;
  let lastLoggedProgress = -1;
  let polls = 0;
  for (;;) {
    const { data, error } = await client.GET("/actions/{id}", {
      params: { path: { id: actionId } },
    });
    if (error || !data) {
      throw new HCloudApiError(`Failed to poll action ${actionId}`, error);
    }
    const a = data.action;
    polls++;
    if (a.status === "success") {
      log.info("Action finished", {
        command,
        actionId,
        elapsedMs: Date.now() - start,
        polls,
      });
      return;
    }
    if (a.status === "error") {
      throw new HCloudApiError(
        `Action ${a.command} (${actionId}) failed: ${a.error?.message ?? "unknown"}`,
        a.error,
      );
    }
    if (a.progress !== lastLoggedProgress) {
      log.info("Action progress", {
        command,
        actionId,
        progress: `${a.progress}%`,
        status: a.status,
      });
      lastLoggedProgress = a.progress;
    }
    if (Date.now() > deadline) {
      throw new Error(`Action ${a.command} (${actionId}) timed out after ${timeoutMs}ms`);
    }
    await sleep(pollIntervalMs);
  }
}

async function powerOff(client: HCloudClient, serverId: number): Promise<ActionRef> {
  const { data, error } = await client.POST("/servers/{id}/actions/poweroff", {
    params: { path: { id: serverId } },
  });
  if (error || !data) {
    throw new HCloudApiError(`poweroff failed for server ${serverId}`, error);
  }
  return data.action;
}

async function powerOn(client: HCloudClient, serverId: number): Promise<ActionRef> {
  const { data, error } = await client.POST("/servers/{id}/actions/poweron", {
    params: { path: { id: serverId } },
  });
  if (error || !data) {
    throw new HCloudApiError(`poweron failed for server ${serverId}`, error);
  }
  return data.action;
}

async function changeType(
  client: HCloudClient,
  serverId: number,
  targetType: string,
  upgradeDisk: boolean,
): Promise<ActionRef> {
  const { data, error } = await client.POST("/servers/{id}/actions/change_type", {
    params: { path: { id: serverId } },
    body: { server_type: targetType, upgrade_disk: upgradeDisk },
  });
  if (error || !data) {
    throw new HCloudApiError(`change_type failed for server ${serverId}`, error);
  }
  return data.action;
}

export async function removeLabel(
  client: HCloudClient,
  serverId: number,
  serverName: string,
  labels: Record<string, string>,
  labelKey: string,
): Promise<void> {
  if (!(labelKey in labels)) {
    log.info("Label already absent, skipping update", { server: serverName, labelKey });
    return;
  }
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    if (k !== labelKey) next[k] = v;
  }
  log.info("Removing label from server", { server: serverName, labelKey });
  const { data, error } = await client.PUT("/servers/{id}", {
    params: { path: { id: serverId } },
    body: { labels: next },
  });
  if (error || !data) {
    throw new HCloudApiError(`Failed to update labels on server ${serverId}`, error);
  }
  log.info("Label removed", { server: serverName, labelKey });
}

export async function rescaleServer(
  client: HCloudClient,
  server: LabeledServer,
  targetType: string,
  upgradeDisk: boolean,
  actionPollIntervalMs: number,
  actionTimeoutMs: number,
): Promise<void> {
  const wasRunning = server.status === "running";

  log.info("Starting rescale", {
    server: server.name,
    from: server.currentTypeName,
    to: targetType,
    wasRunning,
    upgradeDisk,
  });

  if (wasRunning) {
    log.info("Powering off server", { server: server.name });
    const action = await powerOff(client, server.id);
    log.info("poweroff action accepted", { server: server.name, actionId: action.id });
    await pollAction(client, action.id, "poweroff", actionPollIntervalMs, actionTimeoutMs);
    log.info("Server powered off", { server: server.name });
  } else if (server.status !== "off") {
    throw new Error(`Server '${server.name}' in unexpected state '${server.status}', refusing to rescale`);
  } else {
    log.info("Server already off, skipping poweroff step", { server: server.name });
  }

  log.info("Submitting change_type", {
    server: server.name,
    from: server.currentTypeName,
    to: targetType,
    upgradeDisk,
  });
  const changeAction = await changeType(client, server.id, targetType, upgradeDisk);
  log.info("change_type action accepted", { server: server.name, actionId: changeAction.id });
  await pollAction(client, changeAction.id, "change_type", actionPollIntervalMs, actionTimeoutMs);
  log.info("Server type changed", { server: server.name, to: targetType });

  if (wasRunning) {
    log.info("Powering server back on", { server: server.name });
    const onAction = await powerOn(client, server.id);
    log.info("poweron action accepted", { server: server.name, actionId: onAction.id });
    await pollAction(client, onAction.id, "poweron", actionPollIntervalMs, actionTimeoutMs);
    log.info("Server powered on", { server: server.name });
  } else {
    log.info("Server was off before rescale, leaving it off", { server: server.name });
  }
}
