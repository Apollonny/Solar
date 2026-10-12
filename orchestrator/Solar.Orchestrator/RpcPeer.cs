using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;

namespace Solar.Orchestrator;

/// <summary>Private, bounded, bidirectional JSON-RPC. Stdout contains protocol only.</summary>
internal sealed class RpcPeer
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonElement>> _pending = new();
    private readonly SemaphoreSlim _output = new(1, 1);
    private readonly ConcurrentDictionary<int, Task> _requests = new();
    private long _nextId;
    private int _nextRequest;
    public Func<string, JsonElement, Task<object?>>? Handler { get; set; }

    public async Task SendAsync(object value)
    {
        string data = JsonSerializer.Serialize(value, Json);
        if (Encoding.UTF8.GetByteCount(data) > 8 * 1024 * 1024) throw new InvalidDataException("RPC output limit exceeded.");
        await _output.WaitAsync();
        try { await Console.Out.WriteLineAsync(data); await Console.Out.FlushAsync(); }
        finally { _output.Release(); }
    }
    public Task NotifyAsync(string method, object value) => SendAsync(new { jsonrpc = "2.0", method, @params = value });

    public async Task<T> CallAsync<T>(string method, object value, CancellationToken ct)
    {
        string id = "host-" + Interlocked.Increment(ref _nextId);
        var completion = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!_pending.TryAdd(id, completion)) throw new InvalidOperationException("Duplicate RPC id.");
        using var registration = ct.Register(() => completion.TrySetCanceled(ct));
        try
        {
            await SendAsync(new { jsonrpc = "2.0", id, method, @params = value });
            return (await completion.Task).Deserialize<T>(Json) ?? throw new InvalidDataException("Empty executor response.");
        }
        finally { _pending.TryRemove(id, out _); }
    }
    private async Task DispatchAsync(string line)
    {
        using var doc = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 48 });
        JsonElement root = doc.RootElement;
        if (!root.TryGetProperty("jsonrpc", out var protocol) || protocol.GetString() != "2.0") throw new InvalidDataException("Invalid RPC version.");
        string? id = root.TryGetProperty("id", out var requestId) ? requestId.GetString() : null;
        if (!root.TryGetProperty("method", out var method))
        {
            if (id != null && _pending.TryGetValue(id, out var pending))
            {
                if (root.TryGetProperty("error", out var error)) pending.TrySetException(new InvalidOperationException(error.GetProperty("message").GetString()));
                else pending.TrySetResult(root.GetProperty("result").Clone());
            }
            return;
        }
        JsonElement args = root.TryGetProperty("params", out var p) ? p.Clone() : default;
        string methodName = method.GetString()!;
        int requestKey = Interlocked.Increment(ref _nextRequest);
        // A callback response must remain readable while a start/approval request runs.
        Task task = Task.Run(async () =>
        {
            try
            {
                object? result = await (Handler?.Invoke(methodName, args) ?? Task.FromResult<object?>(null));
                if (id != null) await SendAsync(new { jsonrpc = "2.0", id, result });
            }
            catch (Exception ex) { if (id != null) await SendAsync(new { jsonrpc = "2.0", id, error = new { code = -32000, message = ex.Message } }); }
        });
        _requests[requestKey] = task;
        _ = task.ContinueWith(_ => _requests.TryRemove(requestKey, out var ignored));
    }
    public async Task ReadAsync()
    {
        char[] buffer = new char[4096];
        var line = new StringBuilder();
        try
        {
            while (true)
            {
                int read = await Console.In.ReadAsync(buffer);
                if (read == 0) break;
                for (int i = 0; i < read; i++)
                {
                    if (buffer[i] == '\n')
                    {
                        if (line.Length > 0) await DispatchAsync(line.ToString().TrimEnd('\r'));
                        line.Clear();
                    }
                    else
                    {
                        line.Append(buffer[i]);
                        if (line.Length > 2 * 1024 * 1024) throw new InvalidDataException("RPC input limit exceeded.");
                    }
                }
            }
        }
        finally { foreach (var pending in _pending.Values) pending.TrySetException(new EndOfStreamException("Solar disconnected.")); }
    }
}
