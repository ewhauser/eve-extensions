import type {
  MonitorStore,
  MonitorStoreTransaction,
  StoredDeadLetter,
  StoredDefinitionPin,
  StoredDeployment,
  StoredEvent,
  StoredMonitorInstance,
  StoredMonitorRun,
  StoredSubscription,
  SubscriptionStatus,
} from "./storage.js";
import { scopedKey } from "./storage.js";
import { TransientMonitorError } from "./types.js";
import { addMs } from "./util.js";

export interface PostgresQueryResult<TRow extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: readonly TRow[];
  readonly rowCount?: number | null | undefined;
}

export interface PostgresQueryable {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresQueryResult<TRow>>;
}

export interface PostgresClient extends PostgresQueryable {
  release(): void;
}

export interface PostgresPool extends PostgresQueryable {
  connect(): Promise<PostgresClient>;
}

/** Store backed by row data plus advisory-locked PostgreSQL transactions. */
export class PostgresMonitorStore implements MonitorStore {
  readonly #pool: PostgresPool;
  readonly #schema: string;

  constructor(options: { readonly pool: PostgresPool; readonly schema?: string | undefined }) {
    this.#pool = options.pool;
    this.#schema = sqlIdentifier(options.schema ?? "public");
  }

  async transaction<T>(
    lockKey: string,
    callback: (tx: MonitorStoreTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await connectPostgres(this.#pool);
    try {
      await postgresQuery(client, "BEGIN");
      await postgresQuery(client, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
      const result = await callback(new PostgresTransaction(client, this.#schema));
      await postgresQuery(client, "COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async listSubscriptions(input: {
    readonly statuses: readonly SubscriptionStatus[];
    readonly availableBefore: string;
    readonly limit: number;
  }): Promise<readonly StoredSubscription[]> {
    const result = await postgresQuery<{ record: StoredSubscription }>(
      this.#pool,
      `SELECT record
         FROM ${this.#table("eve_ambient_subscriptions")}
        WHERE status = ANY($1::text[])
          AND available_at <= $2::timestamptz
          AND (
            status <> 'processing'
            OR lease_expires_at IS NULL
            OR lease_expires_at <= $2::timestamptz
          )
        ORDER BY available_at, ingress_sequence, id
        LIMIT $3`,
      [input.statuses, input.availableBefore, input.limit],
    );
    return result.rows.map((row) => row.record);
  }

  async listSubscriptionsForMonitor(input: {
    readonly applicationId: string;
    readonly monitorId: string;
  }): Promise<readonly StoredSubscription[]> {
    const result = await postgresQuery<{ record: StoredSubscription }>(
      this.#pool,
      `SELECT record
         FROM ${this.#table("eve_ambient_subscriptions")}
        WHERE application_id = $1 AND monitor_id = $2
        ORDER BY ingress_sequence, id`,
      [input.applicationId, input.monitorId],
    );
    return result.rows.map((row) => row.record);
  }

  async listDueInstances(input: {
    readonly availableBefore: string;
    readonly limit: number;
  }): Promise<readonly StoredMonitorInstance[]> {
    const result = await postgresQuery<{ record: StoredMonitorInstance }>(
      this.#pool,
      `WITH ranked AS (
         SELECT record, tenant_id, id, next_evaluation_at,
                row_number() OVER (PARTITION BY tenant_id ORDER BY next_evaluation_at, id) AS tenant_rank
           FROM ${this.#table("eve_ambient_instances")}
          WHERE active_run_id IS NULL
            AND next_evaluation_at <= $1::timestamptz
       )
       SELECT record
         FROM ranked
        ORDER BY tenant_rank, next_evaluation_at, tenant_id, id
        LIMIT $2`,
      [input.availableBefore, input.limit],
    );
    return result.rows.map((row) => row.record);
  }

  async listDueRuns(input: {
    readonly availableBefore: string;
    readonly limit: number;
  }): Promise<readonly StoredMonitorRun[]> {
    const result = await postgresQuery<{ record: StoredMonitorRun }>(
      this.#pool,
      `WITH ranked AS (
         SELECT record, tenant_id, id, available_at,
                row_number() OVER (PARTITION BY tenant_id ORDER BY available_at, id) AS tenant_rank
           FROM ${this.#table("eve_ambient_runs")}
          WHERE status = ANY(ARRAY['pending','retry','processing']::text[])
            AND available_at <= $1::timestamptz
            AND (status <> 'processing' OR lease_expires_at IS NULL OR lease_expires_at <= $1::timestamptz)
       )
       SELECT record
         FROM ranked
        ORDER BY tenant_rank, available_at, tenant_id, id
        LIMIT $2`,
      [input.availableBefore, input.limit],
    );
    return result.rows.map((row) => row.record);
  }

  async listInstances(input: {
    readonly applicationId: string;
    readonly monitorId?: string | undefined;
  }): Promise<readonly StoredMonitorInstance[]> {
    const values: unknown[] = [input.applicationId];
    const monitorClause =
      input.monitorId === undefined ? "" : (values.push(input.monitorId), " AND monitor_id = $2");
    const result = await postgresQuery<{ record: StoredMonitorInstance }>(
      this.#pool,
      `SELECT record
         FROM ${this.#table("eve_ambient_instances")}
        WHERE application_id = $1${monitorClause}
        ORDER BY tenant_id, monitor_id, id`,
      values,
    );
    return result.rows.map((row) => row.record);
  }

  async listRuns(input: {
    readonly applicationId: string;
    readonly monitorId?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly StoredMonitorRun[]> {
    const values: unknown[] = [input.applicationId];
    const monitorClause =
      input.monitorId === undefined ? "" : (values.push(input.monitorId), ` AND monitor_id = $${values.length}`);
    values.push(input.limit ?? 100);
    const result = await postgresQuery<{ record: StoredMonitorRun }>(
      this.#pool,
      `SELECT record
         FROM ${this.#table("eve_ambient_runs")}
        WHERE application_id = $1${monitorClause}
        ORDER BY created_at DESC
        LIMIT $${values.length}`,
      values,
    );
    return result.rows.map((row) => row.record);
  }

  async listDeadLetters(input: {
    readonly applicationId: string;
    readonly monitorId?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly StoredDeadLetter[]> {
    const values: unknown[] = [input.applicationId];
    const monitorClause =
      input.monitorId === undefined ? "" : (values.push(input.monitorId), ` AND monitor_id = $${values.length}`);
    values.push(input.limit ?? 100);
    const result = await postgresQuery<{ record: StoredDeadLetter }>(
      this.#pool,
      `SELECT record
         FROM ${this.#table("eve_ambient_dead_letters")}
        WHERE application_id = $1${monitorClause}
        ORDER BY created_at DESC
        LIMIT $${values.length}`,
      values,
    );
    return result.rows.map((row) => row.record);
  }

  async listDefinitionPins(applicationId: string): Promise<readonly StoredDefinitionPin[]> {
    const result = await postgresQuery<{
      kind: StoredDefinitionPin["kind"];
      id: string;
      monitorId: string;
      definitionVersion: string;
    }>(
      this.#pool,
      `SELECT 'subscription'::text AS kind, id, monitor_id AS "monitorId", definition_version AS "definitionVersion"
         FROM ${this.#table("eve_ambient_subscriptions")}
        WHERE application_id = $1
          AND status = ANY(ARRAY['pending','processing','ready']::text[])
       UNION ALL
       SELECT 'instance'::text AS kind, id, monitor_id AS "monitorId", definition_version AS "definitionVersion"
         FROM ${this.#table("eve_ambient_instances")}
        WHERE application_id = $1
       UNION ALL
       SELECT 'run'::text AS kind, id, monitor_id AS "monitorId", record->>'definitionVersion' AS "definitionVersion"
         FROM ${this.#table("eve_ambient_runs")}
        WHERE application_id = $1
          AND status = ANY(ARRAY['pending','processing','retry']::text[])`,
      [applicationId],
    );
    return result.rows;
  }

  async getRun(id: string): Promise<StoredMonitorRun | null> {
    return selectRecord<StoredMonitorRun>(
      this.#pool,
      `SELECT record FROM ${this.#table("eve_ambient_runs")} WHERE id = $1`,
      [id],
    );
  }

  async getEvent(ref: string): Promise<StoredEvent | null> {
    return selectRecord<StoredEvent>(
      this.#pool,
      `SELECT record FROM ${this.#table("eve_ambient_events")} WHERE ref = $1`,
      [ref],
    );
  }

  async purgeExpired(now: string): Promise<{
    readonly events: number;
    readonly runs: number;
    readonly instances: number;
    readonly usage: number;
  }> {
    const client = await connectPostgres(this.#pool);
    try {
      await postgresQuery(client, "BEGIN");
      await postgresQuery(
        client,
        `DELETE FROM ${this.#table("eve_ambient_subscriptions")}
          WHERE event_ref IN (
            SELECT ref FROM ${this.#table("eve_ambient_events")}
             WHERE dedupe_expires_at <= $1::timestamptz
          )`,
        [now],
      );
      const deletedEvents = await postgresQuery(
        client,
        `DELETE FROM ${this.#table("eve_ambient_events")} WHERE dedupe_expires_at <= $1::timestamptz`,
        [now],
      );
      const redacted = await postgresQuery(
        client,
        `UPDATE ${this.#table("eve_ambient_events")}
            SET record = record - 'event'
          WHERE payload_expires_at <= $1::timestamptz
            AND record ? 'event'`,
        [now],
      );
      const deletedRuns = await postgresQuery(
        client,
        `DELETE FROM ${this.#table("eve_ambient_runs")}
          WHERE expires_at <= $1::timestamptz
            AND status = ANY(ARRAY['ignored','shadowed','suppressed','delivered','unroutable','dead-lettered']::text[])`,
        [now],
      );
      const deletedInstances = await postgresQuery(
        client,
        `DELETE FROM ${this.#table("eve_ambient_instances")}
          WHERE expires_at <= $1::timestamptz
            AND active_run_id IS NULL
            AND COALESCE(jsonb_array_length(record->'sealedBatches'), 0) = 0
            AND NOT (record ? 'openBatch')`,
        [now],
      );
      const deletedUsage = await postgresQuery(
        client,
        `DELETE FROM ${this.#table("eve_ambient_usage")} WHERE expires_at <= $1::timestamptz`,
        [now],
      );
      await postgresQuery(client, "COMMIT");
      return {
        events: (redacted.rowCount ?? 0) + (deletedEvents.rowCount ?? 0),
        runs: deletedRuns.rowCount ?? 0,
        instances: deletedInstances.rowCount ?? 0,
        usage: deletedUsage.rowCount ?? 0,
      };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original store failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  #table(name: string): string {
    return `${this.#schema}.${name}`;
  }
}

class PostgresTransaction implements MonitorStoreTransaction {
  readonly #client: PostgresClient;
  readonly #schema: string;

  constructor(client: PostgresClient, schema: string) {
    this.#client = client;
    this.#schema = schema;
  }

  getEventByDedupeKey(key: string): Promise<StoredEvent | null> {
    return selectRecord(
      this.#client,
      `SELECT record FROM ${this.#table("eve_ambient_events")} WHERE dedupe_key = $1 FOR UPDATE`,
      [key],
    );
  }

  getEvent(ref: string): Promise<StoredEvent | null> {
    return selectRecord(
      this.#client,
      `SELECT record FROM ${this.#table("eve_ambient_events")} WHERE ref = $1 FOR UPDATE`,
      [ref],
    );
  }

  async putEvent(event: StoredEvent): Promise<void> {
    await postgresQuery(
      this.#client,
      `INSERT INTO ${this.#table("eve_ambient_events")}
         (ref, dedupe_key, tenant_id, application_id, channel_id, ingress_sequence, payload_expires_at, dedupe_expires_at, record)
       VALUES ($1,$2,$3,$4,$5,$6::bigint,$7::timestamptz,$8::timestamptz,$9::jsonb)
       ON CONFLICT (dedupe_key) DO UPDATE SET
         ref = EXCLUDED.ref,
         tenant_id = EXCLUDED.tenant_id,
         application_id = EXCLUDED.application_id,
         channel_id = EXCLUDED.channel_id,
         ingress_sequence = EXCLUDED.ingress_sequence,
         payload_expires_at = EXCLUDED.payload_expires_at,
         dedupe_expires_at = EXCLUDED.dedupe_expires_at,
         record = EXCLUDED.record`,
      [
        event.ref,
        event.dedupeKey,
        event.tenantId,
        event.applicationId,
        event.channelId,
        event.ingressSequence,
        event.payloadExpiresAt,
        event.dedupeExpiresAt,
        JSON.stringify(event),
      ],
    );
  }

  getSubscription(id: string): Promise<StoredSubscription | null> {
    return selectRecord(
      this.#client,
      `SELECT record FROM ${this.#table("eve_ambient_subscriptions")} WHERE id = $1 FOR UPDATE`,
      [id],
    );
  }

  async putSubscription(subscription: StoredSubscription): Promise<void> {
    await postgresQuery(
      this.#client,
      `INSERT INTO ${this.#table("eve_ambient_subscriptions")}
         (id, event_ref, tenant_id, application_id, monitor_id, definition_version, ingress_sequence, status, available_at, lease_expires_at, record)
       VALUES ($1,$2,$3,$4,$5,$6,$7::bigint,$8,$9::timestamptz,$10::timestamptz,$11::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         monitor_id = EXCLUDED.monitor_id,
         definition_version = EXCLUDED.definition_version,
         status = EXCLUDED.status,
         available_at = EXCLUDED.available_at,
         lease_expires_at = EXCLUDED.lease_expires_at,
         record = EXCLUDED.record`,
      [
        subscription.id,
        subscription.eventRef,
        subscription.tenantId,
        subscription.applicationId,
        subscription.monitorId,
        subscription.definitionVersion,
        subscription.ingressSequence,
        subscription.status,
        subscription.availableAt,
        subscription.leaseExpiresAt ?? null,
        JSON.stringify(subscription),
      ],
    );
  }

  async deleteSubscription(id: string): Promise<void> {
    await postgresQuery(
      this.#client,
      `DELETE FROM ${this.#table("eve_ambient_subscriptions")} WHERE id = $1`,
      [id],
    );
  }

  getInstance(id: string): Promise<StoredMonitorInstance | null> {
    return selectRecord(
      this.#client,
      `SELECT record FROM ${this.#table("eve_ambient_instances")} WHERE id = $1 FOR UPDATE`,
      [id],
    );
  }

  async putInstance(instance: StoredMonitorInstance): Promise<void> {
    await postgresQuery(
      this.#client,
      `INSERT INTO ${this.#table("eve_ambient_instances")}
         (id, tenant_id, application_id, monitor_id, definition_version, next_evaluation_at, active_run_id, expires_at, record)
       VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7,$8::timestamptz,$9::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         monitor_id = EXCLUDED.monitor_id,
         definition_version = EXCLUDED.definition_version,
         next_evaluation_at = EXCLUDED.next_evaluation_at,
         active_run_id = EXCLUDED.active_run_id,
         expires_at = EXCLUDED.expires_at,
         record = EXCLUDED.record`,
      [
        instance.id,
        instance.tenantId,
        instance.applicationId,
        instance.monitorId,
        instance.definitionVersion,
        instance.nextEvaluationAt ?? null,
        instance.activeRunId ?? null,
        instance.expiresAt,
        JSON.stringify(instance),
      ],
    );
  }

  async deleteInstance(id: string): Promise<void> {
    await postgresQuery(
      this.#client,
      `DELETE FROM ${this.#table("eve_ambient_instances")} WHERE id = $1`,
      [id],
    );
  }

  getRun(id: string): Promise<StoredMonitorRun | null> {
    return selectRecord(
      this.#client,
      `SELECT record FROM ${this.#table("eve_ambient_runs")} WHERE id = $1 FOR UPDATE`,
      [id],
    );
  }

  async putRun(run: StoredMonitorRun): Promise<void> {
    await postgresQuery(
      this.#client,
      `INSERT INTO ${this.#table("eve_ambient_runs")}
         (id, instance_id, tenant_id, application_id, monitor_id, status, available_at, lease_expires_at, created_at, expires_at, record)
       VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz,$9::timestamptz,$10::timestamptz,$11::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         available_at = EXCLUDED.available_at,
         lease_expires_at = EXCLUDED.lease_expires_at,
         expires_at = EXCLUDED.expires_at,
         record = EXCLUDED.record`,
      [
        run.id,
        run.instanceId,
        run.tenantId,
        run.applicationId,
        run.monitorId,
        run.status,
        run.availableAt,
        run.leaseExpiresAt ?? null,
        run.createdAt,
        run.expiresAt,
        JSON.stringify(run),
      ],
    );
  }

  async putDeadLetter(deadLetter: StoredDeadLetter): Promise<void> {
    await postgresQuery(
      this.#client,
      `INSERT INTO ${this.#table("eve_ambient_dead_letters")}
         (id, application_id, monitor_id, created_at, record)
       VALUES ($1,$2,$3,$4::timestamptz,$5::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        deadLetter.id,
        deadLetter.applicationId,
        deadLetter.monitorId ?? null,
        deadLetter.createdAt,
        JSON.stringify(deadLetter),
      ],
    );
  }

  getDeployment(applicationId: string): Promise<StoredDeployment | null> {
    return selectRecord(
      this.#client,
      `SELECT record FROM ${this.#table("eve_ambient_deployments")} WHERE application_id = $1 FOR UPDATE`,
      [applicationId],
    );
  }

  async putDeployment(deployment: StoredDeployment): Promise<void> {
    await postgresQuery(
      this.#client,
      `INSERT INTO ${this.#table("eve_ambient_deployments")} (application_id, record)
       VALUES ($1,$2::jsonb)
       ON CONFLICT (application_id) DO UPDATE SET record = EXCLUDED.record`,
      [deployment.applicationId, JSON.stringify(deployment)],
    );
  }

  async nextIngressSequence(scope: string): Promise<string> {
    const result = await postgresQuery<{ value: string }>(
      this.#client,
      `INSERT INTO ${this.#table("eve_ambient_sequences")} (scope, value)
       VALUES ($1, 1)
       ON CONFLICT (scope) DO UPDATE SET value = ${this.#table("eve_ambient_sequences")}.value + 1
       RETURNING value::text AS value`,
      [scope],
    );
    const value = result.rows[0]?.value;
    if (value === undefined) throw new Error("PostgreSQL did not return an ingress sequence");
    return value;
  }

  async hasEarlierOpenSubscription(input: {
    readonly tenantId: string;
    readonly applicationId: string;
    readonly monitorId: string;
    readonly definitionVersion: string;
    readonly ingressSequence: string;
  }): Promise<boolean> {
    const result = await postgresQuery<{ exists: boolean }>(
      this.#client,
      `SELECT EXISTS (
         SELECT 1
           FROM ${this.#table("eve_ambient_subscriptions")}
          WHERE tenant_id = $1
            AND application_id = $2
            AND monitor_id = $3
            AND definition_version = $4
            AND ingress_sequence < $5::bigint
            AND status = ANY(ARRAY['pending','processing','ready']::text[])
       ) AS exists`,
      [
        input.tenantId,
        input.applicationId,
        input.monitorId,
        input.definitionVersion,
        input.ingressSequence,
      ],
    );
    return result.rows[0]?.exists ?? false;
  }

  async reserveUsage(input: {
    readonly id: string;
    readonly scope: string;
    readonly metric: string;
    readonly amount: number;
    readonly limit: number;
    readonly windowMs: number;
    readonly now: string;
  }): Promise<{ readonly allowed: true } | { readonly allowed: false; readonly retryAt: string }> {
    await postgresQuery(
      this.#client,
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [scopedKey(input.scope, input.metric)],
    );
    const duplicate = await postgresQuery<{ id: string }>(
      this.#client,
      `SELECT id FROM ${this.#table("eve_ambient_usage")} WHERE id = $1`,
      [input.id],
    );
    if (duplicate.rows.length > 0) return { allowed: true };
    const windowStart = addMs(input.now, -input.windowMs);
    const current = await postgresQuery<{ used: string; oldest: string | null }>(
      this.#client,
      `SELECT COALESCE(sum(amount), 0)::text AS used, min(occurred_at)::text AS oldest
         FROM ${this.#table("eve_ambient_usage")}
        WHERE scope = $1 AND metric = $2
          AND occurred_at > $3::timestamptz
          AND expires_at > $4::timestamptz`,
      [input.scope, input.metric, windowStart, input.now],
    );
    const row = current.rows[0];
    const used = Number(row?.used ?? 0);
    if (used + input.amount > input.limit) {
      return {
        allowed: false,
        retryAt: row?.oldest === null || row?.oldest === undefined
          ? addMs(input.now, input.windowMs)
          : addMs(row.oldest, input.windowMs),
      };
    }
    await postgresQuery(
      this.#client,
      `INSERT INTO ${this.#table("eve_ambient_usage")}
         (id, scope, metric, amount, occurred_at, expires_at)
       VALUES ($1,$2,$3,$4,$5::timestamptz,$6::timestamptz)`,
      [input.id, input.scope, input.metric, input.amount, input.now, addMs(input.now, input.windowMs)],
    );
    return { allowed: true };
  }

  #table(name: string): string {
    return `${this.#schema}.${name}`;
  }
}

async function selectRecord<T>(
  queryable: PostgresQueryable,
  query: string,
  values: readonly unknown[],
): Promise<T | null> {
  const result = await postgresQuery<{ record: T }>(queryable, query, values);
  return result.rows[0]?.record ?? null;
}

async function connectPostgres(pool: PostgresPool): Promise<PostgresClient> {
  try {
    return await pool.connect();
  } catch (error) {
    throw new TransientMonitorError("PostgreSQL monitor store connection failed", { cause: error });
  }
}

async function postgresQuery<TRow extends Record<string, unknown> = Record<string, unknown>>(
  queryable: PostgresQueryable,
  query: string,
  values?: readonly unknown[],
): Promise<PostgresQueryResult<TRow>> {
  try {
    return await queryable.query<TRow>(query, values);
  } catch (error) {
    if (error instanceof TransientMonitorError) throw error;
    throw new TransientMonitorError("PostgreSQL monitor store operation failed", { cause: error });
  }
}

function sqlIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new TypeError("invalid PostgreSQL schema name");
  return `"${value}"`;
}
