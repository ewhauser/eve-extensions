import {
  ConnectionAuthorizationRequiredError,
  defineDynamic,
  defineMcpClientConnection,
  type DynamicConnectionResolveContext,
} from "eve/connections";

import extension from "../extension.js";
import { mapUpstreamServiceName } from "../lib/naming.js";
import { buildApprovalPolicy } from "../lib/policy.js";
import type { ConnectorContext } from "../lib/types.js";

export const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/ps/mcp";
const CONNECTION_NAME = "connectors";
const QUALIFIED_NAME_OVERHEAD = `${CONNECTION_NAME}__`.length;
const MAX_MODEL_TOOL_NAME_LENGTH = 64 - QUALIFIED_NAME_OVERHEAD;

function normalizeServices(
  services: readonly string[] | undefined,
): ReadonlySet<string> | undefined {
  return services === undefined
    ? undefined
    : new Set(services.map((service) => service.trim().toLowerCase()));
}

function serviceFromUpstream(upstreamName: string): string | undefined {
  const separator = upstreamName.indexOf(".");
  if (separator <= 0) return undefined;
  const service = upstreamName.slice(0, separator).trim().toLowerCase();
  return service.length === 0 ? undefined : service;
}

export function connectorToolFilter(
  upstreamName: string,
  allowedServices: readonly string[] | undefined,
  excludedServices: readonly string[] | undefined,
): boolean {
  const service = serviceFromUpstream(upstreamName);
  if (service === undefined) return false;
  const allowed = normalizeServices(allowedServices);
  const excluded = normalizeServices(excludedServices);
  if (excluded?.has(service)) return false;
  return allowed === undefined || allowed.has(service);
}

function defaultPrincipal(ctx: DynamicConnectionResolveContext): string | null {
  const current = ctx.session.auth.current;
  if (current?.principalType !== "user") return null;
  return `user:${current.issuer ?? "vercel"}:${current.principalId}`;
}

function instanceKey(
  principal: string,
  allowedServices: readonly string[] | undefined,
  excludedServices: readonly string[] | undefined,
): string {
  return JSON.stringify({
    allowedServices: [...(allowedServices ?? [])].map((value) => value.toLowerCase()).sort(),
    excludedServices: [...(excludedServices ?? [])].map((value) => value.toLowerCase()).sort(),
    nameMapping: "service-qualified-v1",
    principal,
  });
}

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      const config = extension.config;
      if (!config.enabled) return null;

      const connectorContext: ConnectorContext = { session: ctx.session };
      const principal =
        config.getPrincipal === undefined
          ? defaultPrincipal(ctx)
          : config.getPrincipal(connectorContext);
      if (principal === null) return null;

      const approvalConfig =
        config.approvals === undefined
          ? undefined
          : {
              mode: config.approvals.mode,
              ...(config.approvals.rules === undefined ? {} : { rules: config.approvals.rules }),
              ...(config.approvals.fallback === undefined
                ? {}
                : { fallback: config.approvals.fallback }),
            };
      const approval = config.approval ?? buildApprovalPolicy(approvalConfig);
      return defineMcpClientConnection({
        approval,
        auth: {
          principalType: "user",
          async getToken() {
            const token = await config.getToken(connectorContext);
            if (token === null) {
              throw new ConnectionAuthorizationRequiredError(CONNECTION_NAME, {
                message: "The current user has no ChatGPT connector credential.",
              });
            }
            return { token };
          },
          ...(config.evictToken === undefined
            ? {}
            : { evict: async () => await config.evictToken!(connectorContext) }),
        },
        description:
          "The current user's authorized ChatGPT connectors. The backing OpenAI MCP endpoint is experimental and undocumented.",
        headers: {
          "X-OpenAI-Product-Sku": "codex",
          originator: "codex_cli_rs",
        },
        instanceKey: instanceKey(principal, config.allowedServices, config.excludedServices),
        toolName: {
          toModelName: (upstreamName) =>
            mapUpstreamServiceName(upstreamName, MAX_MODEL_TOOL_NAME_LENGTH),
        },
        tools: {
          filter: (upstreamName) =>
            connectorToolFilter(upstreamName, config.allowedServices, config.excludedServices),
        },
        url: config.baseUrl ?? DEFAULT_BASE_URL,
      });
    },
  },
});
