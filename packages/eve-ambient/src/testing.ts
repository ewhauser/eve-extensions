import { randomUUID } from "node:crypto";
import type {
  JsonValue,
  MonitorBindingView,
  MonitorClock,
  MonitorDeliveryChannel,
  MonitorDeliveryReceipt,
  MonitorDeliveryRequest,
  MonitorEvidenceSnapshot,
  MonitorLifecycleEvent,
  MonitorObserver,
} from "./types.js";
import { BindingConflictError } from "./types.js";
import { scopedKey } from "./storage.js";
import { canonicalJson, cloneJson, freeze, stableHash } from "./util.js";

export class VirtualMonitorClock implements MonitorClock {
  #milliseconds: number;

  constructor(initial: string | Date = "2026-01-01T00:00:00.000Z") {
    this.#milliseconds = new Date(initial).getTime();
    if (!Number.isFinite(this.#milliseconds)) throw new TypeError("invalid initial clock time");
  }

  now(): Date {
    return new Date(this.#milliseconds);
  }

  advance(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new TypeError("clock advance must be a non-negative finite number");
    }
    this.#milliseconds += milliseconds;
  }

  set(value: string | Date): void {
    const next = new Date(value).getTime();
    if (!Number.isFinite(next) || next < this.#milliseconds) {
      throw new TypeError("virtual clock cannot move backwards");
    }
    this.#milliseconds = next;
  }
}

export class RecordingMonitorObserver implements MonitorObserver {
  readonly events: MonitorLifecycleEvent[] = [];

  emit(event: MonitorLifecycleEvent): void {
    this.events.push(structuredClone(event));
  }

  named(name: MonitorLifecycleEvent["name"]): readonly MonitorLifecycleEvent[] {
    return this.events.filter((event) => event.name === name);
  }
}

interface MemoryBinding {
  readonly bindingRef: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly targetHash: string;
  readonly target: JsonValue;
  readonly sessionId: string;
  readonly generation: number;
  status: "active" | "idle" | "terminal";
  readonly subjects: Map<string, string>;
  agentHasParticipated: boolean;
  lastAgentTurnAt?: string;
  lastAgentOutputAt?: string;
  lastHumanTurnAt?: string;
  activeTurnId?: string;
  pendingMonitorTurnId?: string;
  readonly pendingMonitorEvidence: MonitorEvidenceSnapshot[];
  readonly queuedHumanTurns: string[];
}

/**
 * A conformance delivery channel with one authoritative binding registry and
 * monitor-only coalescing. It is intended for tests, not production storage.
 */
export class MemoryConversationChannel<TTarget extends JsonValue = JsonValue>
  implements MonitorDeliveryChannel<TTarget>
{
  readonly id: string;
  readonly deliveries: MonitorDeliveryRequest<TTarget>[] = [];
  readonly #clock: MonitorClock;
  readonly #bindingsByRef = new Map<string, MemoryBinding>();
  readonly #activeByTarget = new Map<string, string>();
  readonly #receipts = new Map<string, MonitorDeliveryReceipt>();

  constructor(options: { readonly id: string; readonly clock?: MonitorClock | undefined }) {
    this.id = options.id;
    this.#clock = options.clock ?? { now: () => new Date() };
  }

  async deliver(request: MonitorDeliveryRequest<TTarget>): Promise<MonitorDeliveryReceipt> {
    const duplicate = this.#receipts.get(request.idempotencyKey);
    if (duplicate !== undefined) return structuredClone(duplicate);
    const targetHash = this.#targetHash(request.tenantId, request.applicationId, request.target);
    let binding = this.#resolveBinding(request, targetHash);
    if (binding === undefined || binding.status === "terminal") {
      binding = this.#createBinding(request, targetHash, (binding?.generation ?? 0) + 1);
    }
    binding.status = "active";
    if (request.correlationSubject !== undefined) {
      binding.subjects.set(request.correlationSubject.namespace, request.correlationSubject.key);
    }
    const now = this.#clock.now().toISOString();
    let turnId: string;
    let outcome: "accepted" | "coalesced";
    if (binding.activeTurnId !== undefined) {
      binding.pendingMonitorEvidence.push(structuredClone(request.evidence));
      binding.pendingMonitorTurnId ??= `turn_${randomUUID()}`;
      turnId = binding.pendingMonitorTurnId;
      outcome = "coalesced";
    } else {
      turnId = `turn_${randomUUID()}`;
      binding.activeTurnId = turnId;
      binding.lastAgentTurnAt = now;
      outcome = "accepted";
    }
    const receipt: MonitorDeliveryReceipt = {
      binding: bindingView(binding),
      sessionId: binding.sessionId,
      turnId,
      outcome,
    };
    this.deliveries.push(structuredClone(request));
    this.#receipts.set(request.idempotencyKey, receipt);
    return structuredClone(receipt);
  }

  /** Adds a human turn without ever merging it into monitor evidence. */
  acceptHumanTurn(bindingRef: string): string {
    const binding = this.#expectBinding(bindingRef);
    if (binding.status === "terminal") throw new Error("cannot accept a turn on a terminal binding");
    const turnId = `turn_${randomUUID()}`;
    binding.status = "active";
    binding.lastHumanTurnAt = this.#clock.now().toISOString();
    if (binding.activeTurnId === undefined) binding.activeTurnId = turnId;
    else binding.queuedHumanTurns.push(turnId);
    return turnId;
  }

  /** Completes the active turn and starts the next human or consolidated monitor turn. */
  completeActiveTurn(
    bindingRef: string,
    options: { readonly agentOutput?: boolean | undefined } = {},
  ): string | null {
    const binding = this.#expectBinding(bindingRef);
    if (binding.activeTurnId === undefined) return null;
    const now = this.#clock.now().toISOString();
    if (options.agentOutput ?? true) {
      binding.agentHasParticipated = true;
      binding.lastAgentOutputAt = now;
    }
    delete binding.activeTurnId;
    const human = binding.queuedHumanTurns.shift();
    if (human !== undefined) {
      binding.activeTurnId = human;
      return human;
    }
    if (binding.pendingMonitorTurnId !== undefined) {
      binding.activeTurnId = binding.pendingMonitorTurnId;
      delete binding.pendingMonitorTurnId;
      binding.pendingMonitorEvidence.splice(0);
      binding.lastAgentTurnAt = now;
      return binding.activeTurnId;
    }
    binding.status = "idle";
    return null;
  }

  terminate(bindingRef: string): void {
    const binding = this.#expectBinding(bindingRef);
    binding.status = "terminal";
    delete binding.activeTurnId;
    this.#activeByTarget.delete(binding.targetHash);
  }

  getBinding(bindingRef: string): MonitorBindingView | null {
    const binding = this.#bindingsByRef.get(bindingRef);
    return binding === undefined ? null : bindingView(binding);
  }

  #resolveBinding(
    request: MonitorDeliveryRequest<TTarget>,
    targetHash: string,
  ): MemoryBinding | undefined {
    const targetRef = this.#activeByTarget.get(targetHash);
    const targetBinding = targetRef === undefined ? undefined : this.#bindingsByRef.get(targetRef);
    if (
      targetBinding !== undefined &&
      (targetBinding.tenantId !== request.tenantId ||
        targetBinding.applicationId !== request.applicationId)
    ) {
      throw new BindingConflictError("canonical target crossed a tenant or application boundary");
    }
    if (request.bindingRef === undefined) return targetBinding;
    const supplied = this.#bindingsByRef.get(request.bindingRef);
    if (supplied === undefined) throw new BindingConflictError("unknown binding reference");
    if (supplied.tenantId !== request.tenantId || supplied.applicationId !== request.applicationId) {
      throw new BindingConflictError("binding reference crossed a tenant or application boundary");
    }
    if (supplied.targetHash === targetHash) {
      return supplied.status === "terminal" ? targetBinding ?? supplied : supplied;
    }
    if (supplied.status !== "terminal") {
      throw new BindingConflictError("binding reference and target resolve to different active sessions");
    }
    return targetBinding;
  }

  #createBinding(
    request: MonitorDeliveryRequest<TTarget>,
    targetHash: string,
    generation: number,
  ): MemoryBinding {
    const binding: MemoryBinding = {
      bindingRef: `binding_${randomUUID()}`,
      tenantId: request.tenantId,
      applicationId: request.applicationId,
      targetHash,
      target: cloneJson(request.target),
      sessionId: `session_${randomUUID()}`,
      generation,
      status: "active",
      subjects: new Map(),
      agentHasParticipated: false,
      pendingMonitorEvidence: [],
      queuedHumanTurns: [],
    };
    this.#bindingsByRef.set(binding.bindingRef, binding);
    this.#activeByTarget.set(targetHash, binding.bindingRef);
    return binding;
  }

  #targetHash(tenantId: string, applicationId: string, target: TTarget): string {
    return stableHash(scopedKey(tenantId, applicationId, canonicalJson(target)));
  }

  #expectBinding(ref: string): MemoryBinding {
    const binding = this.#bindingsByRef.get(ref);
    if (binding === undefined) throw new Error(`unknown binding ${ref}`);
    return binding;
  }
}

function bindingView(binding: MemoryBinding): MonitorBindingView {
  return freeze({
    bindingRef: binding.bindingRef,
    status: binding.status,
    agentHasParticipated: binding.agentHasParticipated,
    ...(binding.lastAgentTurnAt === undefined ? {} : { lastAgentTurnAt: binding.lastAgentTurnAt }),
    ...(binding.lastAgentOutputAt === undefined ? {} : { lastAgentOutputAt: binding.lastAgentOutputAt }),
    ...(binding.lastHumanTurnAt === undefined ? {} : { lastHumanTurnAt: binding.lastHumanTurnAt }),
  });
}
