using System.Buffers;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Win32.SafeHandles;

namespace BoxSpec.SafeFs;

internal static class Program
{
    private const int MaxRequestBytes = 24 * 1024 * 1024;

    public static int Main(string[] args)
    {
        if (args is not ["--protocol", "1"])
        {
            Console.Error.WriteLine("usage: boxspec-safe-fs --protocol 1");
            return 2;
        }
        try
        {
            using var input = new MemoryStream();
            var buffer = new byte[64 * 1024];
            int read;
            while ((read = Console.OpenStandardInput().Read(buffer)) != 0)
            {
                if (input.Length + read > MaxRequestBytes) throw new ProtocolException("REQUEST_TOO_LARGE", "request exceeds 24 MiB");
                input.Write(buffer, 0, read);
            }
            using var document = JsonDocument.Parse(input.ToArray(), new JsonDocumentOptions { MaxDepth = 32 });
            var root = document.RootElement;
            var requestId = Json.RequiredString(root, "requestId", 128);
            Policy.Token(requestId, "requestId");
            try
            {
                var result = Operations.Dispatch(root);
                JsonSerializer.Serialize(Console.OpenStandardOutput(), new { ok = true, requestId, result }, Json.Options);
            }
            catch (ProtocolException error)
            {
                JsonSerializer.Serialize(Console.OpenStandardOutput(), new { ok = false, requestId, error = new { code = error.Code, message = error.Message, retryable = error.Retryable } }, Json.Options);
            }
            return 0;
        }
        catch (Exception error) when (error is JsonException or ProtocolException or IOException)
        {
            Console.Error.WriteLine(error.Message);
            return 2;
        }
    }
}

internal static class Operations
{
    internal const int MaxAfterBytes = 16 * 1024 * 1024;
    internal const long MaxFileBytes = 256L * 1024 * 1024;

    public static object Dispatch(JsonElement request)
    {
        var op = Json.RequiredString(request, "op", 40);
        Json.RequireOnly(request, op switch
        {
            "inspect_root" => ["op", "requestId", "root"],
            "resolve_relative" => ["op", "requestId", "root", "rootIdentity", "relativePath", "allowMissing"],
            "ensure_directory" => ["op", "requestId", "root", "rootIdentity", "relativePath"],
            "prepare_replace" => ["op", "requestId", "transactionId", "root", "rootIdentity", "relativePath", "expectedBeforeHash", "expectedBeforeFileId", "afterBytesBase64"],
            "commit_replace" => ["op", "requestId", "transactionId", "root", "rootIdentity", "relativePath", "preparedId"],
            "classify_recovery" => ["op", "requestId", "transactionId", "root", "rootIdentity", "relativePath", "beforeHash", "afterHash", "preparedId"],
            "recover_replace" => ["op", "requestId", "transactionId", "root", "rootIdentity", "relativePath", "preparedId", "decision"],
            "finalize_replace" => ["op", "requestId", "transactionId", "root", "rootIdentity", "relativePath", "preparedId"],
            _ => ["op", "requestId"]
        });
        return op switch
        {
            "inspect_root" => InspectRoot(Json.RequiredString(request, "root", 32767)),
            "resolve_relative" => Resolve(request),
            "ensure_directory" => EnsureDirectory(request),
            "prepare_replace" => Prepare(request),
            "commit_replace" => Commit(request),
            "classify_recovery" => Classify(request),
            "recover_replace" => Recover(request),
            "finalize_replace" => FinalizeReplace(request),
            _ => throw new ProtocolException("UNKNOWN_OPERATION", "unsupported operation")
        };
    }

    private static object InspectRoot(string root)
    {
        if (!Path.IsPathFullyQualified(root)) throw new ProtocolException("INVALID_ROOT", "project root must be absolute");
        using var entry = Native.Open(root, readData: false, shareDelete: true);
        entry.RequireDirectory("project root");
        entry.RequireNotReparse("project root");
        return new { rootIdentity = entry.RootIdentity, reparseTag = entry.TagText };
    }

