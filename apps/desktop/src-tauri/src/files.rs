//! File access for the webview.
//!
//! * `read_text_file` / `write_text_file` serve paths chosen by the user in native dialogs.
//! * `workspace_*` serve requests that originate from the MCP bridge: paths are relative
//!   and confined to the OpenBench workspace directory (no absolute paths, no `..`,
//!   no escaping through symlinks).

use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

const MAX_FILE_SIZE: u64 = 32 * 1024 * 1024;

/// Writes `text` next to the target and renames it over the target, so a failed write
/// never leaves a truncated project file behind.
pub fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let dir = path.parent().ok_or_else(|| "Некорректный путь".to_string())?;
    let name = path
        .file_name()
        .ok_or_else(|| "Некорректное имя файла".to_string())?
        .to_string_lossy()
        .to_string();
    let tmp = dir.join(format!(".{}.tmp-{}", name, std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Не удалось записать {}: {}", path.display(), e));
    }
    Ok(())
}

pub fn read_limited(path: &Path) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|e| format!("Не удалось открыть {}: {}", path.display(), e))?;
    if !meta.is_file() {
        return Err(format!("{} не является файлом", path.display()));
    }
    if meta.len() > MAX_FILE_SIZE {
        return Err(format!("Файл {} слишком большой", path.display()));
    }
    fs::read_to_string(path).map_err(|e| format!("Не удалось прочитать {}: {}", path.display(), e))
}

/// Resolves a workspace-relative path, rejecting anything that could leave the workspace.
pub fn resolve_in_workspace(workspace: &Path, relative: &str) -> Result<PathBuf, String> {
    let rel = Path::new(relative);
    if relative.trim().is_empty() {
        return Err("PATH_NOT_ALLOWED: пустой путь".into());
    }
    for c in rel.components() {
        match c {
            Component::Normal(_) | Component::CurDir => {}
            _ => {
                return Err(format!(
                    "PATH_NOT_ALLOWED: путь должен быть относительным внутри рабочей папки ({}), без '..' и корня",
                    workspace.display()
                ))
            }
        }
    }
    let full = workspace.join(rel);
    let parent = full.parent().ok_or_else(|| "PATH_NOT_ALLOWED: некорректный путь".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("Не удалось создать папку {}: {}", parent.display(), e))?;
    let canon_ws = fs::canonicalize(workspace).map_err(|e| e.to_string())?;
    let canon_parent = fs::canonicalize(parent).map_err(|e| e.to_string())?;
    if !canon_parent.starts_with(&canon_ws) {
        return Err("PATH_NOT_ALLOWED: путь выходит за пределы рабочей папки".into());
    }
    if let Ok(meta) = fs::symlink_metadata(&full) {
        if meta.file_type().is_symlink() {
            return Err("PATH_NOT_ALLOWED: символические ссылки не допускаются".into());
        }
    }
    Ok(full)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_escapes() {
        let ws = std::env::temp_dir().join("openbench-ws-test");
        fs::create_dir_all(&ws).unwrap();
        assert!(resolve_in_workspace(&ws, "../x.json").is_err());
        assert!(resolve_in_workspace(&ws, "a/../../x.json").is_err());
        assert!(resolve_in_workspace(&ws, "").is_err());
        #[cfg(windows)]
        assert!(resolve_in_workspace(&ws, "C:\\Windows\\x.json").is_err());
        #[cfg(unix)]
        assert!(resolve_in_workspace(&ws, "/etc/passwd").is_err());
        let ok = resolve_in_workspace(&ws, "sub/ok.openbench.json").unwrap();
        assert!(ok.starts_with(&ws));
    }

    #[test]
    fn atomic_write_roundtrip() {
        let ws = std::env::temp_dir().join("openbench-ws-test2");
        fs::create_dir_all(&ws).unwrap();
        let p = ws.join("a.json");
        write_atomic(&p, "one").unwrap();
        write_atomic(&p, "two").unwrap();
        assert_eq!(read_limited(&p).unwrap(), "two");
    }
}
