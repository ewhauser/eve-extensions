import type { SandboxNetworkPolicy, SandboxSession as EveSandboxSession } from "eve/sandbox";

/** Internal adapter for the pre-0.64 backend implementation. */
export interface SandboxSession extends EveSandboxSession {
  readonly id: string;
  setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void>;
}

export interface SandboxBackendCreateInput {
  readonly templateKey: string | null;
  readonly sessionKey: string;
  readonly existingMetadata?: Record<string, unknown>;
  readonly runtimeContext: { readonly appRoot: string };
  readonly tags?: Readonly<Record<string, string>>;
}

export interface SandboxBackendHandle {
  readonly session: SandboxSession;
  readonly useSessionFn: (options?: unknown) => Promise<SandboxSession>;
  captureState(): Promise<{
    readonly backendName: string;
    readonly metadata: Record<string, unknown>;
    readonly sessionKey: string;
  }>;
  stop(): Promise<void>;
  shutdown(): Promise<void>;
  delete(options?: { readonly abortSignal?: AbortSignal }): Promise<void>;
}

export interface SandboxBackendPrewarmInput {
  readonly templateKey: string;
  readonly bootstrap?: (input: { readonly use: (options?: unknown) => Promise<SandboxSession> }) =>
    void | Promise<void>;
  readonly log?: (message: string) => void;
  readonly runtimeContext: { readonly appRoot: string };
  readonly seedFiles: ReadonlyArray<{ readonly path: string; readonly content: string | Uint8Array }>;
}

export interface SandboxBackend {
  readonly name: string;
  create(input: SandboxBackendCreateInput): Promise<SandboxBackendHandle>;
  prewarm(input: SandboxBackendPrewarmInput): Promise<{ readonly reused: boolean }>;
}

export class SandboxTemplateNotProvisionedError extends Error {
  constructor(input: { readonly backendName: string; readonly templateKey: string }) {
    super(`Sandbox template ${input.templateKey} is not provisioned for ${input.backendName}.`);
    this.name = "SandboxTemplateNotProvisionedError";
  }
}
