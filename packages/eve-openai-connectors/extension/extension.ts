import { defineExtension } from "eve/extension";
import type { Approval } from "eve/tools/approval";
import { z } from "zod";

import type { ConnectorContext } from "./lib/types.js";

type GetToken = (ctx: ConnectorContext) => Promise<string | null> | string | null;
type GetPrincipal = (ctx: ConnectorContext) => string | null;
type EvictToken = (ctx: ConnectorContext) => Promise<void> | void;

const approvalAction = z.enum(["allow", "approve", "deny"]);
const approvalRule = z.object({
  match: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  action: approvalAction,
});

const config = z.object({
  getToken: z.custom<GetToken>((value) => typeof value === "function", {
    message: "getToken must be a function.",
  }),
  getPrincipal: z
    .custom<GetPrincipal>((value) => typeof value === "function", {
      message: "getPrincipal must be a function.",
    })
    .optional(),
  evictToken: z
    .custom<EvictToken>((value) => typeof value === "function", {
      message: "evictToken must be a function.",
    })
    .optional(),
  enabled: z.boolean().default(true),
  allowedServices: z.array(z.string().trim().min(1)).optional(),
  excludedServices: z.array(z.string().trim().min(1)).optional(),
  baseUrl: z.string().url().optional(),
  approvals: z
    .object({
      mode: z.enum(["simple", "detailed"]).default("simple"),
      rules: z.array(approvalRule).optional(),
      fallback: approvalAction.optional(),
    })
    .optional(),
  approval: z
    .custom<Approval>(
      (value) =>
        typeof value === "function" ||
        (typeof value === "object" &&
          value !== null &&
          typeof (value as { request?: unknown }).request === "function"),
      { message: "approval must be an Eve approval callback or configuration." },
    )
    .optional(),
});

export default defineExtension({ config }, "eve-openai-connectors");
