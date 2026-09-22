using System.Buffers;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace BoxSpec.SafeFs;

internal static class Native
{
    private const uint GenericRead = 0x80000000;
    private const uint GenericWrite = 0x40000000;
    private const uint Delete = 0x00010000;
    private const uint ReadAttributes = 0x00000080;
    private const uint ShareRead = 0x1;
    private const uint ShareWrite = 0x2;
    private const uint ShareDelete = 0x4;
    private const uint CreateNew = 1;
    private const uint OpenExisting = 3;
    private const uint AttributeDirectory = 0x10;
    private const uint AttributeNormal = 0x80;
    private const uint AttributeReparsePoint = 0x400;
    private const uint FlagWriteThrough = 0x80000000;
    private const uint FlagBackupSemantics = 0x02000000;
    private const uint FlagOpenReparsePoint = 0x00200000;
    private const uint Synchronize = 0x00100000;
    private const uint FileOpen = 1;
    private const uint FileCreate = 2;
    private const uint FileWriteThroughOption = 0x2;
    private const uint FileDirectoryFile = 0x1;
    private const uint FileSynchronousIoNonAlert = 0x20;
    private const uint FileNonDirectoryFile = 0x40;
    private const uint FileOpenReparsePointOption = 0x00200000;
    private const uint ObjCaseInsensitive = 0x40;
    private const uint FileTypeDisk = 1;
    private const int NtFileRenameInformationClass = 10;
    private const int FileDispositionInfoClass = 4;
    private const int FileAttributeTagInfoClass = 9;
    private const int FileIdInfoClass = 18;

    public static Entry Open(string path, bool readData, bool shareDelete)
    {
        var access = ReadAttributes | (readData ? GenericRead : 0);
        var share = ShareRead | ShareWrite | (shareDelete ? ShareDelete : 0);
        return Entry.FromHandle(OpenRaw(path, access, share, OpenExisting, FlagBackupSemantics | FlagOpenReparsePoint), path);
    }

    public static Walk Walk(string rootPath, RootIdentity binding, string[] parts, bool allowMissing, bool pinFinalForDelete = false)
    {
        // Denying delete sharing on every retained directory prevents concurrent reparenting
        // for the lifetime of this bounded operation.
        var root = Open(rootPath, readData: true, shareDelete: false);
        try
        {
            root.RequireDirectory("project root");
            root.RequireNotReparse("project root");
            VerifyRoot(root, binding);
            var entries = new List<Entry>(parts.Length);
            var cursor = rootPath;
            int? missing = null;
            for (var index = 0; index < parts.Length; index++)
            {
                cursor = Path.Combine(cursor, parts[index]);
                try
                {
                    var isFinal = index + 1 == parts.Length;
                    var entry = OpenRelative(entries.LastOrDefault() ?? root, parts[index], readData: isFinal,
                        deleteAccess: isFinal && pinFinalForDelete, shareWrite: !isFinal, shareDelete: false);
                    try
                    {
                        entry.RequireNotReparse("path entry");
                        if (!StringComparer.Ordinal.Equals(entry.Identity.VolumeId, binding.VolumeId)) throw new ProtocolException("OUT_OF_SCOPE", "path crossed to another volume");
                        if (!Within(binding.CanonicalPath, entry.CanonicalPath)) throw new ProtocolException("OUT_OF_SCOPE", "path resolved outside approved root");
                        var actual = Path.GetFileName(entry.CanonicalPath.TrimEnd('\\'));
                        if (!StringComparer.OrdinalIgnoreCase.Equals(parts[index].Normalize(NormalizationForm.FormC), actual.Normalize(NormalizationForm.FormC))) throw new ProtocolException("PATH_ALIAS", $"path component resolved as a different name: {actual}");
                        if (index + 1 < parts.Length) entry.RequireDirectory("path ancestor");
                        entries.Add(entry);
                    }
                    catch { entry.Dispose(); throw; }
                }
                catch (ProtocolException error) when (error.Code == "NOT_FOUND" && allowMissing)
                {
                    missing = index;
                    break;
                }
            }
            RecheckRoot(rootPath, binding);
            return new Walk(root, entries, Path.Combine(rootPath, Path.Combine(parts)), missing);
        }
        catch { root.Dispose(); throw; }
    }

