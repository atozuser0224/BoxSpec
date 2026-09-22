use serde::{Deserialize, Serialize};

pub const MAX_RELATIVE_PATH_CHARS: usize = 512;
pub const MAX_AFTER_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_HASHED_FILE_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RootIdentity {
    pub canonical_path: String,
    pub volume_id: String,
    pub file_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntryIdentity {
    pub volume_id: String,
    pub file_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    InspectRoot {
        #[serde(rename = "requestId")]
        request_id: String,
        root: String,
    },
    ResolveRelative {
        #[serde(rename = "requestId")]
        request_id: String,
        root: String,
        #[serde(rename = "rootIdentity")]
        root_identity: RootIdentity,
        #[serde(rename = "relativePath")]
        relative_path: String,
        #[serde(rename = "allowMissing")]
        allow_missing: bool,
    },
    PrepareReplace {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "transactionId")]
        transaction_id: String,
        root: String,
        #[serde(rename = "rootIdentity")]
        root_identity: RootIdentity,
        #[serde(rename = "relativePath")]
        relative_path: String,
        #[serde(rename = "expectedBeforeHash")]
        expected_before_hash: Option<String>,
        #[serde(rename = "expectedBeforeFileId")]
        expected_before_file_id: Option<String>,
        #[serde(rename = "afterBytesBase64")]
        after_bytes_base64: Option<String>,
    },
    CommitReplace {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "transactionId")]
        transaction_id: String,
        root: String,
        #[serde(rename = "rootIdentity")]
        root_identity: RootIdentity,
        #[serde(rename = "relativePath")]
        relative_path: String,
        #[serde(rename = "preparedId")]
        prepared_id: String,
    },
    ClassifyRecovery {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "transactionId")]
        transaction_id: String,
        root: String,
        #[serde(rename = "rootIdentity")]
        root_identity: RootIdentity,
        #[serde(rename = "relativePath")]
        relative_path: String,
        #[serde(rename = "beforeHash")]
        before_hash: Option<String>,
        #[serde(rename = "afterHash")]
        after_hash: Option<String>,
        #[serde(rename = "preparedId")]
        prepared_id: Option<String>,
    },
}

impl Request {
    pub fn request_id(&self) -> &str {
        match self {
            Self::InspectRoot { request_id, .. }
            | Self::ResolveRelative { request_id, .. }
            | Self::PrepareReplace { request_id, .. }
            | Self::CommitReplace { request_id, .. }
            | Self::ClassifyRecovery { request_id, .. } => request_id,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Response {
    Success {
        ok: bool,
        #[serde(rename = "requestId")]
        request_id: String,
        result: serde_json::Value,
    },
    Failure {
        ok: bool,
        #[serde(rename = "requestId")]
        request_id: String,
        error: ErrorBody,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug)]
pub struct SafeFsError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

impl SafeFsError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), retryable: false }
    }

    pub fn io(context: &str, error: std::io::Error) -> Self {
        Self { code: "IO_ERROR", message: format!("{context}: {error}"), retryable: true }
    }
}

pub type Result<T> = std::result::Result<T, SafeFsError>;