    private static object Resolve(JsonElement request)
    {
        var root = Json.RequiredString(request, "root", 32767);
        var binding = Json.RootIdentity(request);
        var relative = Json.RequiredString(request, "relativePath", 512);
        var allowMissing = Json.RequiredBoolean(request, "allowMissing");
        var parts = Policy.Relative(relative);
        using var walk = Native.Walk(root, binding, parts, allowMissing);
        var parent = walk.MissingIndex is null ? walk.Parent(parts.Length) : walk.ClosestExisting;
        var target = walk.Target;
        return new
        {
            exists = target is not null,
            finalPath = walk.TargetPath,
            parentIdentity = parent.Identity,
            target = target is null ? null : new { identity = target.Identity, kind = target.Kind, linkCount = target.LinkCount, reparseTag = target.TagText, size = target.Size }
        };
    }

    private static object EnsureDirectory(JsonElement request)
    {
        var root = Json.RequiredString(request, "root", 32767);
        var binding = Json.RootIdentity(request);
        var relative = Json.RequiredString(request, "relativePath", 512);
        var parts = Policy.Relative(relative);
        var result = Native.EnsureDirectory(root, binding, parts);
        return new { finalPath = result.FinalPath, identity = result.Identity, created = result.Created };
    }

    private static object Prepare(JsonElement request)
    {
        var transaction = Json.RequiredString(request, "transactionId", 128);
        Policy.Token(transaction, "transactionId");
        var root = Json.RequiredString(request, "root", 32767);
        var binding = Json.RootIdentity(request);
        var relative = Json.RequiredString(request, "relativePath", 512);
        var parts = Policy.Relative(relative);
        var beforeHash = Json.OptionalString(request, "expectedBeforeHash", 64);
        var beforeFileId = Json.OptionalString(request, "expectedBeforeFileId", 32);
        Policy.Hash(beforeHash);
        if (beforeHash is null && beforeFileId is not null) throw new ProtocolException("INVALID_REQUEST", "expectedBeforeFileId requires expectedBeforeHash");
        byte[]? after = null;
        if (request.TryGetProperty("afterBytesBase64", out var afterValue) && afterValue.ValueKind != JsonValueKind.Null)
        {
            var encoded = afterValue.GetString() ?? throw new ProtocolException("INVALID_REQUEST", "afterBytesBase64 must be a string or null");
            if (encoded.Length > ((MaxAfterBytes + 2) / 3) * 4) throw new ProtocolException("PAYLOAD_TOO_LARGE", "replacement exceeds 16 MiB");
            try { after = Convert.FromBase64String(encoded); }
            catch (FormatException) { throw new ProtocolException("INVALID_REQUEST", "afterBytesBase64 is invalid"); }
            if (after.Length > MaxAfterBytes) throw new ProtocolException("PAYLOAD_TOO_LARGE", "replacement exceeds 16 MiB");
        }
        if (beforeHash is null && after is null) throw new ProtocolException("INVALID_REQUEST", "absent-to-absent replacement has no effect");

        using var walk = Native.Walk(root, binding, parts, allowMissing: true);
        if (walk.MissingIndex is int missing && missing + 1 != parts.Length) throw new ProtocolException("PARENT_MISSING", "target parent does not exist");
        var parent = walk.Parent(parts.Length);
        parent.RequireDirectory("target parent");
        string? actualBefore = null;
        EntryIdentity? beforeIdentity = null;
        if (beforeHash is null && walk.Target is not null) throw new ProtocolException("SOURCE_DRIFT", "target exists but absence was expected");
        if (beforeHash is not null && walk.Target is null) throw new ProtocolException("SOURCE_DRIFT", "target is absent");
        if (walk.Target is not null)
        {
            walk.Target.RequireWritableRegular("target");
            if (beforeFileId is not null && !StringComparer.Ordinal.Equals(beforeFileId, walk.Target.Identity.FileId)) throw new ProtocolException("SOURCE_DRIFT", "target file identity changed");
            actualBefore = Native.Hash(walk.Target.Handle, walk.Target.Size);
            if (!StringComparer.Ordinal.Equals(actualBefore, beforeHash)) throw new ProtocolException("SOURCE_DRIFT", "target content hash changed");
            beforeIdentity = walk.Target.Identity;
        }

