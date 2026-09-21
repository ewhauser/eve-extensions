import { existsSync } from "node:fs";
import { celldJustBash } from "eve-celld-sandbox";
if (existsSync(".env")) process.loadEnvFile(".env");
export function backend() {
  return celldJustBash({
    endpoint: process.env.CELLD_ENDPOINT ?? "http://127.0.0.1:9876",
    token: process.env.CELLD_TOKEN ?? "",
    namespace: process.env.CELLD_NAMESPACE ?? "demo",
  });
}
