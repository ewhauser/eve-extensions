import type { SessionContext } from "eve/context";
import type { DynamicResolveContext } from "eve/tools";

import type { OwnerResolutionInput, OwnerScope } from "../domain.js";

function channel(input: DynamicResolveContext["channel"]): OwnerResolutionInput["channel"] {
  return {
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  };
}

export function ownerInputFromDynamic(ctx: DynamicResolveContext): OwnerResolutionInput {
  return {
    current: ctx.session.auth.current,
    initiator: ctx.session.auth.initiator,
    channel: channel(ctx.channel),
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
