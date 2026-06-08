use std::path::PathBuf;

pub const PROJECT_ROOT_ENV: &str = "POLYPORE_PROJECT_ROOT";

pub fn set_active_project_root(path: impl Into<PathBuf>) {
    std::env::set_var(PROJECT_ROOT_ENV, path.into().display().to_string());
}

pub fn active_project_root() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var(PROJECT_ROOT_ENV) {
        return Ok(PathBuf::from(path));
    }
    let cwd = std::env::current_dir().map_err(|err| format!("failed to read cwd: {err}"))?;
    if cwd.file_name().and_then(|name| name.to_str()) == Some("src-tauri") {
        return cwd
            .parent()
            .map(PathBuf::from)
            .ok_or_else(|| "cannot resolve project root".to_string());
    }
    Ok(cwd)
}

pub fn active_project_path() -> Result<String, String> {
    active_project_root().map(|path| path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_project_root_prefers_env() {
        let previous = std::env::var(PROJECT_ROOT_ENV).ok();
        std::env::set_var(PROJECT_ROOT_ENV, "/tmp/polypore-active-root");

        let root = active_project_root().expect("active root");

        assert_eq!(root, PathBuf::from("/tmp/polypore-active-root"));
        match previous {
            Some(value) => std::env::set_var(PROJECT_ROOT_ENV, value),
            None => std::env::remove_var(PROJECT_ROOT_ENV),
        }
    }
}
