mod path_policy;
pub mod protocol;

use protocol::{Request, Response};

#[cfg(windows)]
mod windows;

pub fn dispatch(request: Request) -> Response {
    let request_id = request.request_id().to_owned();
    let outcome = path_policy::validate_request_id(&request_id).and_then(|_| dispatch_platform(request));
    match outcome {
        Ok(result) => Response::Success { ok: true, request_id, result },
        Err(error) => Response::Failure {
            ok: false,
            request_id,
            error: protocol::ErrorBody { code: error.code, message: error.message, retryable: error.retryable },
        },
    }
}

#[cfg(windows)]
fn dispatch_platform(request: Request) -> protocol::Result<serde_json::Value> {
    windows::dispatch(request)
}

#[cfg(not(windows))]
fn dispatch_platform(_request: Request) -> protocol::Result<serde_json::Value> {
    Err(protocol::SafeFsError::new("UNSUPPORTED_PLATFORM", "boxspec-safe-fs requires Windows"))
}
