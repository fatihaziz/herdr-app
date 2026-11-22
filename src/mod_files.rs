//! Asynchronous text files for mods. Writes reject a stale editor snapshot.
use gpui_shell::{HostError, HostValue};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;

pub const LIMIT: u64 = 1024 * 1024;
static WRITES: Mutex<()> = Mutex::new(());

pub fn read(path: &Path) -> Result<Option<String>, String> {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let mut text = String::new();
    file.take(LIMIT + 1)
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    if text.len() as u64 > LIMIT {
        return Err("Text file exceeds 1 MiB".into());
    }
    Ok(Some(text))
}

fn resolved_target(path: &Path) -> Result<std::path::PathBuf, String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => std::fs::canonicalize(path).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let parent = path.parent().ok_or("File needs a parent directory")?;
            let parent = std::fs::canonicalize(parent).map_err(|e| e.to_string())?;
            Ok(parent.join(path.file_name().ok_or("File needs a name")?))
        }
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(windows)]
fn replace_file(target: &Path, temp: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
    let mut backup_name = temp.as_os_str().to_os_string();
    backup_name.push(".backup");
    let backup_path = std::path::PathBuf::from(backup_name);
    match std::fs::symlink_metadata(&backup_path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Ok(_) => return Err("Replacement backup path already exists".into()),
        Err(e) => return Err(e.to_string()),
    }
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let replacement: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    let backup: Vec<u16> = backup_path.as_os_str().encode_wide().chain(Some(0)).collect();
    let result = unsafe { ReplaceFileW(target.as_ptr(), replacement.as_ptr(), backup.as_ptr(), 0, std::ptr::null_mut(), std::ptr::null_mut()) };
    if result == 0 {
        Err(format!("{}; original recovery backup (if present): {}", std::io::Error::last_os_error(), backup_path.display()))
    } else {
        let _ = std::fs::remove_file(backup_path);
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(target: &Path, temp: &Path) -> Result<(), String> {
    std::fs::rename(temp, target).map_err(|e| e.to_string())
}

fn write(path: &Path, text: &str, expected: Option<&str>) -> Result<(), String> {
    write_before_publish(path, text, expected, || {})
}

fn write_before_publish(path: &Path, text: &str, expected: Option<&str>, before_publish: impl FnOnce()) -> Result<(), String> {
    if text.len() as u64 > LIMIT { return Err("Text file exceeds 1 MiB".into()); }
    let started = std::time::Instant::now();
    let _guard = loop {
        match WRITES.try_lock() {
            Ok(guard) => break guard,
            Err(std::sync::TryLockError::Poisoned(e)) => return Err(e.to_string()),
            Err(std::sync::TryLockError::WouldBlock) if started.elapsed() < std::time::Duration::from_secs(5) => std::thread::sleep(std::time::Duration::from_millis(20)),
            Err(_) => return Err("Busy: timed out waiting for file lock".into()),
        }
    };
    let parent = path.parent().ok_or("File needs a parent directory")?;
    if expected.is_none() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    let target = resolved_target(path)?;
    let mut lock_name = target.as_os_str().to_os_string();
    lock_name.push(".herdr-lock");
    let lock = std::fs::OpenOptions::new().read(true).write(true).create(true).open(lock_name).map_err(|e| e.to_string())?;
    loop {
        match lock.try_lock() {
            Ok(()) => break,
            Err(std::fs::TryLockError::WouldBlock) if started.elapsed() < std::time::Duration::from_secs(5) => std::thread::sleep(std::time::Duration::from_millis(20)),
            Err(std::fs::TryLockError::WouldBlock) => return Err("Busy: timed out waiting for file lock".into()),
            Err(e) => return Err(e.to_string()),
        }
    }
    let result = (|| {
        if resolved_target(path)? != target { return Err("File path changed while saving".into()); }
        if read(&target)?.as_deref() != expected { return Err("The file changed outside Herdr. Reload before saving; your draft is still here.".into()); }
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let mut name = target.as_os_str().to_os_string();
        name.push(format!(".herdr-temp-{}-{}", std::process::id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        let temp = std::path::PathBuf::from(name);
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|e| e.to_string())?;
        let prepared = (|| {
            #[cfg(not(windows))]
            if expected.is_some() {
                file.set_permissions(std::fs::metadata(&target).map_err(|e| e.to_string())?.permissions()).map_err(|e| e.to_string())?;
            }
            file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            drop(file);
            before_publish();
            if resolved_target(path)? != target || read(&target)?.as_deref() != expected {
                return Err("The file changed while saving. Reload before saving.".into());
            }
            if expected.is_none() {
                std::fs::hard_link(&temp, &target).map_err(|e| e.to_string())?;
                let _ = std::fs::remove_file(&temp);
                Ok(())
            } else {
                replace_file(&target, &temp)
            }
        })();
        if prepared.is_err() {
            // Keep the complete temp on failure: Windows replacement failures can be ambiguous.
            return Err(format!("{}; recovery file: {}", prepared.unwrap_err(), temp.display()));
        }
        Ok(())
    })();
    lock.unlock().map_err(|e| e.to_string())?;
    result
}

/// Reads off the UI thread: the text, or null when absent.
pub fn read_with(
    read: impl FnOnce() -> Result<Option<String>, String> + Send + 'static,
) -> impl std::future::Future<Output = Result<HostValue, HostError>> + Send {
    let (tx, rx) = async_channel::bounded(1);
    std::thread::spawn(move || {
        let _ = tx.send_blocking(read());
    });
    async move {
        let value = rx
            .recv()
            .await
            .map_err(|e| HostError::new(e.to_string()))?
            .map_err(HostError::new)?;
        Ok(value.map(HostValue::from).unwrap_or(HostValue::Null))
    }
}

pub fn write_text(
    path: String,
    text: String,
    expected: Option<String>,
) -> impl std::future::Future<Output = Result<HostValue, HostError>> + Send {
    let (tx, rx) = async_channel::bounded(1);
    std::thread::spawn(move || {
        let _ = tx.send_blocking(write(Path::new(&path), &text, expected.as_deref()));
    });
    async move {
        rx.recv()
            .await
            .map_err(|e| HostError::new(e.to_string()))?
            .map_err(HostError::new)?;
        Ok(HostValue::Null)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn creates_updates_and_rejects_stale_text() {
        let root = crate::test_tmp().join(format!(
            "herdr-app-files-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = root.join(".brain/todo.md");
        assert_eq!(read(&path).unwrap(), None);
        write(&path, "- [ ] Task\n", None).unwrap();
        assert!(write(&path, "overwrite", None).is_err());
        write(&path, "- [x] Task\n", Some("- [ ] Task\n")).unwrap();
        assert!(write(&path, "stale", Some("- [ ] Task\n")).is_err());
        assert_eq!(read(&path).unwrap().unwrap(), "- [x] Task\n");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_oversized_text_without_changing_file() {
        let root = crate::test_tmp().join(format!("herdr-size-{}", std::process::id()));
        let path = root.join("board.json");
        write(&path, "original", None).unwrap();
        assert!(write(&path, &"x".repeat(LIMIT as usize + 1), Some("original")).is_err());
        assert_eq!(read(&path).unwrap().as_deref(), Some("original"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_replacement_retains_owner_and_dacl() {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Security::{GetFileSecurityW, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION};
        fn security(path: &Path) -> Vec<u8> {
            let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            let requested = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
            let mut size = 0;
            unsafe { GetFileSecurityW(wide.as_ptr(), requested, std::ptr::null_mut(), 0, &mut size); }
            assert!(size > 0);
            let mut descriptor = vec![0; size as usize];
            assert_ne!(unsafe { GetFileSecurityW(wide.as_ptr(), requested, descriptor.as_mut_ptr().cast(), size, &mut size) }, 0);
            descriptor
        }
        let root = crate::test_tmp().join(format!("herdr-acl-{}", std::process::id()));
        let path = root.join("board");
        write(&path, "original", None).unwrap();
        let before = security(&path);
        write(&path, "replacement", Some("original")).unwrap();
        assert_eq!(security(&path), before);
        assert_eq!(read(&path).unwrap().as_deref(), Some("replacement"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_changed_symlink_before_publish_fails_closed() {
        use std::os::windows::fs::symlink_file;
        let root = crate::test_tmp().join(format!("herdr-win-link-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let first = root.join("first");
        let second = root.join("second");
        let alias = root.join("alias");
        std::fs::write(&first, "original").unwrap();
        std::fs::write(&second, "original").unwrap();
        if let Err(e) = symlink_file(&first, &alias) {
            if e.raw_os_error() == Some(1314) { std::fs::remove_dir_all(root).unwrap(); return; }
            panic!("cannot create test symlink: {e}");
        }
        let result = write_before_publish(&alias, "changed", Some("original"), || {
            std::fs::remove_file(&alias).unwrap();
            symlink_file(&second, &alias).unwrap();
        });
        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "original");
        assert_eq!(std::fs::read_to_string(&second).unwrap(), "original");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_replacement_failure_keeps_original_and_recovery() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
        let root = crate::test_tmp().join(format!("herdr-replace-fail-{}", std::process::id()));
        let path = root.join("board");
        write(&path, "original", None).unwrap();
        let handle = std::fs::OpenOptions::new().read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE).open(&path).unwrap();
        let error = write(&path, "replacement", Some("original")).unwrap_err();
        assert!(error.contains("recovery"));
        assert_eq!(read(&path).unwrap().as_deref(), Some("original"));
        assert!(std::fs::read_dir(&root).unwrap().filter_map(Result::ok)
            .any(|e| e.file_name().to_string_lossy().contains(".herdr-temp-")
                && std::fs::read_to_string(e.path()).ok().as_deref() == Some("replacement")));
        drop(handle);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lock_process_helper() {
        let Some(lock_path) = std::env::var_os("HERDR_TEST_LOCK_PATH") else { return };
        let ready = std::env::var_os("HERDR_TEST_LOCK_READY").unwrap();
        let done = std::env::var_os("HERDR_TEST_LOCK_DONE").unwrap();
        let lock = std::fs::OpenOptions::new().read(true).write(true).create(true).open(lock_path).unwrap();
        lock.lock().unwrap();
        std::fs::write(ready, "ready").unwrap();
        let start = std::time::Instant::now();
        while !Path::new(&done).exists() && start.elapsed() < std::time::Duration::from_secs(20) {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        lock.unlock().unwrap();
    }

    #[test]
    fn publish_process_helper() {
        let Some(path) = std::env::var_os("HERDR_TEST_PUBLISH_PATH") else { return };
        let result_path = std::env::var_os("HERDR_TEST_PUBLISH_RESULT").unwrap();
        let text = std::env::var("HERDR_TEST_PUBLISH_TEXT").unwrap();
        let result = write(Path::new(&path), &text, None);
        std::fs::write(result_path, if result.is_ok() { "ok" } else { "conflict" }).unwrap();
    }

    #[test]
    fn independent_first_publish_has_one_complete_winner() {
        let root = crate::test_tmp().join(format!("herdr-create-race-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let target = root.join("board");
        let results = [root.join("result-a"), root.join("result-b")];
        let mut children: Vec<_> = ["a", "b"].iter().enumerate().map(|(i, text)| {
            std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "mod_files::tests::publish_process_helper"])
                .env("HERDR_TEST_PUBLISH_PATH", &target)
                .env("HERDR_TEST_PUBLISH_RESULT", &results[i])
                .env("HERDR_TEST_PUBLISH_TEXT", text)
                .spawn().unwrap()
        }).collect();
        for child in &mut children { assert!(child.wait().unwrap().success()); }
        let a = std::fs::read_to_string(&results[0]).unwrap();
        let b = std::fs::read_to_string(&results[1]).unwrap();
        assert!(matches!((a.as_str(), b.as_str()), ("ok", "conflict") | ("conflict", "ok")));
        assert_eq!(std::fs::read_to_string(&target).unwrap(), if a == "ok" { "a" } else { "b" });
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn independent_process_lock_times_out_without_modifying_data() {
        let root = crate::test_tmp().join(format!("herdr-contention-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("board");
        write(&path, "original", None).unwrap();
        let mut lock_path = resolved_target(&path).unwrap().into_os_string();
        lock_path.push(".herdr-lock");
        let ready = root.join("ready");
        let done = root.join("done");
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "mod_files::tests::lock_process_helper", "--nocapture"])
            .env("HERDR_TEST_LOCK_PATH", lock_path).env("HERDR_TEST_LOCK_READY", &ready)
            .env("HERDR_TEST_LOCK_DONE", &done).spawn().unwrap();
        let start = std::time::Instant::now();
        while !ready.exists() && start.elapsed() < std::time::Duration::from_secs(10) {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(ready.exists(), "child failed to acquire lock");
        let start = std::time::Instant::now();
        let error = write(&path, "changed", Some("original")).unwrap_err();
        assert!(error.contains("Busy"));
        assert!(start.elapsed() >= std::time::Duration::from_secs(5));
        assert_eq!(read(&path).unwrap().as_deref(), Some("original"));
        std::fs::write(done, "done").unwrap();
        assert!(child.wait().unwrap().success());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn changed_alias_before_publish_is_rejected() {
        use std::os::unix::fs::symlink;
        let root = crate::test_tmp().join(format!("herdr-retarget-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let first = root.join("first");
        let second = root.join("second");
        let alias = root.join("alias");
        std::fs::write(&first, "original").unwrap();
        std::fs::write(&second, "original").unwrap();
        symlink(&first, &alias).unwrap();
        let result = write_before_publish(&alias, "changed", Some("original"), || {
            std::fs::remove_file(&alias).unwrap();
            symlink(&second, &alias).unwrap();
        });
        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "original");
        assert_eq!(std::fs::read_to_string(&second).unwrap(), "original");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn aliases_share_target_and_dangling_links_fail_closed() {
        use std::os::unix::fs::symlink;
        let root = crate::test_tmp().join(format!("herdr-links-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let target = root.join("board");
        let alias = root.join("alias");
        write(&target, "one", None).unwrap();
        symlink(&target, &alias).unwrap();
        write(&alias, "two", Some("one")).unwrap();
        assert_eq!(read(&target).unwrap().as_deref(), Some("two"));
        let dangling = root.join("dangling");
        symlink(root.join("missing"), &dangling).unwrap();
        assert!(write(&dangling, "bad", None).is_err());
        assert!(!root.join("missing").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
