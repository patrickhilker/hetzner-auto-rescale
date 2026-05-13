function ts(): string {
  return new Date().toISOString();
}

function fmt(level: string, msg: string, extra?: Record<string, unknown>): string {
  const base = `${ts()} [${level}] ${msg}`;
  if (!extra) return base;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(extra)) {
    parts.push(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  return `${base} ${parts.join(" ")}`;
}

export const log = {
  info(msg: string, extra?: Record<string, unknown>): void {
    console.log(fmt("info", msg, extra));
  },
  warn(msg: string, extra?: Record<string, unknown>): void {
    console.warn(fmt("warn", msg, extra));
  },
  error(msg: string, extra?: Record<string, unknown>): void {
    console.error(fmt("error", msg, extra));
  },
};