        var parentPath = Path.GetDirectoryName(walk.TargetPath) ?? throw new ProtocolException("INVALID_PATH", "target has no parent");
        Artifact? backup = null;
        Artifact? temp = null;
        try
        {
            if (walk.Target is not null)
            {
                backup = Native.CreateArtifact(parent, parentPath, transaction, "bak");
                Native.Copy(walk.Target.Handle, backup.Entry.Handle, walk.Target.Size);
                Native.Flush(backup.Entry.Handle, "backup");
                backup.Entry.Refresh();
                var backupHash = Native.Hash(backup.Entry.Handle, backup.Entry.Size);
                if (!StringComparer.Ordinal.Equals(backupHash, actualBefore)) throw new ProtocolException("SOURCE_DRIFT", "backup does not match checked source");
            }
            if (after is not null)
            {
                temp = Native.CreateArtifact(parent, parentPath, transaction, "tmp");
                RandomAccess.Write(temp.Entry.Handle, after, 0);
                Native.Flush(temp.Entry.Handle, "temporary replacement");
                temp.Entry.Refresh();
            }
            Native.RecheckRoot(root, binding);
            var prepared = new Prepared(
                1, transaction, binding, relative, parent.Identity, actualBefore, beforeIdentity,
                after is null ? null : Native.Sha256(after), temp?.Leaf, temp?.Entry.Identity,
                backup?.Leaf, backup?.Entry.Identity);
            return new
            {
                preparedId = prepared.Encode(),
                disposition = beforeHash is null ? "create" : after is null ? "delete" : "replace",
                beforeHash = prepared.BeforeHash,
                afterHash = prepared.AfterHash,
                backupHash = actualBefore,
                parentIdentity = prepared.ParentIdentity
            };
        }
        catch
        {
            temp?.DeleteBestEffort();
            backup?.DeleteBestEffort();
            throw;
        }
        finally
        {
            temp?.Dispose();
            backup?.Dispose();
        }
    }

    private static object Commit(JsonElement request)
    {
        var transaction = Json.RequiredString(request, "transactionId", 128);
        Policy.Token(transaction, "transactionId");
        var root = Json.RequiredString(request, "root", 32767);
        var binding = Json.RootIdentity(request);
        var relative = Json.RequiredString(request, "relativePath", 512);
        var prepared = Prepared.DecodeAndBind(Json.RequiredString(request, "preparedId", 32768), transaction, binding, relative);
        var parts = Policy.Relative(relative);
        using var walk = Native.Walk(root, binding, parts, allowMissing: true, pinFinalForDelete: true);
        if (walk.MissingIndex is int missing && missing + 1 != parts.Length) throw new ProtocolException("SOURCE_DRIFT", "target parent disappeared");
        var parent = walk.Parent(parts.Length);
        if (parent.Identity != prepared.ParentIdentity) throw new ProtocolException("SOURCE_DRIFT", "target parent identity changed");
        parent.RequireDirectory("target parent");
        Native.VerifyBefore(walk.Target, prepared);
        var parentPath = Path.GetDirectoryName(walk.TargetPath) ?? throw new ProtocolException("INVALID_PATH", "target has no parent");
        using var backup = prepared.BackupLeaf is null ? null : Native.VerifyArtifact(parent, prepared.BackupLeaf, prepared.BackupIdentity!, prepared.BeforeHash!);
        using var temp = prepared.TempLeaf is null ? null : Native.VerifyArtifact(parent, prepared.TempLeaf, prepared.TempIdentity!, prepared.AfterHash!);
        Native.RecheckRoot(root, binding);

