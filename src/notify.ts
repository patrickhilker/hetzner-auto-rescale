import type { Config } from "./config.js";
import { log } from "./log.js";

export interface RescaleEvent {
  server: string;
  from: string;
  to: string;
  location: string;
}

type NotificationLevel = "info" | "success" | "error";

interface Notification {
  level: NotificationLevel;
  title: string;
  body: string;
}

function ntfyAuthHeader(cfg: Config): string | undefined {
  if (cfg.ntfyToken) return `Bearer ${cfg.ntfyToken}`;
  if (cfg.ntfyUser && cfg.ntfyPassword) {
    const encoded = Buffer.from(`${cfg.ntfyUser}:${cfg.ntfyPassword}`).toString("base64");
    return `Basic ${encoded}`;
  }
  return undefined;
}

const ntfyPriority: Record<NotificationLevel, "low" | "default" | "high"> = {
  info: "low",
  success: "default",
  error: "high",
};

const ntfyTags: Record<NotificationLevel, string> = {
  info: "white_check_mark",
  success: "rocket,hetzner",
  error: "warning",
};

async function postNtfy(cfg: Config, n: Notification): Promise<void> {
  if (!cfg.ntfyTopic) return;
  const url = `${cfg.ntfyServer.replace(/\/+$/, "")}/${encodeURIComponent(cfg.ntfyTopic)}`;
  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    Title: n.title,
    Tags: ntfyTags[n.level],
    Priority: ntfyPriority[n.level],
  };
  const auth = ntfyAuthHeader(cfg);
  if (auth) headers.Authorization = auth;
  log.info("Posting ntfy notification", { url, title: n.title, priority: ntfyPriority[n.level] });
  try {
    const res = await fetch(url, { method: "POST", headers, body: n.body });
    if (!res.ok) {
      log.warn("ntfy returned non-2xx", { status: res.status, url });
    } else {
      log.info("ntfy delivered", { status: res.status });
    }
  } catch (err) {
    log.warn("ntfy delivery failed", {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const pushoverPriority: Record<NotificationLevel, "-1" | "0" | "1"> = {
  info: "-1",
  success: "0",
  error: "1",
};

async function postPushover(cfg: Config, n: Notification): Promise<void> {
  if (!cfg.pushoverToken || !cfg.pushoverUser) return;
  const url = "https://api.pushover.net/1/messages.json";
  const form = new URLSearchParams({
    token: cfg.pushoverToken,
    user: cfg.pushoverUser,
    title: n.title,
    message: n.body,
    priority: pushoverPriority[n.level],
  });
  if (cfg.pushoverDevice) form.set("device", cfg.pushoverDevice);
  log.info("Posting Pushover notification", { title: n.title, priority: pushoverPriority[n.level] });
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log.warn("Pushover returned non-2xx", { status: res.status, body: text.slice(0, 200) });
    } else {
      log.info("Pushover delivered", { status: res.status });
    }
  } catch (err) {
    log.warn("Pushover delivery failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function dispatch(cfg: Config, n: Notification): Promise<void> {
  const tasks: Promise<void>[] = [];
  if (cfg.ntfyTopic) tasks.push(postNtfy(cfg, n));
  if (cfg.pushoverToken && cfg.pushoverUser) tasks.push(postPushover(cfg, n));
  if (tasks.length === 0) {
    log.info("No notification channels configured, skipping", { title: n.title });
    return;
  }
  await Promise.all(tasks);
}

export async function notifyStartup(cfg: Config): Promise<void> {
  await dispatch(cfg, {
    level: "info",
    title: "hetzner-auto-rescale gestartet",
    body: `Service ist online und beobachtet Server mit Label '${cfg.labelKey}'.`,
  });
}

export async function notifyRescale(cfg: Config, event: RescaleEvent): Promise<void> {
  await dispatch(cfg, {
    level: "success",
    title: `Hetzner Rescale: ${event.server} -> ${event.to}`,
    body: `Server "${event.server}" wurde von ${event.from} auf ${event.to} rescaled (${event.location}).`,
  });
}

const errorCooldown = new Map<string, number>();

export async function notifyError(cfg: Config, context: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const cooldownKey = `${context}::${message}`;
  const now = Date.now();
  const last = errorCooldown.get(cooldownKey);

  if (last !== undefined && now - last < cfg.errorNotifyCooldownMs) {
    log.info("Suppressing duplicate error notification (cooldown)", {
      context,
      cooldownRemainingSec: Math.round((cfg.errorNotifyCooldownMs - (now - last)) / 1000),
    });
    return;
  }
  errorCooldown.set(cooldownKey, now);

  await dispatch(cfg, {
    level: "error",
    title: `Hetzner-Rescale Fehler: ${context}`,
    body: `Kontext: ${context}\n\n${message}`,
  });
}
