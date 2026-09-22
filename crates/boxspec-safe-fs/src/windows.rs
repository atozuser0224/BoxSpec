use crate::path_policy::{join, normalize_relative_path, validate_transaction_id};
use crate::protocol::{EntryIdentity, Request, Result, RootIdentity, SafeFsError, MAX_AFTER_BYTES, MAX_HASHED_FILE_BYTES};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::ffi::{c_void, OsStr};
use std::io;
use std::mem::{size_of, MaybeUninit};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr::{addr_of, null, null_mut};
use unicode_normalization::UnicodeNormalization;

type Handle = *mut c_void;
const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
const GENERIC_READ: u32 = 0x8000_0000;
const GENERIC_WRITE: u32 = 0x4000_0000;
const DELETE: u32 = 0x0001_0000;
const FILE_READ_ATTRIBUTES: u32 = 0x0000_0080;
const FILE_SHARE_READ: u32 = 0x1;
const FILE_SHARE_WRITE: u32 = 0x2;
const FILE_SHARE_DELETE: u32 = 0x4;
const CREATE_NEW: u32 = 1;
const OPEN_EXISTING: u32 = 3;
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
const FILE_FLAG_WRITE_THROUGH: u32 = 0x8000_0000;
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const FILE_TYPE_DISK: u32 = 1;
const ERROR_FILE_NOT_FOUND: i32 = 2;
const ERROR_PATH_NOT_FOUND: i32 = 3;
const FILE_RENAME_INFO_CLASS: i32 = 3;
const FILE_DISPOSITION_INFO_CLASS: i32 = 4;
const FILE_ATTRIBUTE_TAG_INFO_CLASS: i32 = 9;
const FILE_ID_INFO_CLASS: i32 = 18;
const MAX_PREPARED_ID_BYTES: usize = 16 * 1024;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct FileTime { low: u32, high: u32 }

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct ByHandleFileInformation {
    attributes: u32,
    creation: FileTime,
    access: FileTime,
    write: FileTime,
    volume_serial: u32,
    size_high: u32,
    size_low: u32,
    link_count: u32,
    index_high: u32,
    index_low: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct FileId128 { identifier: [u8; 16] }

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct FileIdInfo { volume_serial: u64, file_id: FileId128 }

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct FileAttributeTagInfo { attributes: u32, reparse_tag: u32 }

#[repr(C)]
struct FileRenameInfo {
    replace_if_exists: u8,
    root_directory: Handle,
    file_name_length: u32,
    file_name: [u16; 1],
}

#[repr(C)]
struct FileDispositionInfo { delete_file: u8 }

#[link(name = "Kernel32")]
extern "system" {
    fn CreateFileW(name: *const u16, access: u32, share: u32, security: *const c_void, creation: u32, flags: u32, template: Handle) -> Handle;
    fn CloseHandle(handle: Handle) -> i32;
    fn GetFileType(handle: Handle) -> u32;
    fn GetFileInformationByHandle(handle: Handle, info: *mut ByHandleFileInformation) -> i32;
    fn GetFileInformationByHandleEx(handle: Handle, class: i32, info: *mut c_void, size: u32) -> i32;
    fn GetFinalPathNameByHandleW(handle: Handle, path: *mut u16, size: u32, flags: u32) -> u32;
    fn ReadFile(handle: Handle, buffer: *mut c_void, bytes: u32, read: *mut u32, overlapped: *mut c_void) -> i32;
    fn WriteFile(handle: Handle, buffer: *const c_void, bytes: u32, written: *mut u32, overlapped: *mut c_void) -> i32;
    fn FlushFileBuffers(handle: Handle) -> i32;
    fn SetFileInformationByHandle(handle: Handle, class: i32, info: *const c_void, size: u32) -> i32;
}

struct OwnedHandle(Handle);
unsafe impl Send for OwnedHandle {}

impl Drop for OwnedHandle {
    fn drop(&mut self) { unsafe { CloseHandle(self.0); } }
}

#[derive(Clone)]
struct Snapshot {
    identity: EntryIdentity,
    canonical_path: String,
    attributes: u32,
    reparse_tag: u32,
    link_count: u32,
    size: u64,
}

struct Entry {
    handle: OwnedHandle,
    snapshot: Snapshot,
}

struct Walk {
    root: Entry,
    entries: Vec<Entry>,
    lexical_target: PathBuf,
    missing_index: Option<usize>,
}

impl Walk {
    fn target(&self) -> Option<&Entry> {
        if self.missing_index.is_none() { self.entries.last().or(Some(&self.root)) } else { None }
    }
    fn parent(&self, segment_count: usize) -> &Entry {
        if segment_count == 1 { &self.root } else { &self.entries[segment_count - 2] }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Prepared {
    version: u32,
    transaction_id: String,
    root_identity: RootIdentity,
    relative_path: String,
    parent_identity: EntryIdentity,
    before_hash: Option<String>,
    before_identity: Option<EntryIdentity>,
    after_hash: Option<String>,
    temp_leaf: Option<String>,
    temp_identity: Option<EntryIdentity>,
    backup_leaf: Option<String>,
    backup_identity: Option<EntryIdentity>,
}

pub fn dispatch(request: Request) -> Result<Value> {
    match request {
        Request::InspectRoot { root, .. } => inspect_root(&root),
        Request::ResolveRelative { root, root_identity, relative_path, allow_missing, .. } => {
            resolve_relative(&root, &root_identity, &relative_path, allow_missing)
        }
        Request::PrepareReplace { transaction_id, root, root_identity, relative_path, expected_before_hash, expected_before_file_id, after_bytes_base64, .. } => {
            prepare_replace(&transaction_id, &root, &root_identity, &relative_path, expected_before_hash.as_deref(), expected_before_file_id.as_deref(), after_bytes_base64.as_deref())
        }
        Request::CommitReplace { transaction_id, root, root_identity, relative_path, prepared_id, .. } => {
            commit_replace(&transaction_id, &root, &root_identity, &relative_path, &prepared_id)
        }
        Request::ClassifyRecovery { transaction_id, root, root_identity, relative_path, before_hash, after_hash, prepared_id, .. } => {
            classify_recovery(&transaction_id, &root, &root_identity, &relative_path, before_hash.as_deref(), after_hash.as_deref(), prepared_id.as_deref())
        }
    }
}

fn inspect_root(root_path: &str) -> Result<Value> {
    if !Path::new(root_path).is_absolute() { return Err(SafeFsError::new("INVALID_ROOT", "project root must be absolute")); }
    let entry = open_entry(Path::new(root_path), false, true)?;
    require_directory(&entry, "project root")?;
    require_not_reparse(&entry, "project root")?;
    let identity = RootIdentity {
        canonical_path: entry.snapshot.canonical_path.clone(),
        volume_id: entry.snapshot.identity.volume_id.clone(),
        file_id: entry.snapshot.identity.file_id.clone(),
    };
    Ok(json!({ "rootIdentity": identity, "reparseTag": format_tag(entry.snapshot.reparse_tag) }))
}

fn resolve_relative(root: &str, expected_root: &RootIdentity, relative: &str, allow_missing: bool) -> Result<Value> {
    let parts = normalize_relative_path(relative)?;
    let walk = walk(root, expected_root, &parts, allow_missing)?;
    let parent = if walk.missing_index.is_none() { walk.parent(parts.len()) } else { walk.entries.last().unwrap_or(&walk.root) };
    let target = walk.target().map(|entry| json!({
        "identity": entry.snapshot.identity,
        "kind": kind(&entry.snapshot),
        "linkCount": entry.snapshot.link_count,
        "reparseTag": format_tag(entry.snapshot.reparse_tag),
        "size": entry.snapshot.size,
    }));
    Ok(json!({
        "exists": walk.missing_index.is_none(),
        "finalPath": walk.lexical_target.to_string_lossy(),
        "parentIdentity": parent.snapshot.identity,
        "target": target,
    }))
}

fn prepare_replace(transaction: &str, root: &str, expected_root: &RootIdentity, relative: &str, before_hash: Option<&str>, before_file_id: Option<&str>, after_b64: Option<&str>) -> Result<Value> {
    validate_transaction_id(transaction)?;
    validate_optional_hash(before_hash)?;
    if before_hash.is_none() && before_file_id.is_some() { return Err(SafeFsError::new("INVALID_REQUEST", "expectedBeforeFileId requires expectedBeforeHash")); }
    let after = match after_b64 {
        Some(value) => {
            let estimate = value.len().saturating_mul(3) / 4;
            if estimate > MAX_AFTER_BYTES { return Err(SafeFsError::new("PAYLOAD_TOO_LARGE", "replacement exceeds byte limit")); }
            let decoded = STANDARD.decode(value).map_err(|_| SafeFsError::new("INVALID_REQUEST", "afterBytesBase64 is invalid"))?;
            if decoded.len() > MAX_AFTER_BYTES { return Err(SafeFsError::new("PAYLOAD_TOO_LARGE", "replacement exceeds byte limit")); }
            Some(decoded)
        }
        None => None,
    };
    if before_hash.is_none() && after.is_none() { return Err(SafeFsError::new("INVALID_REQUEST", "absent-to-absent replacement has no effect")); }
    let parts = normalize_relative_path(relative)?;
    let walk = walk(root, expected_root, &parts, true)?;
    if walk.missing_index.is_some_and(|index| index + 1 != parts.len()) {
        return Err(SafeFsError::new("PARENT_MISSING", "target parent does not exist"));
    }
    let parent = walk.parent(parts.len());
    require_directory(parent, "target parent")?;

    let (actual_before_hash, before_identity) = match (before_hash, walk.target()) {
        (None, None) => (None, None),
        (None, Some(_)) => return Err(SafeFsError::new("SOURCE_DRIFT", "target exists but absence was expected")),
        (Some(_), None) => return Err(SafeFsError::new("SOURCE_DRIFT", "target is absent")),
        (Some(expected), Some(entry)) => {
            require_writable_regular(entry, "target")?;
            if before_file_id.is_some_and(|id| id != entry.snapshot.identity.file_id) {
                return Err(SafeFsError::new("SOURCE_DRIFT", "target file identity changed"));
            }
            let actual = hash_handle(&entry.handle, entry.snapshot.size)?;
            if actual != expected { return Err(SafeFsError::new("SOURCE_DRIFT", "target content hash changed")); }
            (Some(actual), Some(entry.snapshot.identity.clone()))
        }
    };

    let parent_path = walk.lexical_target.parent().ok_or_else(|| SafeFsError::new("INVALID_PATH", "target has no parent"))?;
    let backup = if let Some(target) = walk.target() {
        let (leaf, handle) = create_exclusive(parent_path, transaction, "bak")?;
        copy_handle(&target.handle, &handle, target.snapshot.size)?;
        flush(&handle, "backup")?;
        let snapshot = snapshot(&handle)?;
        Some((leaf, snapshot.identity, actual_before_hash.clone().unwrap()))
    } else { None };

    let temp = if let Some(bytes) = after.as_deref() {
        let (leaf, handle) = match create_exclusive(parent_path, transaction, "tmp") {
            Ok(value) => value,
            Err(error) => {
                if let Some((backup_leaf, _, _)) = &backup { let _ = std::fs::remove_file(parent_path.join(backup_leaf)); }
                return Err(error);
            }
        };
        if let Err(error) = write_all(&handle, bytes).and_then(|_| flush(&handle, "temporary replacement")) {
            let _ = std::fs::remove_file(parent_path.join(&leaf));
            if let Some((backup_leaf, _, _)) = &backup { let _ = std::fs::remove_file(parent_path.join(backup_leaf)); }
            return Err(error);
        }
        let snapshot = snapshot(&handle)?;
        Some((leaf, snapshot.identity, sha256(bytes)))
    } else { None };

    recheck_root(root, expected_root)?;
    let prepared = Prepared {
        version: 1,
        transaction_id: transaction.to_owned(),
        root_identity: expected_root.clone(),
        relative_path: relative.to_owned(),
        parent_identity: parent.snapshot.identity.clone(),
        before_hash: actual_before_hash,
        before_identity,
        after_hash: temp.as_ref().map(|v| v.2.clone()),
        temp_leaf: temp.as_ref().map(|v| v.0.clone()),
        temp_identity: temp.as_ref().map(|v| v.1.clone()),
        backup_leaf: backup.as_ref().map(|v| v.0.clone()),
        backup_identity: backup.as_ref().map(|v| v.1.clone()),
    };
    let prepared_id = encode_prepared(&prepared)?;
    Ok(json!({
        "preparedId": prepared_id,
        "disposition": if prepared.before_hash.is_none() { "create" } else if prepared.after_hash.is_none() { "delete" } else { "replace" },
        "beforeHash": prepared.before_hash,
        "afterHash": prepared.after_hash,
        "backupHash": backup.map(|v| v.2),
        "parentIdentity": prepared.parent_identity,
    }))
}

fn commit_replace(transaction: &str, root: &str, expected_root: &RootIdentity, relative: &str, prepared_id: &str) -> Result<Value> {
    validate_transaction_id(transaction)?;
    let prepared = decode_and_bind(prepared_id, transaction, expected_root, relative)?;
    let parts = normalize_relative_path(relative)?;
    let mut walk = walk(root, expected_root, &parts, true)?;
    if walk.missing_index.is_some_and(|index| index + 1 != parts.len()) { return Err(SafeFsError::new("SOURCE_DRIFT", "target parent disappeared")); }
    let parent = walk.parent(parts.len());
    if parent.snapshot.identity != prepared.parent_identity { return Err(SafeFsError::new("SOURCE_DRIFT", "target parent identity changed")); }
    require_directory(parent, "target parent")?;
    verify_current_before(walk.target(), &prepared)?;

    let parent_path = walk.lexical_target.parent().ok_or_else(|| SafeFsError::new("INVALID_PATH", "target has no parent"))?;
    if let (Some(leaf), Some(identity), Some(hash)) = (&prepared.backup_leaf, &prepared.backup_identity, &prepared.before_hash) {
        verify_artifact(parent_path, leaf, identity, hash)?;
    }
    let temp = match (&prepared.temp_leaf, &prepared.temp_identity, &prepared.after_hash) {
        (Some(leaf), Some(identity), Some(hash)) => Some(verify_artifact(parent_path, leaf, identity, hash)?),
        (None, None, None) => None,
        _ => return Err(SafeFsError::new("INVALID_PREPARED", "temporary replacement binding is incomplete")),
    };
    recheck_root(root, expected_root)?;

    // Remove the exact checked object while holding a handle that denies rename/delete sharing.
    if prepared.before_hash.is_some() {
        let pinned = open_entry(&walk.lexical_target, true, false)?;
        verify_current_before(Some(&pinned), &prepared)?;
        set_delete_on_close(&pinned.handle)?;
        drop(pinned);
        if walk.lexical_target.exists() { return Err(SafeFsError::new("MUTATION_FAILED", "checked target was not removed")); }
    }
    // Do not overwrite a new racing object. The rename is relative to the retained parent handle.
    if let Some(temp_entry) = temp {
        let leaf = parts.last().expect("validated path has a segment");
        rename_relative(&temp_entry.handle, &parent.handle, leaf, false)?;
    }
    drop(walk.entries.pop());
    recheck_root(root, expected_root)?;
    let verified = walk(root, expected_root, &parts, true)?;
    let after_identity = match (&prepared.after_hash, verified.target()) {
        (None, None) => None,
        (Some(expected), Some(entry)) => {
            require_writable_regular(entry, "committed target")?;
            let actual = hash_handle(&entry.handle, entry.snapshot.size)?;
            if &actual != expected { return Err(SafeFsError::new("AFTER_MISMATCH", "committed target hash does not match prepared bytes")); }
            Some(entry.snapshot.identity.clone())
        }
        _ => return Err(SafeFsError::new("AFTER_MISMATCH", "committed target existence does not match prepared state")),
    };
    Ok(json!({ "afterHash": prepared.after_hash, "targetIdentity": after_identity }))
}

fn classify_recovery(transaction: &str, root: &str, expected_root: &RootIdentity, relative: &str, before_hash: Option<&str>, after_hash: Option<&str>, prepared_id: Option<&str>) -> Result<Value> {
    validate_transaction_id(transaction)?;
    validate_optional_hash(before_hash)?;
    validate_optional_hash(after_hash)?;
    let prepared = match prepared_id {
        Some(id) => Some(decode_and_bind(id, transaction, expected_root, relative)?),
        None => None,
    };
    let parts = normalize_relative_path(relative)?;
    let classification = (|| -> Result<&'static str> {
        let walk = walk(root, expected_root, &parts, true)?;
        let current = match walk.target() {
            None => None,
            Some(entry) => {
                require_writable_regular(entry, "recovery target")?;
                Some(hash_handle(&entry.handle, entry.snapshot.size)?)
            }
        };
        if current.as_deref() == before_hash { Ok("BEFORE") }
        else if current.as_deref() == after_hash { Ok("AFTER") }
        else { Ok("UNKNOWN") }
    })();
    let (state, reason) = match classification {
        Ok(value) => (value, None),
        Err(error) => ("UNKNOWN", Some(error.message)),
    };
    let (can_restore, can_finish) = if let Some(prepared) = prepared {
        let parent = join(root, &parts).parent().map(Path::to_path_buf);
        let restore = parent.as_ref().is_some_and(|p| artifact_matches(p, prepared.backup_leaf.as_deref(), prepared.backup_identity.as_ref(), prepared.before_hash.as_deref()));
        let finish = if prepared.after_hash.is_none() { state == "BEFORE" } else { parent.as_ref().is_some_and(|p| artifact_matches(p, prepared.temp_leaf.as_deref(), prepared.temp_identity.as_ref(), prepared.after_hash.as_deref())) };
        (restore, finish)
    } else { (false, false) };
    Ok(json!({ "state": state, "reason": reason, "canRestoreBefore": can_restore, "canFinishAfter": can_finish }))
}

fn walk(root_path: &str, expected_root: &RootIdentity, parts: &[String], allow_missing: bool) -> Result<Walk> {
    let root = open_entry(Path::new(root_path), false, true)?;
    require_directory(&root, "project root")?;
    require_not_reparse(&root, "project root")?;
    verify_root(&root.snapshot, expected_root)?;
    let lexical_target = join(root_path, parts);
    let mut entries = Vec::with_capacity(parts.len());
    let mut cursor = PathBuf::from(root_path);
    let mut missing_index = None;
    for (index, part) in parts.iter().enumerate() {
        cursor.push(part);
        let wants_data = index + 1 == parts.len();
        match open_entry(&cursor, wants_data, true) {
            Ok(entry) => {
                require_not_reparse(&entry, "path entry")?;
                if entry.snapshot.identity.volume_id != expected_root.volume_id { return Err(SafeFsError::new("OUT_OF_SCOPE", "path crossed to another volume")); }
                if !is_within(&expected_root.canonical_path, &entry.snapshot.canonical_path) { return Err(SafeFsError::new("OUT_OF_SCOPE", "path resolved outside approved root")); }
                reject_alias(part, &entry.snapshot.canonical_path)?;
                if index + 1 < parts.len() { require_directory(&entry, "path ancestor")?; }
                entries.push(entry);
            }
            Err(error) if error.code == "NOT_FOUND" && allow_missing => { missing_index = Some(index); break; }
            Err(error) => return Err(error),
        }
    }
    recheck_root(root_path, expected_root)?;
    Ok(Walk { root, entries, lexical_target, missing_index })
}

fn open_entry(path: &Path, read_data: bool, share_delete: bool) -> Result<Entry> {
    let access = FILE_READ_ATTRIBUTES | if read_data { GENERIC_READ } else { 0 };
    let share = FILE_SHARE_READ | FILE_SHARE_WRITE | if share_delete { FILE_SHARE_DELETE } else { 0 };
    let raw = open_raw(path, access, share, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)?;
    let handle = OwnedHandle(raw);
    let snapshot = snapshot(&handle)?;
    Ok(Entry { handle, snapshot })
}

fn open_raw(path: &Path, access: u32, share: u32, creation: u32, flags: u32) -> Result<Handle> {
    let wide = wide_null(path.as_os_str());
    let handle = unsafe { CreateFileW(wide.as_ptr(), access, share, null(), creation, flags, null_mut()) };
    if handle == INVALID_HANDLE_VALUE {
        let error = io::Error::last_os_error();
        return if matches!(error.raw_os_error(), Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND)) {
            Err(SafeFsError::new("NOT_FOUND", format!("path not found: {}", path.display())))
        } else { Err(SafeFsError::io(&format!("open {}", path.display()), error)) };
    }
    Ok(handle)
}

fn snapshot(handle: &OwnedHandle) -> Result<Snapshot> {
    if unsafe { GetFileType(handle.0) } != FILE_TYPE_DISK { return Err(SafeFsError::new("UNSUPPORTED_FILE_KIND", "entry is not a disk file or directory")); }
    let mut basic = ByHandleFileInformation::default();
    if unsafe { GetFileInformationByHandle(handle.0, &mut basic) } == 0 { return Err(SafeFsError::io("read handle metadata", io::Error::last_os_error())); }
    let mut id = FileIdInfo::default();
    if unsafe { GetFileInformationByHandleEx(handle.0, FILE_ID_INFO_CLASS, &mut id as *mut _ as *mut c_void, size_of::<FileIdInfo>() as u32) } == 0 {
        return Err(SafeFsError::io("read 128-bit file identity", io::Error::last_os_error()));
    }
    let mut tag = FileAttributeTagInfo::default();
    if unsafe { GetFileInformationByHandleEx(handle.0, FILE_ATTRIBUTE_TAG_INFO_CLASS, &mut tag as *mut _ as *mut c_void, size_of::<FileAttributeTagInfo>() as u32) } == 0 {
        return Err(SafeFsError::io("read reparse metadata", io::Error::last_os_error()));
    }
    Ok(Snapshot {
        identity: EntryIdentity { volume_id: format!("{:016x}", id.volume_serial), file_id: hex(&id.file_id.identifier) },
        canonical_path: final_path(handle)?,
        attributes: tag.attributes,
        reparse_tag: tag.reparse_tag,
        link_count: basic.link_count,
        size: ((basic.size_high as u64) << 32) | basic.size_low as u64,
    })
}

fn final_path(handle: &OwnedHandle) -> Result<String> {
    let needed = unsafe { GetFinalPathNameByHandleW(handle.0, null_mut(), 0, 0) };
    if needed == 0 { return Err(SafeFsError::io("resolve final path", io::Error::last_os_error())); }
    let mut buffer = vec![0u16; needed as usize + 1];
    let written = unsafe { GetFinalPathNameByHandleW(handle.0, buffer.as_mut_ptr(), buffer.len() as u32, 0) };
    if written == 0 || written as usize >= buffer.len() { return Err(SafeFsError::io("resolve final path", io::Error::last_os_error())); }
    Ok(String::from_utf16_lossy(&buffer[..written as usize]))
}

fn verify_root(snapshot: &Snapshot, expected: &RootIdentity) -> Result<()> {
    if snapshot.identity.volume_id != expected.volume_id || snapshot.identity.file_id != expected.file_id || !windows_equal(&snapshot.canonical_path, &expected.canonical_path) {
        return Err(SafeFsError::new("ROOT_IDENTITY_CHANGED", "approved project root identity changed"));
    }
    Ok(())
}

fn recheck_root(root: &str, expected: &RootIdentity) -> Result<()> {
    let entry = open_entry(Path::new(root), false, true)?;
    require_not_reparse(&entry, "project root")?;
    verify_root(&entry.snapshot, expected)
}

fn verify_current_before(entry: Option<&Entry>, prepared: &Prepared) -> Result<()> {
    match (&prepared.before_hash, &prepared.before_identity, entry) {
        (None, None, None) => Ok(()),
        (Some(hash), Some(identity), Some(entry)) => {
            require_writable_regular(entry, "target")?;
            if &entry.snapshot.identity != identity { return Err(SafeFsError::new("SOURCE_DRIFT", "target identity changed after preparation")); }
            if &hash_handle(&entry.handle, entry.snapshot.size)? != hash { return Err(SafeFsError::new("SOURCE_DRIFT", "target hash changed after preparation")); }
            Ok(())
        }
        _ => Err(SafeFsError::new("SOURCE_DRIFT", "target existence changed after preparation")),
    }
}

fn require_not_reparse(entry: &Entry, label: &str) -> Result<()> {
    if entry.snapshot.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 || entry.snapshot.reparse_tag != 0 {
        return Err(SafeFsError::new("REPARSE_POINT", format!("{label} is a reparse point ({})", format_tag(entry.snapshot.reparse_tag))));
    }
    Ok(())
}

fn require_directory(entry: &Entry, label: &str) -> Result<()> {
    if entry.snapshot.attributes & FILE_ATTRIBUTE_DIRECTORY == 0 { return Err(SafeFsError::new("UNSUPPORTED_FILE_KIND", format!("{label} is not a directory"))); }
    Ok(())
}

fn require_writable_regular(entry: &Entry, label: &str) -> Result<()> {
    require_not_reparse(entry, label)?;
    if entry.snapshot.attributes & FILE_ATTRIBUTE_DIRECTORY != 0 { return Err(SafeFsError::new("UNSUPPORTED_FILE_KIND", format!("{label} is not a regular file"))); }
    if entry.snapshot.link_count != 1 { return Err(SafeFsError::new("HARD_LINK", format!("{label} has {} hard links", entry.snapshot.link_count))); }
    Ok(())
}

fn create_exclusive(parent: &Path, transaction: &str, suffix: &str) -> Result<(String, OwnedHandle)> {
    let transaction_hash = &sha256(transaction.as_bytes())[..12];
    for _ in 0..16 {
        let mut random = [0u8; 16];
        OsRng.fill_bytes(&mut random);
        let leaf = format!(".__boxspec-{transaction_hash}-{}.{}", hex(&random), suffix);
        let path = parent.join(&leaf);
        match open_raw(&path, GENERIC_READ | GENERIC_WRITE | DELETE, FILE_SHARE_READ, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH | FILE_FLAG_OPEN_REPARSE_POINT) {
            Ok(handle) => return Ok((leaf, OwnedHandle(handle))),
            Err(error) if error.code == "IO_ERROR" => continue,
            Err(error) => return Err(error),
        }
    }
    Err(SafeFsError::new("TEMP_COLLISION", "could not allocate exclusive transaction file"))
}

fn hash_handle(handle: &OwnedHandle, size: u64) -> Result<String> {
    if size > MAX_HASHED_FILE_BYTES { return Err(SafeFsError::new("FILE_TOO_LARGE", "file exceeds hashing limit")); }
    let mut hasher = Sha256::new();
    let mut remaining = size;
    let mut buffer = [0u8; 64 * 1024];
    while remaining > 0 {
        let request = remaining.min(buffer.len() as u64) as u32;
        let mut read = 0;
        if unsafe { ReadFile(handle.0, buffer.as_mut_ptr() as *mut c_void, request, &mut read, null_mut()) } == 0 {
            return Err(SafeFsError::io("read file for hashing", io::Error::last_os_error()));
        }
        if read == 0 { return Err(SafeFsError::new("SOURCE_DRIFT", "file became shorter while hashing")); }
        hasher.update(&buffer[..read as usize]);
        remaining -= read as u64;
    }
    Ok(hex(&hasher.finalize()))
}

fn copy_handle(source: &OwnedHandle, destination: &OwnedHandle, size: u64) -> Result<()> {
    if size > MAX_HASHED_FILE_BYTES { return Err(SafeFsError::new("FILE_TOO_LARGE", "file exceeds backup limit")); }
    let mut remaining = size;
    let mut buffer = [0u8; 64 * 1024];
    while remaining > 0 {
        let request = remaining.min(buffer.len() as u64) as u32;
        let mut read = 0;
        if unsafe { ReadFile(source.0, buffer.as_mut_ptr() as *mut c_void, request, &mut read, null_mut()) } == 0 { return Err(SafeFsError::io("read backup source", io::Error::last_os_error())); }
        if read == 0 { return Err(SafeFsError::new("SOURCE_DRIFT", "source became shorter during backup")); }
        write_all(destination, &buffer[..read as usize])?;
        remaining -= read as u64;
    }
    Ok(())
}

fn write_all(handle: &OwnedHandle, mut bytes: &[u8]) -> Result<()> {
    while !bytes.is_empty() {
        let request = bytes.len().min(u32::MAX as usize) as u32;
        let mut written = 0;
        if unsafe { WriteFile(handle.0, bytes.as_ptr() as *const c_void, request, &mut written, null_mut()) } == 0 { return Err(SafeFsError::io("write transaction file", io::Error::last_os_error())); }
        if written == 0 { return Err(SafeFsError::new("IO_ERROR", "zero-byte write")); }
        bytes = &bytes[written as usize..];
    }
    Ok(())
}

fn flush(handle: &OwnedHandle, label: &str) -> Result<()> {
    if unsafe { FlushFileBuffers(handle.0) } == 0 { return Err(SafeFsError::io(&format!("flush {label}"), io::Error::last_os_error())); }
    Ok(())
}

fn rename_relative(source: &OwnedHandle, parent: &OwnedHandle, leaf: &str, replace: bool) -> Result<()> {
    let wide: Vec<u16> = OsStr::new(leaf).encode_wide().collect();
    let uninit = MaybeUninit::<FileRenameInfo>::uninit();
    let base = uninit.as_ptr();
    let offset = unsafe { (addr_of!((*base).file_name) as usize) - (base as usize) };
    let byte_len = offset + wide.len() * 2;
    let words = (byte_len + size_of::<usize>() - 1) / size_of::<usize>();
    let mut storage = vec![0usize; words];
    let info = storage.as_mut_ptr() as *mut FileRenameInfo;
    unsafe {
        (*info).replace_if_exists = u8::from(replace);
        (*info).root_directory = parent.0;
        (*info).file_name_length = (wide.len() * 2) as u32;
        std::ptr::copy_nonoverlapping(wide.as_ptr(), (*info).file_name.as_mut_ptr(), wide.len());
        if SetFileInformationByHandle(source.0, FILE_RENAME_INFO_CLASS, info as *const c_void, byte_len as u32) == 0 {
            return Err(SafeFsError::io("rename prepared file into target directory", io::Error::last_os_error()));
        }
    }
    Ok(())
}

fn set_delete_on_close(handle: &OwnedHandle) -> Result<()> {
    let info = FileDispositionInfo { delete_file: 1 };
    if unsafe { SetFileInformationByHandle(handle.0, FILE_DISPOSITION_INFO_CLASS, &info as *const _ as *const c_void, size_of::<FileDispositionInfo>() as u32) } == 0 {
        return Err(SafeFsError::io("mark checked target for deletion", io::Error::last_os_error()));
    }
    Ok(())
}

fn verify_artifact(parent: &Path, leaf: &str, identity: &EntryIdentity, hash: &str) -> Result<Entry> {
    validate_artifact_leaf(leaf)?;
    let entry = open_entry(&parent.join(leaf), true, false)?;
    require_writable_regular(&entry, "transaction artifact")?;
    if &entry.snapshot.identity != identity { return Err(SafeFsError::new("SOURCE_DRIFT", "transaction artifact identity changed")); }
    if hash_handle(&entry.handle, entry.snapshot.size)? != hash { return Err(SafeFsError::new("SOURCE_DRIFT", "transaction artifact hash changed")); }
    Ok(entry)
}

fn artifact_matches(parent: &Path, leaf: Option<&str>, identity: Option<&EntryIdentity>, hash: Option<&str>) -> bool {
    match (leaf, identity, hash) {
        (Some(leaf), Some(identity), Some(hash)) => verify_artifact(parent, leaf, identity, hash).is_ok(),
        _ => false,
    }
}

fn encode_prepared(prepared: &Prepared) -> Result<String> {
    let bytes = serde_json::to_vec(prepared).map_err(|error| SafeFsError::new("INTERNAL_ERROR", error.to_string()))?;
    if bytes.len() > MAX_PREPARED_ID_BYTES { return Err(SafeFsError::new("INTERNAL_ERROR", "prepared descriptor too large")); }
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn decode_and_bind(value: &str, transaction: &str, root: &RootIdentity, relative: &str) -> Result<Prepared> {
    if value.len() > MAX_PREPARED_ID_BYTES * 2 { return Err(SafeFsError::new("INVALID_PREPARED", "preparedId is too large")); }
    let bytes = URL_SAFE_NO_PAD.decode(value).map_err(|_| SafeFsError::new("INVALID_PREPARED", "preparedId is invalid"))?;
    if bytes.len() > MAX_PREPARED_ID_BYTES { return Err(SafeFsError::new("INVALID_PREPARED", "preparedId is too large")); }
    let prepared: Prepared = serde_json::from_slice(&bytes).map_err(|_| SafeFsError::new("INVALID_PREPARED", "preparedId payload is invalid"))?;
    if prepared.version != 1 || prepared.transaction_id != transaction || &prepared.root_identity != root || prepared.relative_path != relative {
        return Err(SafeFsError::new("INVALID_PREPARED", "preparedId binding does not match commit request"));
    }
    validate_optional_hash(prepared.before_hash.as_deref())?;
    validate_optional_hash(prepared.after_hash.as_deref())?;
    if let Some(leaf) = prepared.temp_leaf.as_deref() { validate_artifact_leaf(leaf)?; }
    if let Some(leaf) = prepared.backup_leaf.as_deref() { validate_artifact_leaf(leaf)?; }
    Ok(prepared)
}

fn validate_artifact_leaf(value: &str) -> Result<()> {
    if value.len() > 100 || !value.starts_with(".__boxspec-") || value.contains('/') || value.contains('\\') || value.contains(':') || !value.is_ascii() {
        return Err(SafeFsError::new("INVALID_PREPARED", "invalid transaction artifact name"));
    }
    Ok(())
}

fn validate_optional_hash(value: Option<&str>) -> Result<()> {
    if value.is_some_and(|hash| hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))) {
        return Err(SafeFsError::new("INVALID_REQUEST", "SHA-256 values must be 64 lowercase hex characters"));
    }
    Ok(())
}