        if (prepared.BeforeHash is not null)
        {
            var pinned = walk.Target ?? throw new ProtocolException("SOURCE_DRIFT", "target disappeared");
            Native.VerifyBefore(pinned, prepared);
            Native.MarkDelete(pinned.Handle);
            walk.DisposeTarget();
        }
        if (temp is not null)
        {
            Native.RenameRelative(temp.Handle, parent.Handle, parts[^1], replace: false);
            temp.Dispose();
        }
        Native.RecheckRoot(root, binding);
        using var verified = Native.Walk(root, binding, parts, allowMissing: true);
        EntryIdentity? afterIdentity = null;
        if (prepared.AfterHash is null && verified.Target is not null) throw new ProtocolException("AFTER_MISMATCH", "target still exists after delete");
        if (prepared.AfterHash is not null)
        {
            if (verified.Target is null) throw new ProtocolException("AFTER_MISMATCH", "target is absent after replace");
            verified.Target.RequireWritableRegular("committed target");
            if (!StringComparer.Ordinal.Equals(Native.Hash(verified.Target.Handle, verified.Target.Size), prepared.AfterHash)) throw new ProtocolException("AFTER_MISMATCH", "committed target hash does not match prepared bytes");
            afterIdentity = verified.Target.Identity;
        }
        return new { afterHash = prepared.AfterHash, targetIdentity = afterIdentity };
    }

    private static object Classify(JsonElement request)
    {
        var transaction = Json.RequiredString(request, "transactionId", 128);
        Policy.Token(transaction, "transactionId");
        var root = Json.RequiredString(request, "root", 32767);
        var binding = Json.RootIdentity(request);
        var relative = Json.RequiredString(request, "relativePath", 512);
        var before = Json.OptionalString(request, "beforeHash", 64);
        var after = Json.OptionalString(request, "afterHash", 64);
        Policy.Hash(before); Policy.Hash(after);
        Prepared? prepared = null;
        var preparedText = Json.OptionalString(request, "preparedId", 32768);
        if (preparedText is not null) prepared = Prepared.DecodeAndBind(preparedText, transaction, binding, relative);
        string state;
        string? reason = null;
        var canRestore = false;
        var canFinish = false;
        try
        {
            var parts = Policy.Relative(relative);
            using var walk = Native.Walk(root, binding, parts, allowMissing: true);
            string? current = null;
            if (walk.Target is not null)
            {
                walk.Target.RequireWritableRegular("recovery target");
                current = Native.Hash(walk.Target.Handle, walk.Target.Size);
            }
            state = StringComparer.Ordinal.Equals(current, before) ? "BEFORE" : StringComparer.Ordinal.Equals(current, after) ? "AFTER" : "UNKNOWN";
            if (prepared is not null && !(walk.MissingIndex is int missing && missing + 1 != parts.Length))
            {
                var parent = walk.Parent(parts.Length);
                canRestore = Native.ArtifactMatches(parent, prepared.BackupLeaf, prepared.BackupIdentity, prepared.BeforeHash);
                canFinish = prepared.AfterHash is null ? state == "BEFORE" : Native.ArtifactMatches(parent, prepared.TempLeaf, prepared.TempIdentity, prepared.AfterHash);
            }
        }
        catch (ProtocolException error) { state = "UNKNOWN"; reason = error.Message; }
        return new { state, reason, canRestoreBefore = canRestore, canFinishAfter = canFinish };
    }

