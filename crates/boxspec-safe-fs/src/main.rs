use std::io::{self, Read};

const MAX_REQUEST_BYTES: u64 = 24 * 1024 * 1024;

fn main() {
    let valid_protocol = std::env::args().collect::<Vec<_>>().as_slice() == [std::env::args().next().unwrap_or_default(), "--protocol".into(), "1".into()];
    if !valid_protocol {
        eprintln!("usage: boxspec-safe-fs --protocol 1");
        std::process::exit(2);
    }

    let mut bytes = Vec::new();
    if let Err(error) = io::stdin().take(MAX_REQUEST_BYTES + 1).read_to_end(&mut bytes) {
        eprintln!("failed to read request: {error}");
        std::process::exit(2);
    }
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        eprintln!("request exceeds {MAX_REQUEST_BYTES} bytes");
        std::process::exit(2);
    }

    let request = match serde_json::from_slice(&bytes) {
        Ok(request) => request,
        Err(error) => {
            eprintln!("invalid request JSON: {error}");
            std::process::exit(2);
        }
    };
    let response = boxspec_safe_fs::dispatch(request);
    match serde_json::to_writer(io::stdout().lock(), &response) {
        Ok(()) => {}
        Err(error) => {
            eprintln!("failed to write response: {error}");
            std::process::exit(3);
        }
    }
}