fn reject_alias(requested: &str, canonical_path: &str) -> Result<()> {
    let actual = canonical_path.rsplit('\\').next().unwrap_or(canonical_path);
    if !windows_equal(requested, actual) {
        return Err(SafeFsError::new("PATH_ALIAS", format!("path component {requested:?} resolved as {actual:?}")));
    }
    Ok(())
}

fn is_within(root: &str, target: &str) -> bool {
    if windows_equal(root, target) { return true; }
    let prefix = format!("{}\\", root.trim_end_matches('\\'));
    let target_chars: Vec<char> = target.chars().collect();
    let prefix_chars: Vec<char> = prefix.chars().collect();
    target_chars.len() >= prefix_chars.len() && windows_equal(&target_chars[..prefix_chars.len()].iter().collect::<String>(), &prefix)
}

// Windows' ordinal comparison is closest to invariant filesystem name comparison. NFC is
// required at the protocol boundary; the final handle name is normalized before comparison.
fn windows_equal(left: &str, right: &str) -> bool {
    left.nfc().collect::<String>().to_uppercase() == right.nfc().collect::<String>().to_uppercase()
}

fn kind(snapshot: &Snapshot) -> &'static str {
    if snapshot.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 { "reparse" }
    else if snapshot.attributes & FILE_ATTRIBUTE_DIRECTORY != 0 { "directory" }
    else { "file" }
}

fn format_tag(tag: u32) -> String { format!("0x{tag:08x}") }
fn wide_null(value: &OsStr) -> Vec<u16> { value.encode_wide().chain(Some(0)).collect() }
fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }
fn sha256(bytes: &[u8]) -> String { hex(&Sha256::digest(bytes)) }
