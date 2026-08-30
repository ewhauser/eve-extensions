import {
  defineDynamic,
  defineTool,
  type DynamicToolEntry,
  type ToolContext,
} from "eve/tools";
import type {
  Approval,
  ApprovalContext,
  ApprovalResponseContext,
  ApprovalResponseDecision,
  ApprovalStatus,
} from "eve/tools/approval";

import extension from "../extension.js";
import {
  createConnectors,
  DEFER_PROVIDER_OPTIONS,
  type Connectors,
} from "../lib/connectors.js";
import {
  CLIENT_TOOL_SEARCH_DESCRIPTION,
  CLIENT_TOOL_SEARCH_MARKER_INPUT_SCHEMA,
  CLIENT_TOOL_SEARCH_MARKER_NAME,
  CLIENT_TOOL_SEARCH_PROVIDER_OPTIONS,
} from "../lib/client-search.js";
import { getOrCreateDeferredToolSet } from "../lib/tool-cache.js";
import type {
  ApprovalsConfig,
  ConnectorToolItem,
  CreateConnectorsOptions,
  JsonObject,
} from "../lib/types.js";
import {
  connectorWorkingSet,
  mergeConnectorWorkingSet,
  shouldClearConnectorWorkingSet,
} from "../lib/working-set.js";

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
    toolNameFormat: "service-qualified",
    maxToolNameLength: 64,
  };
  if (config.allowedServices !== undefined) options.allowedServices = config.allowedServices;
  if (config.excludedServices !== undefined) options.excludedServices = config.excludedServices;
  options.protocolClientLifetime = config.protocolClientLifetime;
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
  if (config.clientSearchMaxBytes !== undefined) {
    options.clientSearchMaxBytes = config.clientSearchMaxBytes;
  }
  if (config.clientSearchTimeoutMs !== undefined) {
    options.clientSearchTimeoutMs = config.clientSearchTimeoutMs;
  }
  if (config.approvals !== undefined) {
    const approvals: ApprovalsConfig = { mode: config.approvals.mode };
    if (config.approvals.rules !== undefined) approvals.rules = config.approvals.rules;
    if (config.approvals.fallback !== undefined) approvals.fallback = config.approvals.fallback;
    options.approvals = approvals;
  }
  if (config.approvalFor !== undefined) options.approvalFor = config.approvalFor;
  if (config.transformCallInput !== undefined) {
    options.transformCallInput = config.transformCallInput;
  }
  if (config.onAuthError !== undefined) options.onAuthError = config.onAuthError;
  if (config.onResolution !== undefined) options.onResolution = config.onResolution;
  if (config.logger !== undefined) options.logger = config.logger;

  configuredFor = config;
  configuredConnectors = createConnectors(options);
  return configuredConnectors;
}

const ABSOLUTE_DYNAMIC_TOOL_NAME_PREFIX = "eve:absolute:";
const DURABLE_DYNAMIC_TOOL_CALLBACKS = Symbol.for("eve:durable-dynamic-tool-callbacks");

type DurableCallback = (
  closure: JsonObject,
  ...args: readonly unknown[]
) => unknown;

interface DurableCallbackDescriptor {
  readonly callback: DurableCallback;
  readonly closure: JsonObject;
}

interface DurableToolCallbacks {
  readonly execute: DurableCallbackDescriptor;
  readonly approvalRequest?: DurableCallbackDescriptor;
  readonly approvalResponse?: DurableCallbackDescriptor;
}

function stampDurableCallbacks(
  tool: DynamicToolEntry,
  callbacks: DurableToolCallbacks,
): DynamicToolEntry {
  Object.defineProperty(tool, DURABLE_DYNAMIC_TOOL_CALLBACKS, {
    configurable: true,
    value: callbacks,
  });
  return tool;
}

function connectorItemFromClosure(closure: JsonObject): ConnectorToolItem {
  const candidate = closure.item;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new Error("Connector tool callback metadata is invalid.");
  }
  const item = candidate as Partial<ConnectorToolItem>;
  if (
    typeof item.name !== "string" ||
    typeof item.upstream !== "string" ||
    typeof item.service !== "string" ||
    typeof item.description !== "string" ||
    typeof item.inputSchema !== "object" ||
    item.inputSchema === null ||
    Array.isArray(item.inputSchema) ||
    typeof item.readOnly !== "boolean" ||
    typeof item.destructive !== "boolean"
  ) {
    throw new Error("Connector tool callback metadata is invalid.");
  }
  return item as ConnectorToolItem;
}

async function executeMaterializedConnector(
  closure: JsonObject,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const item = connectorItemFromClosure(closure);
  return getConnectors().call(ctx, item.upstream, input, item);
}

async function requestMaterializedConnectorApproval(
  closure: JsonObject,
  ctx: ApprovalContext,
): Promise<ApprovalStatus> {
  const approval = getConnectors().approvalFor(connectorItemFromClosure(closure));
  const request = typeof approval === "function" ? approval : approval.request;
  return request(ctx);
}

async function authorizeMaterializedConnectorApproval(
  closure: JsonObject,
  ctx: ApprovalResponseContext,
): Promise<ApprovalResponseDecision> {
  const approval = getConnectors().approvalFor(connectorItemFromClosure(closure));
  const response = typeof approval === "function" ? undefined : approval.response;
  if (!response) {
    return {
      status: "rejected",
      reason: "Connector approval response authorization is unavailable.",
    };
  }
  return response(ctx);
}