    private static object Recover(JsonElement request)
    {
        var transaction = Json.RequiredString(request, "transactionId", 128);
        Policy.Token(transaction, "transactionId");
        var root = Json.RequiredString(request, "root", 32767);
        var binding = Json.RootIdentity(request);
        var relative = Json.RequiredString(request, "relativePath", 512);
        var decision = Json.RequiredString(request, "decision", 32);
        if (decision is not ("restore_before" or "finish_after")) throw new ProtocolException("INVALID_REQUEST", "decision must be restore_before or finish_after");
        var prepared = Prepared.DecodeAndBind(Json.RequiredString(request, "preparedId", 32768), transaction, binding, relative);
        var parts = Policy.Relative(relative);
        using var walk = Native.Walk(root, binding, parts, allowMissing: true, pinFinalForDelete: true);
        if (walk.MissingIndex is int missing && missing + 1 != parts.Length) throw new ProtocolException("UNKNOWN_STATE", "target parent is unavailable");
        var parent = walk.Parent(parts.Length);
        if (parent.Identity != prepared.ParentIdentity) throw new ProtocolException("UNKNOWN_STATE", "target parent identity changed");
        var currentHash = Native.CurrentHash(walk.Target);
        var state = StringComparer.Ordinal.Equals(currentHash, prepared.BeforeHash) ? "BEFORE" : StringComparer.Ordinal.Equals(currentHash, prepared.AfterHash) ? "AFTER" : "UNKNOWN";
        if (state == "UNKNOWN") throw new ProtocolException("UNKNOWN_STATE", "target matches neither journaled state");
        var wanted = decision == "restore_before" ? "BEFORE" : "AFTER";
        if (state == wanted)
        {
            Native.TryDeleteArtifact(parent, prepared.TempLeaf, prepared.TempIdentity, prepared.AfterHash);
            Native.TryDeleteArtifact(parent, prepared.BackupLeaf, prepared.BackupIdentity, prepared.BeforeHash);
            Native.RecheckRoot(root, binding);
            return new { state, targetHash = currentHash, targetIdentity = walk.Target?.Identity, changed = false };
        }

        var artifactLeaf = decision == "restore_before" ? prepared.BackupLeaf : prepared.TempLeaf;
        var artifactIdentity = decision == "restore_before" ? prepared.BackupIdentity : prepared.TempIdentity;
        var artifactHash = decision == "restore_before" ? prepared.BeforeHash : prepared.AfterHash;
        using var artifact = artifactHash is null ? null : Native.VerifyArtifact(parent,
            artifactLeaf ?? throw new ProtocolException("UNKNOWN_STATE", "required recovery artifact is absent"),
            artifactIdentity ?? throw new ProtocolException("UNKNOWN_STATE", "required recovery identity is absent"), artifactHash);
        Native.RecheckRoot(root, binding);
        if (walk.Target is not null)
        {
            Native.MarkDelete(walk.Target.Handle);
            walk.DisposeTarget();
        }
        if (artifact is not null)
        {
            Native.RenameRelative(artifact.Handle, parent.Handle, parts[^1], replace: false);
            artifact.Dispose();
        }
        Native.RecheckRoot(root, binding);
        using var verified = Native.Walk(root, binding, parts, allowMissing: true);
        var finalHash = Native.CurrentHash(verified.Target);
        if (!StringComparer.Ordinal.Equals(finalHash, artifactHash)) throw new ProtocolException("AFTER_MISMATCH", "recovery result does not match journaled state");
        // Once a recovery decision has reached its exact journaled state, both
        // transaction artifacts are disposable. Missing artifacts are expected
        // when one was consumed by the relative rename.
        Native.TryDeleteArtifact(parent, prepared.TempLeaf, prepared.TempIdentity, prepared.AfterHash);
        Native.TryDeleteArtifact(parent, prepared.BackupLeaf, prepared.BackupIdentity, prepared.BeforeHash);
        return new { state = wanted, targetHash = finalHash, targetIdentity = verified.Target?.Identity, changed = true };
    }

