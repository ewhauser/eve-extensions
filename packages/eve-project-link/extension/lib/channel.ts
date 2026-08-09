import type { DynamicResolveContext } from "eve/tools";

import type { ProjectChannel } from "./types.js";

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Resolve a channel-level identity from Eve metadata. Slack works out of the
 * box (`teamId` + `channelId`); other adapters can expose the neutral
 * `workspaceId` + `channelId` pair or provide a custom resolver.
 */
export function defaultProjectChannelResolver(
  ctx: DynamicResolveContext,
): ProjectChannel | null {
  const kind = nonEmptyString(ctx.channel.kind);
  const metadata = ctx.channel.metadata;
  if (!kind || !metadata) return null;

  const workspaceId =
    nonEmptyString(metadata.workspaceId) ?? nonEmptyString(metadata.teamId);
  const channelId = nonEmptyString(metadata.channelId);
  if (!workspaceId || !channelId) return null;

  return { kind, workspaceId, channelId };
}

/** Collision-safe key suitable for maps, KV stores, and database unique keys. */
export function projectChannelKey(channel: ProjectChannel): string {
  return JSON.stringify([channel.kind, channel.workspaceId, channel.channelId]);
}

export function sameProjectChannel(
  left: ProjectChannel,
  right: ProjectChannel,
): boolean {
  return projectChannelKey(left) === projectChannelKey(right);
}
