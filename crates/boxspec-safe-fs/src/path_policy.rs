use crate::protocol::{Result, SafeFsError, MAX_RELATIVE_PATH_CHARS};
use std::path::PathBuf;
use unicode_normalization::UnicodeNormalization;

pub fn validate_request_id(value: &str) -> Result<()> {
    validate_token("requestId", value)
}

pub fn validate_transaction_id(value: &str) -> Result<()> {
    validate_token("transactionId", value)
}

fn validate_token(label: &str, value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 128 || !value.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)) {
        return Err(SafeFsError::new("INVALID_REQUEST", format!("invalid {label}")));
    }
    Ok(())
}

pub fn normalize_relative_path(input: &str) -> Result<Vec<String>> {
    if input.is_empty()
        || input.chars().count() > MAX_RELATIVE_PATH_CHARS
        || input.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
        || input.nfc().collect::<String>() != input
        || input.starts_with('/')
        || input.starts_with('\\')
        || input.contains('\\')
        || input.starts_with("//")
        || input.as_bytes().get(1) == Some(&b':')
    {
        return Err(SafeFsError::new("INVALID_PATH", "path must be a bounded NFC project-relative path using forward slashes"));
    }
    let mut parts = Vec::new();
    for part in input.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.ends_with('.') || part.ends_with(' ') || part.contains(':') {
            return Err(SafeFsError::new("INVALID_PATH", "path contains an empty, traversal, ADS, or alias-prone segment"));
        }
        if is_reserved(part) {
            return Err(SafeFsError::new("INVALID_PATH", "path contains a reserved Windows device name"));
        }
        if part.contains('*') || part.contains('?') || part.contains('"') || part.contains('<') || part.contains('>') || part.contains('|') {
            return Err(SafeFsError::new("INVALID_PATH", "path contains a Windows metacharacter"));
        }
        parts.push(part.to_owned());
    }
    Ok(parts)
}

pub fn join(root: &str, parts: &[String]) -> PathBuf {
    let mut path = PathBuf::from(root);
    for part in parts { path.push(part); }
    path
}

fn is_reserved(part: &str) -> bool {
    let base = part.split('.').next().unwrap_or("");
    matches!(base.to_ascii_uppercase().as_str(), "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "COM2" | "COM3" | "COM4" | "COM5" | "COM6" | "COM7" | "COM8" | "COM9" | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6" | "LPT7" | "LPT8" | "LPT9")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_normalized_relative_paths() {
        assert_eq!(normalize_relative_path("src/ui/file.ts").unwrap(), ["src", "ui", "file.ts"]);
        for invalid in ["../x", "a/../../x", "./x", "a\\b", "/x", "C:x", "C:/x", "//server/x", "a//b", "file:stream", "x. ", "CON", "con.txt", "Lpt9.js", "e\u{301}.txt"] {
            assert!(normalize_relative_path(invalid).is_err(), "accepted {invalid:?}");
        }
        assert!(normalize_relative_path("é.txt").is_ok());
    }
}