    private static object FinalizeReplace(JsonElement request)
    {
        var transaction = Json.RequiredString(request, "transactionId", 128);
        Policy.Token(transaction, "transactionId");
        var root = Json.RequiredString(request, "root", 32767);
        var binding = Json.RootIdentity(request);
        var relative = Json.RequiredString(request, "relativePath", 512);
        var prepared = Prepared.DecodeAndBind(Json.RequiredString(request, "preparedId", 32768), transaction, binding, relative);
        var parts = Policy.Relative(relative);
        using var walk = Native.Walk(root, binding, parts, allowMissing: true);
        if (walk.MissingIndex is int missing && missing + 1 != parts.Length) throw new ProtocolException("UNKNOWN_STATE", "target parent is unavailable");
        var parent = walk.Parent(parts.Length);
        if (parent.Identity != prepared.ParentIdentity) throw new ProtocolException("UNKNOWN_STATE", "target parent identity changed");
        var current = Native.CurrentHash(walk.Target);
        if (!StringComparer.Ordinal.Equals(current, prepared.AfterHash)) throw new ProtocolException("UNKNOWN_STATE", "finalize requires the exact AFTER state");
        var removedTemp = Native.TryDeleteArtifact(parent, prepared.TempLeaf, prepared.TempIdentity, prepared.AfterHash);
        var removedBackup = Native.TryDeleteArtifact(parent, prepared.BackupLeaf, prepared.BackupIdentity, prepared.BeforeHash);
        Native.RecheckRoot(root, binding);
        return new { finalized = true, removedTemp, removedBackup };
    }
}

internal sealed record RootIdentity(string CanonicalPath, string VolumeId, string FileId);
internal sealed record EntryIdentity(string VolumeId, string FileId);

internal sealed record Prepared(
    int Version, string TransactionId, RootIdentity RootIdentity, string RelativePath,
    EntryIdentity ParentIdentity, string? BeforeHash, EntryIdentity? BeforeIdentity,
    string? AfterHash, string? TempLeaf, EntryIdentity? TempIdentity,
    string? BackupLeaf, EntryIdentity? BackupIdentity)
{
    public string Encode() => Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(this, Json.Options)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public static Prepared DecodeAndBind(string encoded, string transaction, RootIdentity root, string relative)
    {
        if (encoded.Length > 32768) throw new ProtocolException("INVALID_PREPARED", "preparedId is too large");
        try
        {
            var value = encoded.Replace('-', '+').Replace('_', '/');
            value += new string('=', (4 - value.Length % 4) % 4);
            var prepared = JsonSerializer.Deserialize<Prepared>(Convert.FromBase64String(value), Json.Options) ?? throw new ProtocolException("INVALID_PREPARED", "preparedId is invalid");
            if (prepared.Version != 1 || prepared.TransactionId != transaction || prepared.RootIdentity != root || prepared.RelativePath != relative) throw new ProtocolException("INVALID_PREPARED", "preparedId binding does not match request");
            Policy.Hash(prepared.BeforeHash); Policy.Hash(prepared.AfterHash);
            Policy.ArtifactLeaf(prepared.TempLeaf); Policy.ArtifactLeaf(prepared.BackupLeaf);
            if ((prepared.TempLeaf is null) != (prepared.TempIdentity is null) || (prepared.TempLeaf is null) != (prepared.AfterHash is null)) throw new ProtocolException("INVALID_PREPARED", "temporary binding is incomplete");
            if ((prepared.BackupLeaf is null) != (prepared.BackupIdentity is null) || (prepared.BackupLeaf is null) != (prepared.BeforeHash is null)) throw new ProtocolException("INVALID_PREPARED", "backup binding is incomplete");
            return prepared;
        }
        catch (Exception error) when (error is FormatException or JsonException) { throw new ProtocolException("INVALID_PREPARED", "preparedId is invalid"); }
    }
}

internal static class Policy
{
    private static readonly HashSet<string> Devices = new(StringComparer.OrdinalIgnoreCase)
    { "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³" };

    public static string[] Relative(string input)
    {
        if (input.Length is 0 or > 512 || input != input.Normalize(NormalizationForm.FormC) || input.StartsWith('/') || input.StartsWith('\\') || input.Contains('\\') || (input.Length > 1 && input[1] == ':') || input.Any(c => char.IsControl(c)))
            throw new ProtocolException("INVALID_PATH", "path must be a bounded NFC project-relative path using forward slashes");
        var parts = input.Split('/');
        foreach (var part in parts)
        {
            var deviceBase = part.Split('.')[0];
            if (part.Length == 0 || part is "." or ".." || part.EndsWith('.') || part.EndsWith(' ') || part.IndexOfAny([':', '*', '?', '"', '<', '>', '|']) >= 0 || Devices.Contains(deviceBase))
                throw new ProtocolException("INVALID_PATH", "path contains a traversal, device, ADS, wildcard, or alias-prone segment");
        }
        return parts;
    }

