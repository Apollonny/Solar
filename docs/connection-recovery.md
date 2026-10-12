# Connection recovery

Solar automatically reconnects after transport failures, empty server responses,
provider timeouts, HTTP 408/425/429 and 5xx responses. Authentication failures,
exhausted quota, invalid artifacts and uncertain writes still need attention.
The selected provider, model and reasoning configuration remain unchanged.

## Microsoft Game Studio

- Microsoft owns model/read stage retries: up to 12 total attempts with
  2, 4, 8, 16 and then 30 second waits. Scheduling stops when the recovery
  window reaches five minutes after the first transient failure. An already
  running request retains its separate role deadline.
- Three minutes without meaningful streamed model/tool progress triggers
  cancellation of a silent model request. A session abort acknowledgement or
  confirmed termination of the read-only executor is required before retry.
- An unexpected orchestrator disconnect can restart the helper up to three
  times, from its saved SDK checkpoint. Initial planning can restart the saved
  request only when no stage was accepted and no write was journaled.
- Successful stages and operation references are reused. Project revision,
  selected model and mutation journal checks remain mandatory on resume.
- No applying, gameplay input or test operation is automatically replayed because
  a server disconnected. An unacknowledged editor write blocks resume.

## Regular chat

- The original request receives a stable OpenCode message ID. After a lost HTTP
  response Solar inspects that same persisted session and assistant parent ID.
  A completed response is recovered instead of generating it again.
- A live session is allowed to finish while it is making progress. A silent
  request is reconciled before a continuation. User questions and active tools
  suppress the local idle watchdog.
- An acknowledged abort and a subsequent exact message lookup distinguish an
  accepted request from one that never arrived. Only explicit 404/410 absence
  permits resending the original message. Accepted requests continue with a
  nudge in the same session; uncertain writes require reconciliation.
- SSE disconnects get one reconnect timer per connection. Server setup and reads
  use bounded backoff; control requests have deadlines and cancellation signals.

## Interface and cancellation

Chat and Game Studio show **Reconnecting**, attempt number and retry countdown
when available. Recovery keeps the turn active. Stop, project changes and shutdown
cancel pending requests and waits. Exhausted recovery preserves the conversation
or workflow and offers Continue or Resume saved work when safe.

Compile checks cover Electron/main and renderer TypeScript, the self-contained
Windows orchestrator and the application build. Live provider outage acceptance
was not performed for this change; no paid model requests were issued.
