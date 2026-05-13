import type { Config } from "./config.js";
import { log } from "./log.js";

export interface RescaleEvent {
  server: string;
  from: string;
  to: string;
  datacenter: string;
}

function ntfyAuthHeader(cfg: Config): string | undefined {
  if (cfg.ntfyToken) return `Bearer ${cfg.ntfyToken}`;
  if (cfg.ntfyUser && cfg.ntfyPassword) {
    const encoded = Buffer.from(`${cfg.ntfyUser}:${cfg.ntfyPassword}`).toString("base64");
    return `Basic ${encoded}`;
  }
  return undefined;
}

interface NtfyMessage {
  title: string;
  body: string;
  tags: string;
  priority: "min" | "low" | "default" | "high" | "max";
}

async function postNtfy(cfg: Config, msg: NtfyMessage): Promise<void> {
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

export async function notifyStartup(cfg: Config): Promise<void> {
  if (!cfg.ntfyTopic) {
    log.info("ntfy not configured, skipping startup ping");
    return;
  }
  await postNtfy(cfg, {
    title: "hetzner-auto-rescale gestartet",
    body: `Service ist online und beobachtet Server mit Label '${cfg.labelKey}'.`,
    tags: "white_check_mark",
    priority: "low",
  });
}

export async function notifyRescale(cfg: Config, event: RescaleEvent): Promise<void> {
  if (!cfg.ntfyTopic) {
    log.info("ntfy not configured, skipping rescale notification", { server: event.server });
    return;
  }
  await postNtfy(cfg, {
    title: `Hetzner Rescale: ${event.server} -> ${event.to}`,
    body: `Server "${event.server}" wurde von ${event.from} auf ${event.to} rescaled (${event.datacenter}).`,
    tags: "rocket,hetzner",
    priority: "default",
  });
}

const errorCooldown = new Map<string, number>();

export async function notifyError(cfg: Config, context: string, err: unknown): Promise<void> {
  if (!cfg.ntfyTopic) return;

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

  await postNtfy(cfg, {
    title: `Hetzner-Rescale Fehler: ${context}`,
    body: `Kontext: ${context}\n\n${message}`,
    tags: "warning",
    priority: "high",
  });
}
