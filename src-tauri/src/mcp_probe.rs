use std::collections::HashMap;
use std::time::Duration;

#[derive(Debug, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub ok: bool,
    pub status: Option<u16>,
    pub error: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeInput {
    pub transport: String,
    pub url: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
}

/// Tauri command: probe an MCP server and return a `ProbeResult`.
#[tauri::command]
pub fn mcp_server_probe(input: ProbeInput) -> ProbeResult {
    probe(input)
}

/// Probe an MCP server to confirm it responds to a `tools/list` request.
/// HTTP/SSE transports are supported; stdio returns a clear "not yet implemented" error.
pub fn probe(input: ProbeInput) -> ProbeResult {
    match input.transport.as_str() {
        "http" | "sse" => probe_http(input),
        "stdio" => {
            let command = input.command.as_deref().unwrap_or("stdio server");
            let arg_count = input.args.as_ref().map(|args| args.len()).unwrap_or(0);
            ProbeResult {
                ok: false,
                status: None,
                error: Some(format!(
                    "stdio probe not yet implemented for {command} ({arg_count} args)"
                )),
            }
        }
        other => ProbeResult {
            ok: false,
            status: None,
            error: Some(format!("unknown transport: {other}")),
        },
    }
}

fn probe_http(input: ProbeInput) -> ProbeResult {
    let url = match input.url {
        Some(ref u) => u.clone(),
        None => {
            return ProbeResult {
                ok: false,
                status: None,
                error: Some("url is required for http/sse transport".to_string()),
            }
        }
    };

    let timeout = Duration::from_secs(5);

    let client = match reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return ProbeResult {
                ok: false,
                status: None,
                error: Some(format!("failed to build http client: {e}")),
            }
        }
    };

    let jsonrpc_body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/list",
        "params": {}
    });

    let mut request = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&jsonrpc_body);

    if let Some(headers) = input.headers {
        for (key, value) in headers {
            request = request.header(key, value);
        }
    }

    match request.send() {
        Ok(resp) => {
            let status = resp.status().as_u16();
            if resp.status().is_success() {
                // Try to parse the body as JSON; if it parses we consider it a success.
                match resp.text() {
                    Ok(body) => {
                        if serde_json::from_str::<serde_json::Value>(&body).is_ok() {
                            ProbeResult {
                                ok: true,
                                status: Some(status),
                                error: None,
                            }
                        } else {
                            ProbeResult {
                                ok: false,
                                status: Some(status),
                                error: Some("response body is not valid JSON".to_string()),
                            }
                        }
                    }
                    Err(e) => ProbeResult {
                        ok: false,
                        status: Some(status),
                        error: Some(format!("failed to read response body: {e}")),
                    },
                }
            } else {
                let error_body = resp.text().unwrap_or_else(|_| format!("HTTP {status}"));
                ProbeResult {
                    ok: false,
                    status: Some(status),
                    error: Some(error_body),
                }
            }
        }
        Err(e) => {
            let error_str = e.to_string();
            // reqwest encodes timeouts in the error chain
            if e.is_timeout() || error_str.contains("timed out") || error_str.contains("timeout") {
                ProbeResult {
                    ok: false,
                    status: None,
                    error: Some("timeout".to_string()),
                }
            } else {
                ProbeResult {
                    ok: false,
                    status: None,
                    error: Some(error_str),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    /// Spin up a bare TCP server that speaks enough HTTP/1.1 to satisfy reqwest.
    /// Returns the bound port.
    fn spawn_stub_http_server(response_body: &'static str, status_line: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind stub server");
        let port = listener.local_addr().unwrap().port();
        let body_len = response_body.len();
        thread::spawn(move || {
            // Accept one connection then exit.
            if let Ok((mut stream, _)) = listener.accept() {
                // Drain the request.
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                // Write the response.
                let response = format!(
                    "{status_line}\r\nContent-Type: application/json\r\nContent-Length: {body_len}\r\nConnection: close\r\n\r\n{response_body}"
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        port
    }

    #[test]
    fn mcp_probe_http_ok_returns_ok_true() {
        let body = r#"{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}"#;
        let port = spawn_stub_http_server(body, "HTTP/1.1 200 OK");
        let url = format!("http://127.0.0.1:{port}/mcp");

        let result = probe(ProbeInput {
            transport: "http".to_string(),
            url: Some(url),
            headers: None,
            command: None,
            args: None,
        });

        assert!(result.ok, "expected ok=true but got: {:?}", result);
        assert_eq!(
            result.status,
            Some(200),
            "expected status=200 but got: {:?}",
            result
        );
    }

    #[test]
    fn mcp_probe_http_non_200_returns_ok_false() {
        let body = r#"{"error":"service unavailable"}"#;
        let port = spawn_stub_http_server(body, "HTTP/1.1 503 Service Unavailable");
        let url = format!("http://127.0.0.1:{port}/mcp");

        let result = probe(ProbeInput {
            transport: "http".to_string(),
            url: Some(url),
            headers: None,
            command: None,
            args: None,
        });

        assert!(!result.ok, "expected ok=false but got: {:?}", result);
        assert_eq!(
            result.status,
            Some(503),
            "expected status=503 but got: {:?}",
            result
        );
        assert!(
            result.error.is_some(),
            "expected error to be Some but got: {:?}",
            result
        );
    }

    #[test]
    fn mcp_probe_http_timeout_returns_ok_false() {
        // Bind a port but never accept — reqwest will time out.
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind timeout stub");
        let port = listener.local_addr().unwrap().port();
        // Keep the listener alive for the duration of the test without accepting,
        // so the connection hangs rather than being refused.
        let _listener = listener;

        let url = format!("http://127.0.0.1:{port}/mcp");

        // Use a 1-second timeout so the test doesn't take 5 seconds.
        let timeout = Duration::from_secs(1);
        let client = reqwest::blocking::Client::builder()
            .timeout(timeout)
            .build()
            .expect("build client");

        let jsonrpc_body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/list",
            "params": {}
        });

        let send_result = client.post(&url).json(&jsonrpc_body).send();

        let result = match send_result {
            Ok(resp) => {
                let status = resp.status().as_u16();
                ProbeResult {
                    ok: false,
                    status: Some(status),
                    error: Some("unexpected response".to_string()),
                }
            }
            Err(e) => {
                let error_str = e.to_string();
                if e.is_timeout()
                    || error_str.contains("timed out")
                    || error_str.contains("timeout")
                {
                    ProbeResult {
                        ok: false,
                        status: None,
                        error: Some("timeout".to_string()),
                    }
                } else {
                    ProbeResult {
                        ok: false,
                        status: None,
                        error: Some(error_str),
                    }
                }
            }
        };

        assert!(!result.ok, "expected ok=false but got: {:?}", result);
        assert!(
            result
                .error
                .as_deref()
                .map(|e| e.contains("timeout"))
                .unwrap_or(false),
            "expected error containing 'timeout' but got: {:?}",
            result
        );
    }

    #[test]
    fn mcp_probe_stdio_returns_unimplemented_error() {
        let result = probe(ProbeInput {
            transport: "stdio".to_string(),
            url: None,
            headers: None,
            command: Some("npx".to_string()),
            args: Some(vec![
                "-y".to_string(),
                "@modelcontextprotocol/server-filesystem".to_string(),
            ]),
        });

        assert!(!result.ok, "expected ok=false but got: {:?}", result);
        assert!(
            result
                .error
                .as_deref()
                .map(|e| e.contains("stdio"))
                .unwrap_or(false),
            "expected error containing 'stdio' but got: {:?}",
            result
        );
    }
}
