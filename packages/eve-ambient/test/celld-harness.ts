/**
 * An in-process celld fleet for tests.
 *
 * The cells are the real `MonitorInstance` class from `celld-worker/index.ts`
 * — same storage access patterns, same alarm arming, same checkpoint order —
 * running against a Map-backed Durable Object state with a captured alarm and
 * an injected clock and fetch. What the harness fakes is the fleet around
 * them: the HTTP router, cell placement, and alarm dispatch.
 *
 * Alarms never fire on their own: `fireDueAlarms()` dispatches the ones the
 * clock has reached, which is what makes the timing deterministic. A handler
 * that throws leaves its alarm scheduled, the way celld's retry ladder does.
 */

import { MonitorInstance } from "../celld-worker/index.js";
import type { MonitorClock } from "../src/types.js";

export interface FakeStorageEntry {
  readonly key: string;
  readonly value: unknown;
}

export interface FakeDurableObjectState {
  readonly id: { readonly name: string; toString(): string };
  readonly storage: {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    list(options?: { prefix?: string }): Promise<Map<string, unknown>>;
    getAlarm(): Promise<number | null>;
    setAlarm(at: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  /** Set by `blockConcurrencyWhile`; asserts the workaround stayed in place. */
  blockedSections: number;
  alarmAt: number | null;
  readonly map: Map<string, unknown>;
}

export function createFakeDurableObjectState(name: string): FakeDurableObjectState {
  const map = new Map<string, unknown>();
  const state: FakeDurableObjectState = {
    id: { name, toString: () => `fake:${name}` },
    storage: {
      async get(key) {
        return map.get(key);
      },
      async put(key, value) {
        map.set(key, value);
      },
      async delete(key) {
        map.delete(key);
      },
      async list(options) {
        const out = new Map<string, unknown>();
        for (const [key, value] of map) {
          if (options?.prefix === undefined || key.startsWith(options.prefix)) out.set(key, value);
        }
        return out;
      },
      async getAlarm() {
        return state.alarmAt;
      },
      async setAlarm(at: number) {
        state.alarmAt = at;
      },
      async deleteAlarm() {
        state.alarmAt = null;
      },
    },
    async blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      state.blockedSections += 1;
      return callback();
    },
    blockedSections: 0,
    alarmAt: null,
    map,
  };
  return state;
}

export type EvaluatorHandler = (request: Request) => Promise<Response>;

export interface FakeFleetOptions {
  readonly baseUrl?: string;
  readonly secret: string;
  readonly clock: MonitorClock;
  readonly evaluator: EvaluatorHandler;
}

export interface FiredAlarm {
  readonly cellName: string;
  readonly error: unknown;
}

interface Placement {
  readonly state: FakeDurableObjectState;
  readonly cell: MonitorInstance;
  retryCount: number;
}

export class FakeCelldFleet {
  readonly baseUrl: string;
  readonly #secret: string;
  readonly #clock: MonitorClock;
  readonly #cells = new Map<string, Placement>();
  /** Every evaluator request body, in order, for idempotency assertions. */
  readonly evaluations: Record<string, unknown>[] = [];
  #evaluator: EvaluatorHandler;

  constructor(options: FakeFleetOptions) {
    this.baseUrl = options.baseUrl ?? "http://fleet.test";
    this.#secret = options.secret;
    this.#clock = options.clock;
    this.#evaluator = options.evaluator;
  }

  /** Swaps the evaluator, for outage simulations. */
  set evaluator(handler: EvaluatorHandler) {
    this.#evaluator = handler;
  }

  get cellNames(): readonly string[] {
    return [...this.#cells.keys()].sort();
  }

  state(cellName: string): FakeDurableObjectState | undefined {
    return this.#cells.get(cellName)?.state;
  }

  /** The runtime's injected fetch: the fleet's public listener. */
  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as never, init);
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "health") return jsonResponse({ ok: true }, 200);
    if (parts[0] !== "cells" || parts.length < 2) {
      return jsonResponse({ ok: false, error: "not found" }, 404);
    }
    const presented = /^Bearer[ ]+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    if (presented !== this.#secret) {
      return jsonResponse({ ok: false, code: "unauthorized", error: "unauthorized" }, 401);
    }
    const name = decodeURIComponent(parts[1]!);
    const action = parts[2] ?? "state";
    const placement = this.#place(name);
    const inner = new Request(`${this.baseUrl}/${action}`, request);
    inner.headers.set("x-cell-name", name);
    return placement.cell.fetch(inner);
  };

  /**
   * Dispatches every alarm the clock has reached, oldest first. Returns one
   * entry per dispatched alarm; `error` is what celld's ladder would retry.
   */
  async fireDueAlarms(): Promise<readonly FiredAlarm[]> {
    const now = this.#clock.now().getTime();
    const due = [...this.#cells.entries()]
      .filter(([, placement]) => placement.state.alarmAt !== null && placement.state.alarmAt <= now)
      .sort((left, right) => (left[1].state.alarmAt ?? 0) - (right[1].state.alarmAt ?? 0));
    const fired: FiredAlarm[] = [];
    for (const [cellName, placement] of due) {
      const scheduled = placement.state.alarmAt;
      let error: unknown = null;
      try {
        await placement.cell.alarm({ retryCount: placement.retryCount });
        placement.retryCount = 0;
      } catch (thrown) {
        error = thrown;
        placement.retryCount += 1;
        // celld keeps the alarm and re-dispatches it; the handler never got to
        // re-arm, so restore what it was scheduled for.
        placement.state.alarmAt = scheduled;
      }
      fired.push({ cellName, error });
    }
    return fired;
  }

  #place(name: string): Placement {
    let placement = this.#cells.get(name);
    if (placement === undefined) {
      const state = createFakeDurableObjectState(name);
      const env = {
        EVALUATOR_SECRET: this.#secret,
        clock: this.#clock,
        fetch: async (input: string, init: RequestInit): Promise<Response> => {
          const request = new Request(input, init);
          this.evaluations.push((await request.clone().json()) as Record<string, unknown>);
          return this.#evaluator(request);
        },
      };
      placement = { state, cell: new MonitorInstance(state, env), retryCount: 0 };
      this.#cells.set(name, placement);
    }
    return placement;
  }
}

export function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
