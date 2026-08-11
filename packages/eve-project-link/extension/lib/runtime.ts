import { getProjectLinkConfig } from "../extension.js";
import { defaultProjectChannelResolver } from "./channel.js";
import { ProjectLinkService } from "./project-link.js";
import type { DynamicResolveContext } from "eve/tools";
import type { ProjectChannel } from "./types.js";

let configuredFor: object | undefined;
let configuredService: ProjectLinkService | undefined;

export function getProjectLinkService(): ProjectLinkService {
  const config = getProjectLinkConfig();
  if (configuredService && configuredFor === config) return configuredService;

  configuredFor = config;
  configuredService = new ProjectLinkService({
    store: config.store,
    presets: config.presets,
    ...(config.defaultPreset === undefined
      ? {}
      : { defaultPreset: config.defaultPreset }),
  });
  return configuredService;
}

export async function resolveProjectChannel(
  ctx: DynamicResolveContext,
): Promise<ProjectChannel | null> {
  return (getProjectLinkConfig().resolveChannel ?? defaultProjectChannelResolver)(
    ctx,
  );
}