function clientSearchOptionsFromClosure(closure: JsonObject): {
  readonly maxMaterializedTools: number;
  readonly namespace: string;
} {
  const { maxMaterializedTools, namespace } = closure;
  if (
    typeof maxMaterializedTools !== "number" ||
    !Number.isInteger(maxMaterializedTools) ||
    maxMaterializedTools <= 0 ||
    typeof namespace !== "string"
  ) {
    throw new Error("Connector client-search callback metadata is invalid.");
  }
  return { maxMaterializedTools, namespace };
}

async function executeClientToolSearch(
  closure: JsonObject,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const { maxMaterializedTools, namespace } = clientSearchOptionsFromClosure(closure);
  const result = await getConnectors().clientSearch(ctx, input, namespace);
  connectorWorkingSet.update((current) =>
    mergeConnectorWorkingSet(current, {
      authority: result.authority,
      catalogFingerprint: result.catalogFingerprint,
      items: result.items,
      source: "client",
      max: maxMaterializedTools,
    }),
  );
  return result.output;
}

function defineClientToolSearch(maxMaterializedTools: number): DynamicToolEntry {
  const closure = {
    maxMaterializedTools,
    namespace: "",
  } satisfies JsonObject;
  const tool = defineTool({
    description: CLIENT_TOOL_SEARCH_DESCRIPTION,
    inputSchema: CLIENT_TOOL_SEARCH_MARKER_INPUT_SCHEMA,
    providerOptions: CLIENT_TOOL_SEARCH_PROVIDER_OPTIONS,
    execute: (input, ctx) => executeClientToolSearch(closure, input, ctx),
  });
  return stampDurableCallbacks(tool, {
    execute: {
      callback: executeClientToolSearch as DurableCallback,
      closure,
    },
  });
}

function defineMaterializedConnectorTool(
  item: ConnectorToolItem,
  description: string,
  providerOptions?: typeof DEFER_PROVIDER_OPTIONS,
): DynamicToolEntry {
  const approval: Approval = getConnectors().approvalFor(item);
  const tool = defineTool({
    description,
    inputSchema: item.inputSchema,
    approval,
    ...(providerOptions === undefined ? {} : { providerOptions }),
    execute: async (input, ctx) =>
      getConnectors().call(ctx, item.upstream, input, item),
  });
  const closure = { item } as unknown as JsonObject;
  return stampDurableCallbacks(tool, {
    execute: {
      callback: executeMaterializedConnector as DurableCallback,
      closure,
    },
    approvalRequest: {
      callback: requestMaterializedConnectorApproval as DurableCallback,
      closure,
    },
    ...(typeof approval === "function" || approval.response === undefined
      ? {}
      : {
          approvalResponse: {
            callback: authorizeMaterializedConnectorApproval as DurableCallback,
            closure,
          },
        }),
  });
}

function absoluteDynamicToolName(name: string): string {
  return `${ABSOLUTE_DYNAMIC_TOOL_NAME_PREFIX}${name}`;
}

const namespaceGuidance =
  " Returned connector names are exact callable names and already include their service namespace, for example `github__search_repositories`.";

export default defineDynamic({
  events: {
    "step.started": async (_event, ctx) => {
      const connectors = getConnectors();
      const workingSet = connectorWorkingSet.get();
      const session = await connectors.begin(ctx, workingSet);
      if (!session) return null;
      if (
        shouldClearConnectorWorkingSet(
          workingSet,
          session.principal,
          session.catalogFingerprint,
        )
      ) {
        connectorWorkingSet.update(() => null);
      }

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
              deferredTools[absoluteDynamicToolName(item.name)] =
                defineMaterializedConnectorTool(
                  item,
                  item.description,
                  DEFER_PROVIDER_OPTIONS,
                );
            }
            return Object.freeze(deferredTools);
          },
        );
      }

      if (session.clientSearchEnabled) {
        tools[CLIENT_TOOL_SEARCH_MARKER_NAME] = defineClientToolSearch(
          session.maxMaterializedTools,
        );
      }

      if (!session.clientSearchEnabled) {
        // Explicit search mode, or the automatic fallback when a deferred
        // catalog is temporarily unavailable. In client mode the marker
        // itself is the bounded progressive fallback on other providers.
        tools[session.searchToolName] = defineTool({
          description: session.searchToolDescription + namespaceGuidance,
          inputSchema: session.searchInputSchema,
          execute: async (input, toolCtx) => {
            const result = await connectors.search(toolCtx, input);
            connectorWorkingSet.update((current) =>
              mergeConnectorWorkingSet(current, {
                authority: result.authority,
                catalogFingerprint: result.catalogFingerprint,
                items: result.items,
                source: "search",
                max: session.maxMaterializedTools,
              }),
            );
            return result.output;
          },
        });

        if (extension.config.includeStatus) {
          tools[session.statusToolName] = defineTool({
            description: session.statusToolDescription,
            inputSchema: session.statusInputSchema,
            execute: async (_input, toolCtx) => connectors.status(toolCtx),
          });
        }
      }

      for (const item of session.discovered) {
        tools[absoluteDynamicToolName(item.name)] = defineMaterializedConnectorTool(
          item,
          item.description,
        );
      }
      for (const loaded of session.loaded) {
        const item = loaded.item;
        tools[absoluteDynamicToolName(item.name)] = defineMaterializedConnectorTool(
          item,
          loaded.description,
        );
      }

      return tools;
    },
  },
});
