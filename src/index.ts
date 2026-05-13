import { loadConfig, type Config } from "./config.js";
import { createHCloudClient, type HCloudClient } from "./client.js";
import {
  getAvailableForMigration,
  listLabeledServers,
  listServerTypes,
  rescaleServer,
  removeLabel,
  type LabeledServer,
  type ServerTypeInfo,
} from "./rescale.js";
import { log } from "./log.js";
import { notifyError, notifyRescale, notifyStartup } from "./notify.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseTargets(value: string, separator: string): string[] {
  return value
    .split(separator)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface PickedTarget {
  type: ServerTypeInfo;
}

function pickAvailableTarget(
  targets: string[],
  typesByName: Map<string, ServerTypeInfo>,
  availableIds: ReadonlySet<number>,
): PickedTarget | undefined {
  for (const name of targets) {
    const type = typesByName.get(name);
    if (!type) {
      log.warn("Configured target type does not exist in Hetzner Cloud", { name });
      continue;
    }
    if (availableIds.has(type.id)) {
      return { type };
    }
  }
  return undefined;
}

async function processServer(
  client: HCloudClient,
  cfg: Config,
  server: LabeledServer,
  typesByName: Map<string, ServerTypeInfo>,
): Promise<boolean> {
  log.info("Inspecting server", {
    server: server.name,
    id: server.id,
    currentType: server.currentTypeName,
    status: server.status,
    datacenter: server.datacenterName,
  });

  const labelValue = server.labels[cfg.labelKey];
  if (!labelValue) {
    log.warn("Server has label key but empty value, skipping", { server: server.name });
    return false;
  }

  const targets = parseTargets(labelValue, cfg.targetsSeparator);
  log.info("Parsed targets from label", {
    server: server.name,
    labelValue,
    targets: targets.join(","),
  });

  if (targets.length === 0) {
    log.warn("Label value parsed to empty target list, skipping", { server: server.name, labelValue });
    return false;
  }

  if (targets.includes(server.currentTypeName)) {
    log.info("Server already at a target type, removing label", {
      server: server.name,
      type: server.currentTypeName,
    });
    if (cfg.dryRun) {
      log.info("DRY_RUN enabled, would remove label", { server: server.name });
      return false;
    }
    await removeLabel(client, server.id, server.name, server.labels, cfg.labelKey);
    return true;
  }

  log.info("Querying datacenter availability", {
    server: server.name,
    datacenter: server.datacenterName,
    datacenterId: server.datacenterId,
  });
  const available = await getAvailableForMigration(client, server.datacenterId);
  const availableSet = new Set(available);

  const availableTargetNames: string[] = [];
  const unavailableTargetNames: string[] = [];
  const unknownTargets: string[] = [];
  for (const name of targets) {
    const type = typesByName.get(name);
    if (!type) {
      unknownTargets.push(name);
      continue;
    }
    if (availableSet.has(type.id)) {
      availableTargetNames.push(name);
    } else {
      unavailableTargetNames.push(name);
    }
  }

  log.info("Datacenter migration availability", {
    server: server.name,
    datacenter: server.datacenterName,
    availableForMigrationCount: available.length,
    targetsAvailable: availableTargetNames.join(",") || "(none)",
    targetsUnavailable: unavailableTargetNames.join(",") || "(none)",
    unknownTargets: unknownTargets.join(",") || "(none)",
  });

  if (unknownTargets.length > 0) {
    log.warn("Some configured targets are unknown server types", {
      server: server.name,
      unknown: unknownTargets.join(","),
    });
  }

  const match = pickAvailableTarget(targets, typesByName, availableSet);

  if (!match) {
    log.info("No target type currently available, will retry next interval", {
      server: server.name,
    });
    return false;
  }

  log.info("Target server type available for migration", {
    server: server.name,
    target: match.type.name,
    cores: match.type.cores,
    memoryGiB: match.type.memory,
    diskGB: match.type.disk,
  });

  if (cfg.dryRun) {
    log.info("DRY_RUN enabled, would rescale", { server: server.name, target: match.type.name });
    return false;
  }

  const rescaleStart = Date.now();
  await rescaleServer(client, server, match.type.name, cfg.actionPollIntervalMs, cfg.actionTimeoutMs);
  log.info("Rescale flow completed", {
    server: server.name,
    target: match.type.name,
    elapsedMs: Date.now() - rescaleStart,
  });

  await removeLabel(client, server.id, server.name, server.labels, cfg.labelKey);

  log.info("Sending notifications", { server: server.name });
  await notifyRescale(cfg, {
    server: server.name,
    from: server.currentTypeName,
    to: match.type.name,
    datacenter: server.datacenterName,
  });
  log.info("Notifications dispatched", { server: server.name });

  return true;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const client = createHCloudClient(cfg.token);

  log.info("Starting hetzner-auto-rescale", {
    labelKey: cfg.labelKey,
    separator: cfg.targetsSeparator,
    pollIntervalSec: cfg.pollIntervalMs / 1000,
    actionPollIntervalSec: cfg.actionPollIntervalMs / 1000,
    actionTimeoutSec: cfg.actionTimeoutMs / 1000,
    dryRun: cfg.dryRun,
    ntfyEnabled: cfg.ntfyTopic !== undefined,
    pushoverEnabled: cfg.pushoverToken !== undefined && cfg.pushoverUser !== undefined,
    errorNotifyCooldownSec: cfg.errorNotifyCooldownMs / 1000,
  });

  log.info("Loading server type catalog from Hetzner");
  const allTypes = await listServerTypes(client);
  const typesByName = new Map(allTypes.map((t) => [t.name, t]));
  log.info("Server type catalog loaded", {
    count: allTypes.length,
    sample: allTypes.slice(0, 5).map((t) => t.name).join(","),
  });

  if (cfg.notifyOnStart) {
    await notifyStartup(cfg);
  } else {
    log.info("NOTIFY_ON_START=false, skipping startup ping");
  }

  let shutdownRequested = false;
  const onSignal = (sig: string): void => {
    log.info("Received signal, will exit after current iteration", { sig });
    shutdownRequested = true;
  };
  process.on("SIGINT", () => {
    onSignal("SIGINT");
  });
  process.on("SIGTERM", () => {
    onSignal("SIGTERM");
  });

  let iteration = 0;
  while (!shutdownRequested) {
    iteration++;
    const iterStart = Date.now();
    log.info("Iteration starting", { iteration });
    try {
      log.info("Listing servers by label selector", { labelSelector: cfg.labelKey });
      const servers = await listLabeledServers(client, cfg.labelKey);

      if (servers.length === 0) {
        log.info("No servers carry the label, idle", { iteration });
      } else {
        log.info("Found labeled servers", {
          count: servers.length,
          names: servers.map((s) => s.name).join(","),
        });
      }

      let rescaledCount = 0;
      for (const server of servers) {
        if (shutdownRequested) break;
        try {
          const acted = await processServer(client, cfg, server, typesByName);
          if (acted) rescaledCount++;
        } catch (err) {
          log.error("Processing server failed", {
            server: server.name,
            error: err instanceof Error ? err.message : String(err),
          });
          await notifyError(cfg, `Server '${server.name}'`, err);
        }
      }

      log.info("Iteration finished", {
        iteration,
        elapsedMs: Date.now() - iterStart,
        serversChecked: servers.length,
        rescaled: rescaledCount,
      });
    } catch (err) {
      log.error("Iteration failed", {
        iteration,
        error: err instanceof Error ? err.message : String(err),
      });
      await notifyError(cfg, "Iteration", err);
    }

    if (shutdownRequested) break;

    log.info("Sleeping until next check", { seconds: cfg.pollIntervalMs / 1000 });
    const sleepSlices = Math.max(1, Math.ceil(cfg.pollIntervalMs / 1000));
    for (let i = 0; i < sleepSlices && !shutdownRequested; i++) {
      await sleep(1000);
    }
  }

  log.info("Shutting down");
}

main().catch(async (err: unknown) => {
  log.error("Fatal error", { error: err instanceof Error ? err.message : String(err) });
  try {
    const cfg = loadConfig();
    await notifyError(cfg, "Fatal startup error", err);
  } catch {
    // config konnte nicht geladen werden, dann gibt's auch keine notification
  }
  process.exit(1);
});
