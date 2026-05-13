import createClient from "openapi-fetch";
import type { paths } from "./generated/hcloud.js";

export type HCloudClient = ReturnType<typeof createClient<paths>>;

export function createHCloudClient(token: string): HCloudClient {
  return createClient<paths>({
    baseUrl: "https://api.hetzner.cloud/v1",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "hetzner-auto-rescale/0.1",
    },
  });
}
