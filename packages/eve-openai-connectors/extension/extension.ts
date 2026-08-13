import type { Approval } from "eve/tools";
import { defineExtension } from "eve/extension";
import { z } from "zod";

import type {
  ConnectorContext,
  ConnectorsLogger,
  ConnectorToolItem,
  CreateConnectorsOptions,
} from "./lib/types.js";

type GetToken = CreateConnectorsOptions["getToken"];
type GetPrincipal = (ctx: ConnectorContext) => string | null;
type ApprovalFor = (item: ConnectorToolItem) => Approval;
type TransformCallInput = NonNullable<CreateConnectorsOptions["transformCallInput"]>;
type OnAuthError = NonNullable<CreateConnectorsOptions["onAuthError"]>;
type OnResolution = NonNullable<CreateConnectorsOptions["onResolution"]>;

const approvalAction = z.enum(["allow", "approve", "deny"]);
const approvalRule = z.object({
  match: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  action: approvalAction,
});

const config = z
  .object({
    getToken: z.custom<GetToken>((value) => typeof value === "function", {
      message: "getToken must be a function.",
    }),
    getPrincipal: z
      .custom<GetPrincipal>((value) => typeof value === "function", {
        message: "getPrincipal must be a function.",
      })
      .optional(),
    enabled: z.boolean().default(true),
    allowedServices: z.array(z.string().trim().min(1)).optional(),
    excludedServices: z.array(z.string().trim().min(1)).optional(),
    discovery: z.enum(["client", "search", "deferred"]).default("client"),
    protocolClientLifetime: z.enum(["principal", "operation"]).default("principal"),
    baseUrl: z.string().url().optional(),
    inventoryTtlMs: z.number().int().positive().optional(),
    maxMaterializedTools: z.number().int().nonnegative().optional(),
    searchLimitDefault: z.number().int().positive().optional(),
    searchLimitMax: z.number().int().positive().optional(),
    clientSearchMaxBytes: z.number().int().positive().optional(),
    clientSearchTimeoutMs: z.number().int().positive().optional(),
    includeStatus: z.boolean().default(true),
    approvals: z
      .object({
        mode: z.enum(["simple", "detailed"]).default("simple"),
        rules: z.array(approvalRule).optional(),
        fallback: approvalAction.optional(),
      })
      .optional(),
    approvalFor: z
      .custom<ApprovalFor>((value) => typeof value === "function", {
        message: "approvalFor must be a function.",
      })
      .optional(),
    transformCallInput: z
      .custom<TransformCallInput>((value) => typeof value === "function", {
        message: "transformCallInput must be a function.",
      })
      .optional(),
    onAuthError: z
      .custom<OnAuthError>((value) => typeof value === "function", {
        message: "onAuthError must be a function.",
      })
      .optional(),
    onResolution: z
      .custom<OnResolution>((value) => typeof value === "function", {
        message: "onResolution must be a function.",
      })
      .optional(),
    logger: z
      .custom<ConnectorsLogger>(
        (value) =>
          typeof value === "object" &&
          value !== null &&
          typeof (value as ConnectorsLogger).warn === "function" &&
          typeof (value as ConnectorsLogger).error === "function",
        { message: "logger must provide warn(message) and error(message)." },
      )
      .optional(),
  })
  .refine(
    (value) =>
      value.searchLimitDefault === undefined ||
      value.searchLimitMax === undefined ||
      value.searchLimitDefault <= value.searchLimitMax,
    {
      message: "searchLimitDefault must not exceed searchLimitMax.",
      path: ["searchLimitDefault"],
    },
  );

export default defineExtension({ config });