    public static EnsureDirectoryResult EnsureDirectory(string rootPath, RootIdentity binding, string[] parts)
    {
        var root = Open(rootPath, readData: true, shareDelete: false);
        var retained = new List<Entry>(parts.Length);
        try
        {
            root.RequireDirectory("project root");
            root.RequireNotReparse("project root");
            VerifyRoot(root, binding);
            var parent = root;
            var created = new List<string>();
            var prefix = new StringBuilder();
            foreach (var leaf in parts)
            {
                if (prefix.Length != 0) prefix.Append('/');
                prefix.Append(leaf);
                Entry child;
                try
                {
                    child = OpenRelative(parent, leaf, readData: false, deleteAccess: false, shareWrite: true, shareDelete: false);
                }
                catch (ProtocolException error) when (error.Code == "NOT_FOUND")
                {
                    RecheckRoot(rootPath, binding);
                    try
                    {
                        var handle = OpenRelativeRaw(parent.Handle, leaf, GenericRead | ReadAttributes | Synchronize,
                            ShareRead | ShareWrite, FileCreate, AttributeDirectory,
                            FileDirectoryFile | FileSynchronousIoNonAlert | FileOpenReparsePointOption);
                        child = Entry.FromHandle(handle, leaf);
                        created.Add(prefix.ToString());
                    }
                    catch (ProtocolException collision) when (collision.Code == "ALREADY_EXISTS")
                    {
                        // A concurrent same-name create is safe only after opening the
                        // resulting entry relative to the still-retained parent and
                        // applying every normal identity/reparse/name check.
                        child = OpenRelative(parent, leaf, readData: false, deleteAccess: false, shareWrite: true, shareDelete: false);
                    }
                    RecheckRoot(rootPath, binding);
                }
                try
                {
                    child.RequireNotReparse("directory path entry");
                    child.RequireDirectory("directory path entry");
                    if (child.Identity.VolumeId != binding.VolumeId) throw new ProtocolException("OUT_OF_SCOPE", "directory path crossed to another volume");
                    if (!Within(binding.CanonicalPath, child.CanonicalPath)) throw new ProtocolException("OUT_OF_SCOPE", "directory path resolved outside approved root");
                    var actual = Path.GetFileName(child.CanonicalPath.TrimEnd('\\'));
                    if (!StringComparer.OrdinalIgnoreCase.Equals(leaf.Normalize(NormalizationForm.FormC), actual.Normalize(NormalizationForm.FormC)))
                        throw new ProtocolException("PATH_ALIAS", $"directory component resolved as a different name: {actual}");
                    retained.Add(child);
                    parent = child;
                }
                catch { child.Dispose(); throw; }
            }
            RecheckRoot(rootPath, binding);
            return new EnsureDirectoryResult(parent.CanonicalPath, parent.Identity, created.ToArray());
        }
        finally
        {
            foreach (var entry in retained) entry.Dispose();
            root.Dispose();
        }
    }

    public static void RecheckRoot(string rootPath, RootIdentity binding)
    {
        using var root = Open(rootPath, readData: true, shareDelete: false);
        root.RequireNotReparse("project root");
        VerifyRoot(root, binding);
    }

    private static void VerifyRoot(Entry entry, RootIdentity binding)
    {
        if (entry.Identity.VolumeId != binding.VolumeId || entry.Identity.FileId != binding.FileId || !StringComparer.OrdinalIgnoreCase.Equals(entry.CanonicalPath, binding.CanonicalPath))
            throw new ProtocolException("ROOT_IDENTITY_CHANGED", "approved project root identity changed");
    }

    public static Artifact CreateArtifact(Entry parent, string parentDisplayPath, string transaction, string suffix)
    {
        var transactionHash = Sha256(Encoding.UTF8.GetBytes(transaction))[..12];
        for (var attempt = 0; attempt < 16; attempt++)
        {
            var leaf = $".__boxspec-{transactionHash}-{Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant()}.{suffix}";
            var path = Path.Combine(parentDisplayPath, leaf);
            try
            {
                var handle = OpenRelativeRaw(parent.Handle, leaf, GenericRead | GenericWrite | Delete | Synchronize, ShareRead, FileCreate, AttributeNormal,
                    FileSynchronousIoNonAlert | FileNonDirectoryFile | FileOpenReparsePointOption | FileWriteThroughOption);
                return new Artifact(leaf, path, Entry.FromHandle(handle, path));
            }
            catch (ProtocolException error) when (error.Code == "ALREADY_EXISTS") { }
        }
        throw new ProtocolException("TEMP_COLLISION", "could not allocate exclusive transaction file");
    }

