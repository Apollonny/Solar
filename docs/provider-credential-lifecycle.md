# Provider credential lifecycle

## Connection identity

Solar binds newly stored model keys to a provider family and canonical base URL
inside the OS-encrypted credential record. Catalog requests, configured status,
save-time reuse and OpenCode startup use the same resolver. Matching a scoped
provider ID alone does not authorize sending a key to another endpoint.

Legacy keys remain readable for their active configured connection. Fallback native
provider aliases are considered only at the provider's default endpoint, with
any explicit alias base URL checked. New writes add connection metadata. Blank
key fields preserve or copy only a matching credential; returning to a provider
can reuse its still-matching bound record. Missing optional image credentials
are reported as unconfigured. Runtime configuration masks missing active-slot
keys instead of implicitly adopting a stale credential.

Key input rejects embedded whitespace, control characters and oversized values.
Base URLs reject non-HTTP(S) schemes, remote plaintext HTTP, URL credentials,
fragments and secret query parameters. Gemini catalog authentication uses the
documented [x-goog-api-key header](https://ai.google.dev/api), not a key in the URL.
Redirects are not followed.

## Check and activation

New or newly copied model keys are checked before committing settings, without
generating model output. Explicit 401/403 failures prevent the save. Official
OpenRouter checks use its authenticated
[current-key endpoint](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key)
before retrieving its model catalog. A catalog response alone does not prove
generation access, credit availability, or permission to use a selected model.
A custom gateway without a models endpoint can save manual model settings;
404/405/501 are allowed for that compatibility case, without claiming verification.

Catalog reads retry transient failures at most three total attempts, with a
15-second per-request timeout and short cancellable backoff. Auth and malformed
catalog errors are not retried. A failed parallel save-time check cancels its
siblings. Game Studio retains the specific connection blocker; transient errors
continue through the existing workflow reconnect policy.

## Storage, rollback and recovery

Settings mutations are serialized and cannot run during an active AI/Game Studio
task. New task starts cannot overlap a settings mutation. The UI freezes inputs
while checking/saving, guards rapid Enter/click submissions, and invalidates old
catalog responses when a key, provider, endpoint or credential donor changes.
Opening Settings preserves `Model default` reasoning.

Every affected credential file and the OpenCode configuration has a captured
precondition. Encryption and validation finish before file commits. Ordinary
write/config/settings failures roll back the exact committed bytes in reverse
order, with checks to preserve independently changed files. Model-ref memory is
restored if its settings write fails. The old executor is shut down only after
successful activation. This is rollback for ordinary failures, not a durable
multi-file crash transaction or an OS-wide exclusive file lock.

An unreadable provider vault can be rebuilt with an explicitly entered Chat key.
The original raw record is first preserved in an OS-encrypted recovery backup.
Unreadable optional asset credential files are also backed up when replaced.
Unrecoverable keys for other providers must be entered again; the UI explains
this. Plaintext parser details and provider response bodies are not returned as
credential errors. Unsupported file sizes and linked/non-file stores are blocked.

Legacy auth migration uses matching credential payloads independently of Solar's
connection metadata, binds the migrated records, and retains its existing
encrypted auth.json restore backup. Migration rollback protects a newer vault.

## Validation scope

Main/renderer TypeScript compilation and application/Windows packaging are checked
for this change. No live credential, generation call or failure-injection test
was run during implementation. Provider authorization and OS-storage recovery
still require acceptance with the user's actual environment.
