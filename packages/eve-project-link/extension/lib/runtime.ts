import extension from "../extension.js";
import { defaultProjectChannelResolver } from "./channel.js";
import { ProjectLinkService } from "./project-link.js";
import type { DynamicResolveContext } from "eve/tools";
import type { ProjectChannel } from "./types.js";

let configuredFor: object | undefined;
let configuredService: ProjectLinkService | undefined;

export function getProjectLinkService(): ProjectLinkService {
  const config = extension.config;
  if (configuredService && configuredFor === config) return configuredService;

  configuredFor = config;
  configuredService = new ProjectLinkService({
    store: config.store,
    providers: config.providers,
    defaultProvider: config.defaultProvider,
    provisioningTimeoutMs: config.provisioningTimeoutMs,
    ...(config.logger === undefined ? {} : { logger: config.logger }),
  });
  return configuredService;
}

export async function resolveProjectChannel(
  ctx: DynamicResolveContext,
): Promise<ProjectChannel | null> {
  return (extension.config.resolveChannel ?? defaultProjectChannelResolver)(ctx);
}
