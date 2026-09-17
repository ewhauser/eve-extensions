# Issue #125: bounded MicroVM launch authority

## Plan and implemented design

1. Reproduce the unlimited renewal and expiry-resurrection bugs with fake-clock lease tests.
2. Cap persisted launch expiry at an absolute deadline, independently abort/reject the caller, and pass that signal into the AWS SDK. Keep the cap through controller readiness and restore; promote only a confirmed session to renewable authority.
3. Persist a launch identity before contacting AWS, then persist the exact request and activation before sending `RunMicrovm`. Reuse both across unconfirmed retries. A committed checkpoint or explicitly retired launch ends that identity.
4. Store committed checkpoint metadata in the same S3 document and conditional write as lease ownership. Advance fencing generations on acquisition and retain them on release. Use distinct checkpoint object names for every upload. This avoids the time-of-check/time-of-use gap inherent in checking a lease and then writing a separate manifest.
5. Reject stale results and acquire cleanup authority before termination. Publish the known VM identity/retirement intent before dispatching termination, so even a stalled termination cannot target a VM later adopted by a successor. An idempotent response can name the successor's VM, so unconditional late-result termination is unsafe.
6. Emit allowlisted phase timings and SDK metadata, and exercise timeout, takeover, cancellation, idempotency, and credential-redaction behavior without AWS calls.

## Why a token alone is insufficient

AWS retries must use an identical payload. Creating a new activation envelope while reusing a client token can produce an idempotency mismatch. The pending authority record therefore contains sensitive activation state protected by the existing artifact bucket policy/encryption. It is removed from the current record on checkpoint or retirement; version history requires the bucket's retention policy. Public session metadata remains credential-free.

## Storage and rollout

Durable session authority uses version 2. The new reader imports existing version-1 leases and legacy manifests. Old readers reject version 2 instead of stripping fencing state. Drain old owners before rollout. Downgrading migrated sessions to an older package is unsupported. Session deletion retains an empty authority tombstone; it must not be independently expired while attempts may still be alive.

A checkpoint's publication point is the conditional authority update. The `manifestEtag` returned to Eve is an opaque commit identity; it no longer names the independently mutable legacy manifest object. Uploads that lose publication may leave unreferenced objects for lifecycle cleanup.

## Timing and cancellation limits

The default launch budget is four minutes, below the approximately five-minute workflow attempt in the report; users with shorter attempts must configure a shorter budget. Bucket validation and lazy image/template provisioning precede this session budget. Eve 0.49 does not expose a create-time workflow signal, so the concrete backend accepts an optional signal while the absolute deadline remains mandatory and independent.

S3 compare-and-swap fences publication against takeover, even if a previous write is delayed. A process crash cannot run cleanup; persisted expiry still permits takeover. Termination is best effort, and a successor-owned idempotent result is rejected without termination. No live AWS reproduction or change to the SDK's service-side idempotency retention is part of local validation.

## Test coverage

- Never-settling `RunMicrovm`, blocked metadata/activation, and cooperative transport cancellation.
- Exact token, request payload, and activation reuse across retry; new identity after checkpoint.
- Unowned late success termination, successor-owned late-result rejection, and delayed termination across cleanup lease expiry.
- Stale checkpoint CAS already in flight during takeover, plus distinct upload object names.
- Persisted launch caps, stalled renewals, clock jumps without timer execution, forced ETag loss, generation retention, and normal long-lived renewal.
- Safe SDK request metadata on success/failure, credential-free diagnostics, and launch option validation.

Run `pnpm --filter eve-aws-lambda-microvms test` and `pnpm check` from the repository root.