    public static void Token(string value, string label)
    {
        if (value.Length is 0 or > 128 || value.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or '-'))) throw new ProtocolException("INVALID_REQUEST", $"invalid {label}");
    }

    public static void Hash(string? value)
    {
        if (value is not null && (value.Length != 64 || value.Any(c => !char.IsAsciiHexDigit(c) || char.IsAsciiLetterUpper(c)))) throw new ProtocolException("INVALID_REQUEST", "SHA-256 values must be 64 lowercase hex characters");
    }

    public static void ArtifactLeaf(string? value)
    {
        if (value is not null && (value.Length > 100 || !value.StartsWith(".__boxspec-", StringComparison.Ordinal) || value.Any(c => c > 127 || c is '/' or '\\' or ':'))) throw new ProtocolException("INVALID_PREPARED", "invalid transaction artifact name");
    }

    public static void ArtifactOrPathLeaf(string value)
    {
        if (value.Length is 0 or > 255 || value.Any(c => c is '/' or '\\' or ':' || char.IsControl(c))) throw new ProtocolException("INVALID_PATH", "invalid relative leaf name");
    }
}

internal static class Json
{
    public static readonly JsonSerializerOptions Options = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, PropertyNameCaseInsensitive = false, DefaultIgnoreCondition = JsonIgnoreCondition.Never, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow };

    public static string RequiredString(JsonElement value, string name, int max)
    {
        if (!value.TryGetProperty(name, out var property) || property.ValueKind != JsonValueKind.String) throw new ProtocolException("INVALID_REQUEST", $"{name} must be a string");
        var result = property.GetString()!;
        if (result.Length > max) throw new ProtocolException("INVALID_REQUEST", $"{name} is too large");
        return result;
    }

    public static string? OptionalString(JsonElement value, string name, int max)
    {
        if (!value.TryGetProperty(name, out var property) || property.ValueKind == JsonValueKind.Null) return null;
        if (property.ValueKind != JsonValueKind.String) throw new ProtocolException("INVALID_REQUEST", $"{name} must be a string or null");
        var result = property.GetString()!;
        if (result.Length > max) throw new ProtocolException("INVALID_REQUEST", $"{name} is too large");
        return result;
    }

    public static bool RequiredBoolean(JsonElement value, string name) => value.TryGetProperty(name, out var property) && property.ValueKind is JsonValueKind.True or JsonValueKind.False ? property.GetBoolean() : throw new ProtocolException("INVALID_REQUEST", $"{name} must be a boolean");

    public static RootIdentity RootIdentity(JsonElement request)
    {
        if (!request.TryGetProperty("rootIdentity", out var value) || value.ValueKind != JsonValueKind.Object) throw new ProtocolException("INVALID_REQUEST", "rootIdentity must be an object");
        RequireOnly(value, ["canonicalPath", "volumeId", "fileId"]);
        return new(RequiredString(value, "canonicalPath", 32767), RequiredString(value, "volumeId", 16), RequiredString(value, "fileId", 32));
    }

    public static void RequireOnly(JsonElement value, string[] allowed)
    {
        var names = new HashSet<string>(allowed, StringComparer.Ordinal);
        foreach (var property in value.EnumerateObject())
            if (!names.Contains(property.Name)) throw new ProtocolException("INVALID_REQUEST", $"unknown field: {property.Name}");
    }
}

internal sealed class ProtocolException(string code, string message, bool retryable = false) : Exception(message)
{
    public string Code { get; } = code;
    public bool Retryable { get; } = retryable;
}
