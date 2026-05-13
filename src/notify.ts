import type { Config } from "./config.js";
import { log } from "./log.js";

export interface RescaleEvent {
  server: string;
  from: string;
  to: string;
  datacenter: string;
}

type Priority = "min" | "low" | "default" | "high" | "max";

interface Message {
  title: string;
  body: string;
  tags: string;
  priority: Priority;
}

function ntfyAuthHeader(cfg: Config): string | undefined {
  if (cfg.ntfyToken) return `Bearer ${cfg.ntfyToken}`;
  if (cfg.ntfyUser && cfg.ntfyPassword) {
    const encoded = Buffer.from(`${cfg.ntfyUser}:${cfg.ntfyPassword}`).toString("base64");
    return `Basic ${encoded}`;
  }
  return undefined;
}

async function postNtfy(cfg: Config, msg: Message): Promise<void> {
  if (!cfg.ntfyTopic) return;
  const url = `${cfg.ntfyServer.replace(/\/+$/, "")}/${encodeURIComponent(cfg.ntfyTopic)}`;
  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    Title: msg.title,
    Tags: msg.tags,
    Priority: msg.priority,
  };
  const auth = ntfyAuthHeader(cfg);
  if (auth) headers.Authorization = auth;
  log.info("Posting ntfy notification", { url, title: msg.title, priority: msg.priority });
  try {
    const res = await fetch(url, { method: "POST", headers, body: msg.body });
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

function pushoverPriority(p: Priority): string {
  switch (p) {
    case "min":
      return "-2";
    case "low":
      return "-1";
    case "default":
      return "0";
    case "high":
      return "1";
    case "max":
      return "2";
  }
}

async function postPushover(cfg: Config, msg: Message): Promise<void> {
  if (!cfg.pushoverToken || !cfg.pushoverUser) return;
  const url = "https://api.pushover.net/1/messages.json";
  const params = new URLSearchParams({
    token: cfg.pushoverToken,
    user: cfg.pushoverUser,
    title: msg.title,
    message: msg.body,
    priority: pushoverPriority(msg.priority),
  });
  if (cfg.pushoverDevice) params.set("device", cfg.pushoverDevice);
  // Pushover priority 2 requires retry+expire.
  if (msg.priority === "max") {
    params.set("retry", "60");
    params.set("expire", "3600");
  }
  log.info("Posting pushover notification", { title: msg.title, priority: msg.priority });
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!res.ok) {
      log.warn("pushover returned non-2xx", { status: res.status });
    } else {
      log.info("pushover delivered", { status: res.status });
    }
  } catch (err) {
    log.warn("pushover delivery failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function notifyConfigured(cfg: Config): boolean {
  return Boolean(cfg.ntfyTopic) || Boolean(cfg.pushoverToken && cfg.pushoverUser);
}

async function dispatch(cfg: Config, msg: Message): Promise<void> {
  await Promise.all([postNtfy(cfg, msg), postPushover(cfg, msg)]);
}

export async function notifyStartup(cfg: Config): Promise<void> {
  if (!notifyConfigured(cfg)) {
    log.info("no notification backend configured, skipping startup ping");
    return;
  }
  await dispatch(cfg, {
    title: "hetzner-auto-rescale gestartet",
    body: `Service ist online und beobachtet Server mit Label '${cfg.labelKey}'.`,
    tags: "white_check_mark",
    priority: "low",
  });
}

export async function notifyRescale(cfg: Config, event: RescaleEvent): Promise<void> {
  if (!notifyConfigured(cfg)) {
    log.info("no notification backend configured, skipping rescale notification", { server: event.server });
    return;
  }
  await dispatch(cfg, {
    title: `Hetzner Rescale: ${event.server} -> ${event.to}`,
    body: `Server "${event.server}" wurde von ${event.from} auf ${event.to} rescaled (${event.datacenter}).`,
    tags: "rocket,hetzner",
    priority: "default",
  });
}

const errorCooldown = new Map<string, number>();

export async function notifyError(cfg: Config, context: string, err: unknown): Promise<void> {
  if (!notifyConfigured(cfg)) return;

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
    title: `Hetzner-Rescale Fehler: ${context}`,
    body: `Kontext: ${context}\n\n${message}`,
    tags: "warning",
    priority: "high",
  });
}
