import type { SessionContext } from "eve/context";
import type {
  ApprovalConfiguration,
  ApprovalResponseContext,
  DynamicResolveContext,
} from "eve/tools";

import type {
  OwnerResolutionInput,
  OwnerResolutionResult,
  OwnerScope,
} from "../domain.js";

type RuntimeChannel = Readonly<{
  readonly kind?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}>;

export function ownerChannelFromContext(input: RuntimeChannel): OwnerResolutionInput["channel"] {
  return {
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  };
}

export function ownerInputFromDynamic(ctx: DynamicResolveContext): OwnerResolutionInput {
  return {
    current: ctx.session.auth.current,
    initiator: ctx.session.auth.initiator,
    channel: ownerChannelFromContext(ctx.channel),
  };
}

export function ownerInputFromSession(
  ctx: SessionContext,
  runtimeChannel: OwnerResolutionInput["channel"] = {},
): OwnerResolutionInput {
  return {
    current: ctx.session.auth.current,
    initiator: ctx.session.auth.initiator,
    channel: runtimeChannel,
  };
}

export function ownersEqual(left: OwnerScope, right: OwnerScope): boolean {
  return left.tenantKey === right.tenantKey && left.ownerKey === right.ownerKey;
}

export function ownerCacheKey(owner: OwnerScope): string {
  return JSON.stringify([owner.tenantKey, owner.ownerKey]);
}

export function createOwnerApproval(input: {
  readonly owner: OwnerScope;
  readonly channel: OwnerResolutionInput["channel"];
  readonly resolveOwner: (input: OwnerResolutionInput) => Promise<OwnerResolutionResult>;
}): ApprovalConfiguration<unknown> {
  return {
    request: () => "user-approval",
    response: async (ctx: ApprovalResponseContext<unknown>) => {
      const resolved = await input.resolveOwner({
        current: ctx.responder,
        initiator: ctx.session.initiator,
        channel: input.channel,
      });
      return resolved.ok && ownersEqual(resolved.owner, input.owner)
        ? { status: "allowed" }
        : { status: "rejected", reason: "OWNER_MISMATCH" };
    },
  };
}
