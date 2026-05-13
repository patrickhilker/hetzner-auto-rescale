export interface Config {
  token: string;
  labelKey: string;
  upgradeDiskLabelKey: string;
  targetsSeparator: string;
  pollIntervalMs: number;
  actionPollIntervalMs: number;
  actionTimeoutMs: number;
  ntfyServer: string;
  ntfyTopic: string | undefined;
  ntfyToken: string | undefined;
  ntfyUser: string | undefined;
  ntfyPassword: string | undefined;
  pushoverToken: string | undefined;
  pushoverUser: string | undefined;
  pushoverDevice: string | undefined;
  notifyOnStart: boolean;
  errorNotifyCooldownMs: number;
  dryRun: boolean;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : undefined;
}

function parsePositiveInt(value: string, name: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Env var ${name} must be a positive integer, got: ${value}`);
  }
  return n;
}

export function loadConfig(): Config {
  const token = required("HCLOUD_TOKEN");

  const pollIntervalSec = optional("POLL_INTERVAL_SECONDS");
  const actionPollSec = optional("ACTION_POLL_INTERVAL_SECONDS");
  const actionTimeoutSec = optional("ACTION_TIMEOUT_SECONDS");
  const separator = optional("TARGETS_SEPARATOR") ?? "_";

  if (separator.length === 0) {
    throw new Error("TARGETS_SEPARATOR must not be empty");
  }

  return {
    token,
    labelKey: optional("LABEL_KEY") ?? "hetzner-auto-rescale/targets",
    upgradeDiskLabelKey: optional("UPGRADE_DISK_LABEL_KEY") ?? "hetzner-auto-rescale/upgrade-disk",
    targetsSeparator: separator,
    pollIntervalMs: (pollIntervalSec ? parsePositiveInt(pollIntervalSec, "POLL_INTERVAL_SECONDS") : 60) * 1000,
    actionPollIntervalMs: (actionPollSec ? parsePositiveInt(actionPollSec, "ACTION_POLL_INTERVAL_SECONDS") : 3) * 1000,
    actionTimeoutMs: (actionTimeoutSec ? parsePositiveInt(actionTimeoutSec, "ACTION_TIMEOUT_SECONDS") : 600) * 1000,
    ntfyServer: optional("NTFY_SERVER") ?? "https://ntfy.sh",
    ntfyTopic: optional("NTFY_TOPIC"),
    ntfyToken: optional("NTFY_TOKEN"),
    ntfyUser: optional("NTFY_USER"),
    ntfyPassword: optional("NTFY_PASSWORD"),
    pushoverToken: optional("PUSHOVER_TOKEN"),
    pushoverUser: optional("PUSHOVER_USER"),
    pushoverDevice: optional("PUSHOVER_DEVICE"),
    notifyOnStart: optional("NOTIFY_ON_START") !== "false",
    errorNotifyCooldownMs:
      (optional("ERROR_NOTIFY_COOLDOWN_SECONDS")
        ? parsePositiveInt(required("ERROR_NOTIFY_COOLDOWN_SECONDS"), "ERROR_NOTIFY_COOLDOWN_SECONDS")
        : 1800) * 1000,
    dryRun: optional("DRY_RUN") === "true",
  };
}
