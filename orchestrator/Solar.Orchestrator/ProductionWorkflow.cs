using Microsoft.Agents.AI.Workflows;
using System.Text.Json;
using System.Diagnostics;

namespace Solar.Orchestrator;

internal static class ProductionWorkflow
{
    public const string Version = "solar-production-1";
    public static Workflow Build(RpcPeer peer, CancellationToken stop)
    {
        var router = new ProductionExecutor(peer, stop);
        RequestPort approval = RequestPort.Create<WorkflowFrame, ApprovalDecision>("critical-approval");
        var response = new ApprovalExecutor();
        return new WorkflowBuilder(router).AddEdge(router, router).AddEdge(router, approval)
            .AddEdge(approval, response).AddEdge(response, router).WithOutputFrom(router).Build();
    }
}

[SendsMessage(typeof(WorkflowFrame))]
[YieldsOutput(typeof(StageReply))]
internal sealed class ProductionExecutor(RpcPeer peer, CancellationToken stop) : Executor<WorkflowFrame>("production-master")
{
    private static readonly string[] Phases = ["planning", "prepare", "developing", "applying", "validating", "runtime", "tests", "quality_review"];
    public override async ValueTask HandleAsync(WorkflowFrame frame, IWorkflowContext context, CancellationToken ct = default)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(ct, stop);
        ct = lifetime.Token;
        ct.ThrowIfCancellationRequested();
        var artifacts = new Dictionary<string, JsonElement>(frame.Artifacts ?? []);
        string revision = frame.ProjectRevision ?? frame.Request.ProjectRevision;
        var request = new StageRequest(frame.Request.RunId, frame.Phase, frame.Repair, revision, frame.Request.Task, artifacts, frame.Approved);
        StageReply reply = null!;
        const int maxAttempts = 12;
        var recoveryClock = new Stopwatch();
        for (int attempt = 0; attempt < maxAttempts; attempt++)
        {
            await peer.NotifyAsync("workflow.stage", new { runId = request.RunId, phase = request.Phase, repair = request.Repair, attempt, maxAttempts });
            if (frame.Phase == "prepare")
            {
                // Only independent reads run together. The framework owns this fan-out.
                var results = await Task.WhenAll(
                    peer.CallAsync<StageReply>("executor.invoke", request with { Phase = "skills" }, ct),
                    peer.CallAsync<StageReply>("executor.invoke", request with { Phase = "tea_strategy" }, ct));
                reply = results.FirstOrDefault(x => x.Status != "ok") ?? new StageReply("ok", JsonSerializer.SerializeToElement(new { skills = results[0].Data, strategy = results[1].Data }, RpcPeer.Json));
            }
            else reply = await peer.CallAsync<StageReply>("executor.invoke", request, ct);
            if (reply.Status != "transient") break;
            recoveryClock.Start();
            int delayMs = Math.Min(30_000, 2000 << Math.Min(attempt, 4));
            if (attempt + 1 >= maxAttempts || recoveryClock.ElapsedMilliseconds + delayMs >= 300_000) break;
            await peer.NotifyAsync("workflow.reconnecting", new { runId = request.RunId, phase = request.Phase, repair = request.Repair, attempt = attempt + 2, maxAttempts, delayMs });
            await Task.Delay(delayMs, ct);
        }
        if (reply.Status == "transient") reply = reply with { Error = "Connection recovery is still unavailable. Your workflow is saved; resume it when the provider or server is available." };
        if (reply.Status == "approval_required")
        {
            // A durable RequestPort, rather than an Electron-owned retry/router.
            await context.QueueStateUpdateAsync("approval-frame", frame, scopeName: "solar", cancellationToken: ct);
            // Typed port routing: direct sends target a specific executor.
            await context.SendMessageAsync(frame, targetId: "critical-approval", cancellationToken: ct);
            return;
        }
        if (reply.Status != "ok") { await context.YieldOutputAsync(reply, ct); return; }
        if (frame.Phase == "planning" && reply.Data.TryGetProperty("scope", out var scope) && scope.GetString() == "question")
        {
            await context.YieldOutputAsync(reply with { Status = "response_completed" }, ct);
            return;
        }
        artifacts[frame.Phase] = reply.Data;
        revision = reply.ProjectRevision ?? revision;
        if (frame.Phase == "quality_review")
        {
            string gate = reply.Data.TryGetProperty("status", out var status) ? status.GetString() ?? "BLOCKED" : "BLOCKED";
            if (gate == "FAIL" && frame.Repair < 2)
            {
                foreach (string stale in new[] { "developing", "applying", "validating", "runtime", "tests" }) artifacts.Remove(stale);
                await context.SendMessageAsync(frame with { Phase = "developing", Repair = frame.Repair + 1, ProjectRevision = revision, Artifacts = artifacts, Approved = false }, targetId: "production-master", cancellationToken: ct);
            }
            else await context.YieldOutputAsync(reply with { Status = gate == "PASS" ? "complete" : gate.ToLowerInvariant() }, ct);
            return;
        }
        int next = Array.IndexOf(Phases, frame.Phase) + 1;
        if (next < 1 || next >= Phases.Length) throw new InvalidDataException("Unknown workflow phase.");
        await context.SendMessageAsync(frame with { Phase = Phases[next], ProjectRevision = revision, Artifacts = artifacts, Approved = false }, targetId: "production-master", cancellationToken: ct);
    }
}

[SendsMessage(typeof(WorkflowFrame))]
internal sealed class ApprovalExecutor() : Executor<ApprovalDecision>("approval-response")
{
    public override async ValueTask HandleAsync(ApprovalDecision decision, IWorkflowContext context, CancellationToken ct = default)
    {
        WorkflowFrame frame = await context.ReadStateAsync<WorkflowFrame>("approval-frame", scopeName: "solar", cancellationToken: ct) ?? throw new InvalidDataException("Approval checkpoint is missing.");
        if (!decision.Approved || decision.RunId != frame.Request.RunId || decision.ProjectRevision != (frame.ProjectRevision ?? frame.Request.ProjectRevision)) throw new InvalidOperationException("Approval was denied or belongs to another revision.");
        await context.SendMessageAsync(frame with { Approved = true }, cancellationToken: ct);
    }
}
