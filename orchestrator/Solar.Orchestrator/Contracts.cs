using System.Text.Json;

namespace Solar.Orchestrator;

public sealed record StartRequest(string RunId, string ProjectRevision, string CheckpointDirectory,
    JsonElement Task, long EventSeq = 0, CheckpointReference? Checkpoint = null);
public sealed record CheckpointReference(string SessionId, string CheckpointId);
public sealed record WorkflowFrame(StartRequest Request, string Phase = "planning", int Repair = 0,
    string? ProjectRevision = null, Dictionary<string, JsonElement>? Artifacts = null, bool Approved = false);
public sealed record StageRequest(string RunId, string Phase, int Repair, string ProjectRevision,
    JsonElement Task, Dictionary<string, JsonElement> Artifacts, bool Approved);
public sealed record StageReply(string Status, JsonElement Data, string? ProjectRevision = null,
    string? Error = null);
public sealed record ApprovalDecision(bool Approved, string RunId, string ProjectRevision);