    public static Entry VerifyArtifact(Entry parent, string leaf, EntryIdentity identity, string hash)
    {
        Policy.ArtifactLeaf(leaf);
        var entry = OpenRelative(parent, leaf, readData: true, deleteAccess: true, shareWrite: false, shareDelete: false);
        try
        {
            entry.RequireWritableRegular("transaction artifact");
            if (entry.Identity != identity) throw new ProtocolException("SOURCE_DRIFT", "transaction artifact identity changed");
            if (Hash(entry.Handle, entry.Size) != hash) throw new ProtocolException("SOURCE_DRIFT", "transaction artifact hash changed");
            return entry;
        }
        catch { entry.Dispose(); throw; }
    }

    public static bool ArtifactMatches(Entry parent, string? leaf, EntryIdentity? identity, string? hash)
    {
        if (leaf is null || identity is null || hash is null) return false;
        try { using var entry = VerifyArtifact(parent, leaf, identity, hash); return true; }
        catch (ProtocolException) { return false; }
    }

    public static bool TryDeleteArtifact(Entry parent, string? leaf, EntryIdentity? identity, string? hash)
    {
        if (leaf is null && identity is null && hash is null) return false;
        if (leaf is null || identity is null || hash is null) throw new ProtocolException("INVALID_PREPARED", "artifact binding is incomplete");
        try
        {
            using var entry = VerifyArtifact(parent, leaf, identity, hash);
            MarkDelete(entry.Handle);
            return true;
        }
        catch (ProtocolException error) when (error.Code == "NOT_FOUND") { return false; }
    }

    public static void VerifyBefore(Entry? entry, Prepared prepared)
    {
        if (prepared.BeforeHash is null && prepared.BeforeIdentity is null && entry is null) return;
        if (prepared.BeforeHash is null || prepared.BeforeIdentity is null || entry is null) throw new ProtocolException("SOURCE_DRIFT", "target existence changed after preparation");
        entry.RequireWritableRegular("target");
        if (entry.Identity != prepared.BeforeIdentity) throw new ProtocolException("SOURCE_DRIFT", "target identity changed after preparation");
        if (Hash(entry.Handle, entry.Size) != prepared.BeforeHash) throw new ProtocolException("SOURCE_DRIFT", "target hash changed after preparation");
    }

    public static string? CurrentHash(Entry? entry)
    {
        if (entry is null) return null;
        entry.RequireWritableRegular("target");
        return Hash(entry.Handle, entry.Size);
    }

    public static string Hash(SafeFileHandle handle, long length)
    {
        if (length > Operations.MaxFileBytes) throw new ProtocolException("FILE_TOO_LARGE", "file exceeds hashing limit");
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = ArrayPool<byte>.Shared.Rent(64 * 1024);
        try
        {
            long offset = 0;
            while (offset < length)
            {
                var count = (int)Math.Min(buffer.Length, length - offset);
                var read = RandomAccess.Read(handle, buffer.AsSpan(0, count), offset);
                if (read == 0) throw new ProtocolException("SOURCE_DRIFT", "file became shorter while hashing");
                hash.AppendData(buffer, 0, read);
                offset += read;
            }
            return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
        }
        finally { ArrayPool<byte>.Shared.Return(buffer); }
    }

    public static void Copy(SafeFileHandle source, SafeFileHandle destination, long length)
    {
        if (length > Operations.MaxFileBytes) throw new ProtocolException("FILE_TOO_LARGE", "file exceeds backup limit");
        var buffer = ArrayPool<byte>.Shared.Rent(64 * 1024);
        try
        {
            long offset = 0;
            while (offset < length)
            {
                var count = (int)Math.Min(buffer.Length, length - offset);
                var read = RandomAccess.Read(source, buffer.AsSpan(0, count), offset);
                if (read == 0) throw new ProtocolException("SOURCE_DRIFT", "source became shorter during backup");
                RandomAccess.Write(destination, buffer.AsSpan(0, read), offset);
                offset += read;
            }
        }
        finally { ArrayPool<byte>.Shared.Return(buffer); }
    }

    public static void Flush(SafeFileHandle handle, string label)
    {
        if (!FlushFileBuffers(handle)) throw Win32("IO_ERROR", $"flush {label}");
    }

