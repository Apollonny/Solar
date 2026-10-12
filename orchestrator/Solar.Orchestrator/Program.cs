using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Agents.AI.Workflows;
using Microsoft.Agents.AI.Workflows.Checkpointing;

namespace Solar.Orchestrator;

internal sealed class LiveRun(StartRequest request, RpcPeer peer) : IAsyncDisposable
{
    private readonly CancellationTokenSource _stop = new();
    private readonly SemaphoreSlim _watch = new(1, 1);
    private readonly FileSystemJsonCheckpointStore _store = new(new DirectoryInfo(request.CheckpointDirectory));
    private StreamingRun? _run;
    private ExternalRequest? _approval;
    private long _seq = request.EventSeq;
    private bool _ended;
    public async Task StartAsync()
    {
        var manager = CheckpointManager.CreateJson(_store, RpcPeer.Json);
        Workflow workflow = ProductionWorkflow.Build(peer, _stop.Token);
        _run = request.Checkpoint is {} checkpoint
            ? await InProcessExecution.ResumeStreamingAsync(workflow, new CheckpointInfo(checkpoint.SessionId, checkpoint.CheckpointId), manager, cancellationToken: _stop.Token)
            : await InProcessExecution.RunStreamingAsync(workflow, new WorkflowFrame(request), manager, cancellationToken: _stop.Token);
        _ = ObserveAsync();
    }
    private Task EventAsync(string kind, object data) => peer.NotifyAsync("workflow.event", new { runId = request.RunId, eventSeq = Interlocked.Increment(ref _seq), kind, data });
    private async Task ObserveAsync()
    {
        await _watch.WaitAsync();
        try
        {
            if (_run == null || _ended) return;
            await foreach (WorkflowEvent evt in _run.WatchStreamAsync(_stop.Token))
            {
                switch (evt)
                {
                    case RequestInfoEvent approval:
                        _approval = approval.Request;
                        if (!_approval.TryGetDataAs<WorkflowFrame>(out var frame)) throw new InvalidDataException("Invalid approval port data.");
                        await EventAsync("approval_required", new { projectRevision = frame.ProjectRevision ?? request.ProjectRevision, phase = frame.Phase });
                        break;
                    case SuperStepCompletedEvent step when step.CompletionInfo?.Checkpoint != null:
                        await EventAsync("checkpoint", step.CompletionInfo.Checkpoint);
                        break;
                    case WorkflowOutputEvent output:
                        _ended = true;
                        await EventAsync("finished", output.Data!);
                        break;
                    case WorkflowErrorEvent error:
                        _ended = true;
                        // Exception internals may contain model/tool payloads. Keep protocol errors bounded.
                        await EventAsync("finished", new StageReply(_stop.IsCancellationRequested ? "cancelled" : "blocked", JsonSerializer.SerializeToElement(new { code = "WORKFLOW_ERROR" }), Error: error.Exception?.Message[..Math.Min(error.Exception.Message.Length, 500)]));
                        break;
                }
            }
            if (_stop.IsCancellationRequested && !_ended) { _ended = true; await EventAsync("finished", new { status = "cancelled" }); }
        }
        catch (OperationCanceledException) { if (!_ended) { _ended = true; await EventAsync("finished", new { status = "cancelled" }); } }
        catch (Exception ex) { if (!_ended) { _ended = true; await EventAsync("finished", new { status = "blocked", error = ex.Message }); } }
        finally { _watch.Release(); }
    }
    public async Task ApproveAsync(ApprovalDecision decision)
    {
        if (_ended || _run == null || _approval == null) throw new InvalidOperationException("No approval is pending.");
        if (!_approval.TryGetDataAs<WorkflowFrame>(out var frame) || decision.RunId != request.RunId || decision.ProjectRevision != (frame.ProjectRevision ?? request.ProjectRevision)) throw new InvalidOperationException("Approval revision is stale.");
        if (!decision.Approved) { _stop.Cancel(); return; }
        ExternalRequest approval = _approval;
        _approval = null;
        await _run.SendResponseAsync(approval.CreateResponse(decision));
        _ = ObserveAsync();
    }
    public void Cancel() => _stop.Cancel();
    public async ValueTask DisposeAsync()
    {
        _stop.Cancel();
        await _watch.WaitAsync();
        try { if (_run != null) await _run.DisposeAsync(); _store.Dispose(); }
        finally { _watch.Release(); _stop.Dispose(); }
    }
}

internal static class Program
{
    public static async Task Main()
    {
        var peer = new RpcPeer();
        var runs = new ConcurrentDictionary<string, LiveRun>();
        peer.Handler = async (method, value) =>
        {
            switch (method)
            {
                case "initialize": return new { schemaVersion = 1, workflowVersion = ProductionWorkflow.Version, framework = "Microsoft.Agents.AI.Workflows/1.22.0" };
                case "workflow.start":
                case "workflow.resume":
                    var request = value.Deserialize<StartRequest>(RpcPeer.Json) ?? throw new InvalidDataException("Missing workflow request.");
                    if (!Guid.TryParseExact(request.RunId, "D", out _) || !Path.IsPathFullyQualified(request.CheckpointDirectory) || request.ProjectRevision.Length != 64) throw new InvalidDataException("Invalid workflow identity.");
                    var run = new LiveRun(request, peer);
                    if (!runs.TryAdd(request.RunId, run)) throw new InvalidOperationException("Run is already active.");
                    try { await run.StartAsync(); }
                    catch { runs.TryRemove(request.RunId, out _); await run.DisposeAsync(); throw; }
                    return new { runId = request.RunId };
                case "workflow.cancel":
                    if (runs.TryGetValue(value.GetProperty("runId").GetString()!, out var cancel)) cancel.Cancel();
                    return new { cancelled = true };
                case "workflow.approve":
                    var decision = value.Deserialize<ApprovalDecision>(RpcPeer.Json) ?? throw new InvalidDataException("Missing approval.");
                    if (!runs.TryGetValue(decision.RunId, out var target)) throw new InvalidOperationException("Run is not active. Resume its checkpoint first.");
                    await target.ApproveAsync(decision);
                    return new { submitted = true };
                default: throw new InvalidOperationException("Unknown orchestrator method.");
            }
        };
        try { await peer.ReadAsync(); }
        finally { foreach (var run in runs.Values) await run.DisposeAsync(); }
    }
}
