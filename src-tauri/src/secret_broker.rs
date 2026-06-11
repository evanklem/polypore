use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::thread;

use serde::Deserialize;

use crate::broker_security::{broker_token, token_matches, MAX_BROKER_BODY_BYTES};
use crate::secrets::{self, SecretUseRequest};

#[derive(Default)]
pub struct SecretBroker {
    state: Mutex<Option<SecretBrokerState>>,
}

#[derive(Clone, Debug)]
pub struct SecretBrokerState {
    pub url: String,
    pub token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListRequest {
    scope: Option<String>,
    project_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HasRequest {
    id: String,
    scope: Option<String>,
    project_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UseRequest {
    id: String,
    scope: Option<String>,
    project_path: Option<String>,
    request: SecretUseRequest,
}

impl SecretBroker {
    pub fn ensure_started(&self) -> Result<SecretBrokerState, String> {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| "secret broker lock failed".to_string())?;
        if let Some(state) = guard.clone() {
            return Ok(state);
        }

        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|err| format!("failed to bind secret broker: {err}"))?;
        let addr = listener
            .local_addr()
            .map_err(|err| format!("failed to read secret broker address: {err}"))?;
        let token = broker_token("polypore-secret")?;
        let thread_token = token.clone();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let token = thread_token.clone();
                thread::spawn(move || {
                    let _ = handle_stream(stream, &token);
                });
            }
        });

        let state = SecretBrokerState {
            url: format!("http://{addr}"),
            token,
        };
        *guard = Some(state.clone());
        Ok(state)
    }
}

fn handle_stream(mut stream: TcpStream, token: &str) -> Result<(), String> {
    let mut reader = BufReader::new(
        stream
            .try_clone()
            .map_err(|err| format!("failed to clone broker stream: {err}"))?,
    );
    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .map_err(|err| format!("failed to read request line: {err}"))?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");

    let mut content_length = 0_usize;
    let mut authed = false;
    loop {
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .map_err(|err| format!("failed to read header: {err}"))?;
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        if let Some((key, value)) = trimmed.split_once(':') {
            if key.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse::<usize>().unwrap_or(0);
            }
            if key.eq_ignore_ascii_case("x-polypore-token") && token_matches(value.trim(), token) {
                authed = true;
            }
        }
    }

    if method != "POST" || !authed {
        return write_json(
            &mut stream,
            403,
            serde_json::json!({ "error": "forbidden" }),
        );
    }
    if content_length > MAX_BROKER_BODY_BYTES {
        return write_json(
            &mut stream,
            413,
            serde_json::json!({ "error": "request too large" }),
        );
    }

    let mut body = vec![0_u8; content_length];
    reader
        .read_exact(&mut body)
        .map_err(|err| format!("failed to read body: {err}"))?;
    let response = route(path, &body);
    match response {
        Ok(value) => write_json(&mut stream, 200, value),
        Err(err) => write_json(&mut stream, 400, serde_json::json!({ "error": err })),
    }
}

fn route(path: &str, body: &[u8]) -> Result<serde_json::Value, String> {
    match path {
        "/secrets/list" => {
            let args: ListRequest = serde_json::from_slice(body).map_err(|err| err.to_string())?;
            let secrets = secrets::secrets_list(args.scope, args.project_path)?;
            serde_json::to_value(secrets).map_err(|err| err.to_string())
        }
        "/secrets/has" => {
            let args: HasRequest = serde_json::from_slice(body).map_err(|err| err.to_string())?;
            let configured = secrets::secrets_has(args.id, args.scope, args.project_path)?;
            Ok(serde_json::json!({ "configured": configured }))
        }
        "/secrets/use" => {
            let args: UseRequest = serde_json::from_slice(body).map_err(|err| err.to_string())?;
            let response =
                secrets::secrets_use(args.id, args.request, args.scope, args.project_path)?;
            serde_json::to_value(response).map_err(|err| err.to_string())
        }
        _ => Err("not found".to_string()),
    }
}

fn write_json(stream: &mut TcpStream, status: u16, value: serde_json::Value) -> Result<(), String> {
    let body = serde_json::to_vec(&value).map_err(|err| err.to_string())?;
    let status_text = if status == 200 { "OK" } else { "ERROR" };
    write!(
        stream,
        "HTTP/1.1 {status} {status_text}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    )
    .map_err(|err| format!("failed to write response headers: {err}"))?;
    stream
        .write_all(&body)
        .map_err(|err| format!("failed to write response body: {err}"))
}