    public static void MarkDelete(SafeFileHandle handle)
    {
        var info = new FileDispositionInfo { DeleteFile = true };
        if (!SetFileInformationByHandle(handle, FileDispositionInfoClass, ref info, (uint)Marshal.SizeOf<FileDispositionInfo>())) throw Win32("MUTATION_FAILED", "mark checked target for deletion");
    }

    public static void RenameRelative(SafeFileHandle source, SafeFileHandle parent, string leaf, bool replace)
    {
        var name = Encoding.Unicode.GetBytes(leaf);
        var handleOffset = IntPtr.Size == 8 ? 8 : 4;
        var lengthOffset = handleOffset + IntPtr.Size;
        var nameOffset = lengthOffset + sizeof(uint);
        // FILE_RENAME_INFORMATION has 4 bytes of tail storage/padding after the
        // x64 FileName offset. Allocate at least sizeof(header)+name bytes.
        var allocationSize = nameOffset + name.Length + 4;
        var allocation = Marshal.AllocHGlobal(allocationSize);
        try
        {
            for (var i = 0; i < allocationSize; i++) Marshal.WriteByte(allocation, i, 0);
            Marshal.WriteByte(allocation, replace ? (byte)1 : (byte)0);
            var parentPinned = false;
            parent.DangerousAddRef(ref parentPinned);
            try
            {
                Marshal.WriteIntPtr(allocation, handleOffset, parent.DangerousGetHandle());
                Marshal.WriteInt32(allocation, lengthOffset, name.Length);
                Marshal.Copy(name, 0, allocation + nameOffset, name.Length);
                var status = NtSetInformationFile(source, out _, allocation, (uint)allocationSize, NtFileRenameInformationClass);
                if (status < 0)
                {
                    var code = unchecked((int)RtlNtStatusToDosError(status));
                    throw new ProtocolException("MUTATION_FAILED", $"rename prepared file into retained target directory failed ({code})", true);
                }
            }
            finally { if (parentPinned) parent.DangerousRelease(); }
        }
        finally { Marshal.FreeHGlobal(allocation); }
    }

