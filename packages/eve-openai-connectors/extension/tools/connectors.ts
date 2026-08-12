import { defineDynamic, defineTool, type DynamicToolEntry } from "eve/tools";

import extension from "../extension.js";
import {
  createConnectors,
  DEFER_PROVIDER_OPTIONS,
  type Connectors,
} from "../lib/connectors.js";
import { getOrCreateDeferredToolSet } from "../lib/tool-cache.js";
import type { ApprovalsConfig, CreateConnectorsOptions } from "../lib/types.js";

let configuredFor: object | undefined;
let configuredConnectors: Connectors | undefined;

function getConnectors(): Connectors {
  const config = extension.config;
  if (configuredConnectors !== undefined && configuredFor === config) {
    return configuredConnectors;
  }

  const options: CreateConnectorsOptions = {
    getToken: config.getToken,
    enabled: config.enabled,
    discovery: config.discovery,
    toolPrefix: "",
    maxToolNameLength: 56,
  };
  if (config.allowedServices !== undefined) options.allowedServices = config.allowedServices;
  if (config.getPrincipal !== undefined) options.getPrincipal = config.getPrincipal;
  if (config.baseUrl !== undefined) options.baseUrl = config.baseUrl;
  if (config.inventoryTtlMs !== undefined) options.inventoryTtlMs = config.inventoryTtlMs;
  if (config.maxMaterializedTools !== undefined) {
    options.maxMaterializedTools = config.maxMaterializedTools;
  }
  if (config.searchLimitDefault !== undefined) {
    options.searchLimitDefault = config.searchLimitDefault;
  }
  if (config.searchLimitMax !== undefined) options.searchLimitMax = config.searchLimitMax;
  if (config.approvals !== undefined) {
    const approvals: ApprovalsConfig = { mode: config.approvals.mode };
    if (config.approvals.rules !== undefined) approvals.rules = config.approvals.rules;
    if (config.approvals.fallback !== undefined) approvals.fallback = config.approvals.fallback;
    options.approvals = approvals;
  }
  if (config.approvalFor !== undefined) options.approvalFor = config.approvalFor;
  if (config.logger !== undefined) options.logger = config.logger;

  configuredFor = config;
  configuredConnectors = createConnectors(options);
  return configuredConnectors;
}

const namespaceGuidance =
  " Returned tool names are relative to this extension. Prefix each one with the namespace before `__search` in this tool's name. For example, when this tool is `openai__search`, `github_search_repositories` is callable as `openai__github_search_repositories`.";

export default defineDynamic({
  events: {
    "step.started": async (_event, ctx) => {
      const connectors = getConnectors();
      const session = await connectors.begin(ctx);
      if (!session) return null;

      const tools: Record<string, DynamicToolEntry<any, any>> = {};

      // Provider-native discovery is the primary path. The patched Eve
      // runtime keeps these schemas deferred and adds the provider's search
      // tool. Approval remains enforced by Eve when a connector is called.
      if (session.deferred.length > 0) {
        if (session.catalogFingerprint === null) return null;
        return getOrCreateDeferredToolSet(
          connectors,
          session.catalogFingerprint,
          session.deferred.length,
          () => {
            const deferredTools: Record<string, DynamicToolEntry<any, any>> = {};
            for (const item of session.deferred) {
              deferredTools[item.name] = defineTool({
                description: item.description,
                inputSchema: item.inputSchema,
                approval: (approvalCtx) => connectors.approvalFor(item)(approvalCtx),
                providerOptions: DEFER_PROVIDER_OPTIONS,
                execute: async (input, toolCtx) =>
                  connectors.call(toolCtx, item.upstream, input, item),
              });
            }
            return Object.freeze(deferredTools);
          },
        );
      }

      // Explicit search mode, or the automatic fallback when the catalog is
      // temporarily unavailable.
      tools[session.searchToolName] = defineTool({
        description: session.searchToolDescription + namespaceGuidance,
        inputSchema: session.searchInputSchema,
        execute: async (input, toolCtx) => connectors.search(toolCtx, input),
      });

      if (extension.config.includeStatus) {
        tools[session.statusToolName] = defineTool({
          description: session.statusToolDescription,
          inputSchema: session.statusInputSchema,
          execute: async (_input, toolCtx) => connectors.status(toolCtx),
        });
      }

      for (const item of session.discovered) {
        tools[item.name] = defineTool({
          description: item.description,
          inputSchema: item.inputSchema,
          approval: (approvalCtx) => connectors.approvalFor(item)(approvalCtx),
          execute: async (input, toolCtx) =>
            connectors.call(toolCtx, item.upstream, input, item),
        });
      }

      return tools;
    },
  },
});