    public static string Sha256(ReadOnlySpan<byte> bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static bool Within(string root, string target)
    {
        if (StringComparer.OrdinalIgnoreCase.Equals(root, target)) return true;
        return target.StartsWith(root.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
    }

    private static SafeFileHandle OpenRaw(string path, uint access, uint share, uint creation, uint flags)
    {
        var handle = CreateFileW(path, access, share, IntPtr.Zero, creation, flags, IntPtr.Zero);
        if (!handle.IsInvalid) return handle;
        var code = Marshal.GetLastWin32Error();
        handle.Dispose();
        if (code is 2 or 3) throw new ProtocolException("NOT_FOUND", $"path not found: {path}");
        if (code is 80 or 183) throw new ProtocolException("ALREADY_EXISTS", "exclusive transaction file already exists");
        throw new ProtocolException("IO_ERROR", $"open failed ({code}): {path}", true);
    }

    private static Entry OpenRelative(Entry parent, string leaf, bool readData, bool deleteAccess, bool shareWrite, bool shareDelete)
    {
        Policy.ArtifactOrPathLeaf(leaf);
        var access = ReadAttributes | Synchronize | GenericRead | (deleteAccess ? Delete : 0);
        var share = ShareRead | (shareWrite ? ShareWrite : 0) | (shareDelete ? ShareDelete : 0);
        var handle = OpenRelativeRaw(parent.Handle, leaf, access, share, FileOpen, 0, FileSynchronousIoNonAlert | FileOpenReparsePointOption);
        return Entry.FromHandle(handle, leaf);
    }

    private static SafeFileHandle OpenRelativeRaw(SafeFileHandle parent, string leaf, uint access, uint share, uint disposition, uint attributes, uint options)
    {
        var nameBuffer = Marshal.StringToHGlobalUni(leaf);
        var unicode = new UnicodeString { Length = checked((ushort)(leaf.Length * 2)), MaximumLength = checked((ushort)(leaf.Length * 2 + 2)), Buffer = nameBuffer };
        var unicodeBuffer = Marshal.AllocHGlobal(Marshal.SizeOf<UnicodeString>());
        try
        {
            Marshal.StructureToPtr(unicode, unicodeBuffer, false);
            var parentPinned = false;
            parent.DangerousAddRef(ref parentPinned);
            try
            {
                var objectAttributes = new ObjectAttributes
                {
                    Length = Marshal.SizeOf<ObjectAttributes>(),
                    RootDirectory = parent.DangerousGetHandle(),
                    ObjectName = unicodeBuffer,
                    Attributes = ObjCaseInsensitive
                };
                var status = NtCreateFile(out var raw, access, ref objectAttributes, out _, IntPtr.Zero, attributes, share, disposition, options, IntPtr.Zero, 0);
                if (status >= 0) return new SafeFileHandle(raw, ownsHandle: true);
                var code = unchecked((int)RtlNtStatusToDosError(status));
                if (code is 2 or 3) throw new ProtocolException("NOT_FOUND", $"relative path not found: {leaf}");
                if (code is 80 or 183) throw new ProtocolException("ALREADY_EXISTS", "exclusive transaction file already exists");
                throw new ProtocolException("IO_ERROR", $"relative open failed ({code}): {leaf}", true);
            }
            finally { if (parentPinned) parent.DangerousRelease(); }
        }
        finally
        {
            Marshal.FreeHGlobal(unicodeBuffer);
            Marshal.FreeHGlobal(nameBuffer);
        }
    }

    private static ProtocolException Win32(string code, string action) => new(code, $"{action} failed ({Marshal.GetLastWin32Error()})", true);

    [StructLayout(LayoutKind.Sequential)]
    internal struct ByHandleFileInformation
    {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct FileAttributeTagInfo { public uint Attributes; public uint ReparseTag; }

    [StructLayout(LayoutKind.Sequential)]
    internal unsafe struct FileIdInfo { public ulong VolumeSerialNumber; public fixed byte FileId[16]; }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileDispositionInfo { [MarshalAs(UnmanagedType.Bool)] public bool DeleteFile; }

    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeString { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }

    [StructLayout(LayoutKind.Sequential)]
    private struct ObjectAttributes
    {
        public int Length;
        public IntPtr RootDirectory;
        public IntPtr ObjectName;
        public uint Attributes;
        public IntPtr SecurityDescriptor;
        public IntPtr SecurityQualityOfService;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoStatusBlock { public IntPtr Status; public IntPtr Information; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern uint GetFileType(SafeFileHandle handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool GetFileInformationByHandle(SafeFileHandle handle, out ByHandleFileInformation info);
    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass, out FileAttributeTagInfo info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern unsafe bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass, out FileIdInfo info, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FlushFileBuffers(SafeFileHandle handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int infoClass, ref FileDispositionInfo info, uint size);
    [DllImport("ntdll.dll")]
    private static extern int NtCreateFile(out IntPtr handle, uint access, ref ObjectAttributes objectAttributes, out IoStatusBlock ioStatusBlock,
        IntPtr allocationSize, uint fileAttributes, uint shareAccess, uint createDisposition, uint createOptions, IntPtr eaBuffer, uint eaLength);
    [DllImport("ntdll.dll")]
    private static extern uint RtlNtStatusToDosError(int status);
    [DllImport("ntdll.dll")]
    private static extern int NtSetInformationFile(SafeFileHandle handle, out IoStatusBlock ioStatusBlock, IntPtr fileInformation, uint length, int fileInformationClass);
}

internal sealed class Entry : IDisposable
{
    public SafeFileHandle Handle { get; }
    public string CanonicalPath { get; private set; } = "";
    public EntryIdentity Identity { get; private set; } = new("", "");
    public uint Attributes { get; private set; }
    public uint ReparseTag { get; private set; }
    public uint LinkCount { get; private set; }
    public long Size { get; private set; }
    public RootIdentity RootIdentity => new(CanonicalPath, Identity.VolumeId, Identity.FileId);
    public string TagText => $"0x{ReparseTag:x8}";
    public string Kind => (Attributes & 0x400) != 0 ? "reparse" : (Attributes & 0x10) != 0 ? "directory" : "file";

    private Entry(SafeFileHandle handle) { Handle = handle; Refresh(); }

    public static Entry FromHandle(SafeFileHandle handle, string path)
    {
        try { return new Entry(handle); }
        catch { handle.Dispose(); throw; }
    }

    public unsafe void Refresh()
    {
        if (Native.GetFileType(Handle) != 1) throw new ProtocolException("UNSUPPORTED_FILE_KIND", "entry is not a disk file or directory");
        if (!Native.GetFileInformationByHandle(Handle, out var basic)) throw new ProtocolException("IO_ERROR", $"read handle metadata failed ({Marshal.GetLastWin32Error()})", true);
        if (!Native.GetFileInformationByHandleEx(Handle, 9, out Native.FileAttributeTagInfo tag, (uint)Marshal.SizeOf<Native.FileAttributeTagInfo>())) throw new ProtocolException("IO_ERROR", $"read reparse metadata failed ({Marshal.GetLastWin32Error()})", true);
        if (!Native.GetFileInformationByHandleEx(Handle, 18, out Native.FileIdInfo id, (uint)sizeof(Native.FileIdInfo))) throw new ProtocolException("IO_ERROR", $"read file identity failed ({Marshal.GetLastWin32Error()})", true);
        var idBytes = new byte[16];
        fixed (byte* destination = idBytes) Buffer.MemoryCopy(id.FileId, destination, 16, 16);
        var needed = Native.GetFinalPathNameByHandleW(Handle, new StringBuilder(1), 0, 0);
        if (needed == 0) throw new ProtocolException("IO_ERROR", $"resolve final path failed ({Marshal.GetLastWin32Error()})", true);
        var path = new StringBuilder((int)needed + 1);
        var written = Native.GetFinalPathNameByHandleW(Handle, path, (uint)path.Capacity, 0);
        if (written == 0 || written >= path.Capacity) throw new ProtocolException("IO_ERROR", $"resolve final path failed ({Marshal.GetLastWin32Error()})", true);
        CanonicalPath = path.ToString();
        Identity = new(id.VolumeSerialNumber.ToString("x16"), Convert.ToHexString(idBytes).ToLowerInvariant());
        Attributes = tag.Attributes;
        ReparseTag = tag.ReparseTag;
        LinkCount = basic.NumberOfLinks;
        Size = ((long)basic.FileSizeHigh << 32) | basic.FileSizeLow;
    }

    public void RequireNotReparse(string label)
    {
        if ((Attributes & 0x400) != 0 || ReparseTag != 0) throw new ProtocolException("REPARSE_POINT", $"{label} is a reparse point ({TagText})");
    }
    public void RequireDirectory(string label)
    {
        if ((Attributes & 0x10) == 0) throw new ProtocolException("UNSUPPORTED_FILE_KIND", $"{label} is not a directory");
    }
    public void RequireWritableRegular(string label)
    {
        RequireNotReparse(label);
        if ((Attributes & 0x10) != 0) throw new ProtocolException("UNSUPPORTED_FILE_KIND", $"{label} is not a regular file");
        if (LinkCount != 1) throw new ProtocolException("HARD_LINK", $"{label} has {LinkCount} hard links");
    }
    public void Dispose() => Handle.Dispose();
}

internal sealed class Walk : IDisposable
{
    private readonly List<Entry> _entries;
    public Entry Root { get; }
    public string TargetPath { get; }
    public int? MissingIndex { get; }
    public Entry? Target => MissingIndex is null ? _entries.LastOrDefault() : null;
    public Entry ClosestExisting => _entries.LastOrDefault() ?? Root;

    public Walk(Entry root, List<Entry> entries, string targetPath, int? missingIndex) { Root = root; _entries = entries; TargetPath = targetPath; MissingIndex = missingIndex; }
    public Entry Parent(int count) => count == 1 ? Root : _entries[count - 2];
    public void DisposeTarget()
    {
        if (Target is null) return;
        _entries[^1].Dispose();
        _entries.RemoveAt(_entries.Count - 1);
    }
    public void Dispose()
    {
        foreach (var entry in _entries) entry.Dispose();
        _entries.Clear();
        Root.Dispose();
    }
}

internal sealed record EnsureDirectoryResult(string FinalPath, EntryIdentity Identity, string[] Created);

internal sealed class Artifact(string leaf, string path, Entry entry) : IDisposable
{
    public string Leaf { get; } = leaf;
    public string Path { get; } = path;
    public Entry Entry { get; } = entry;
    public void DeleteBestEffort() { try { Native.MarkDelete(Entry.Handle); Entry.Dispose(); } catch { } }
    public void Dispose() => Entry.Dispose();
}
