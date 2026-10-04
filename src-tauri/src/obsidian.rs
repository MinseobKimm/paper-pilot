use super::{open_db, row_document, sha256_hex, AppResult, DocumentRecord};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const VAULT: &str = "obsidianVaultPath";
const FOLDER: &str = "obsidianFolder";
const ENABLED: &str = "obsidianEnabled";
const RETRY: Duration = Duration::from_secs(30);

pub struct ObsidianWorker(pub Sender<String>);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsidianStatus {
    pub state: String,
    pub error: String,
    pub relative_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsidianConfig {
    pub vault_path: String,
    pub folder: String,
    pub enabled: bool,
}

pub fn migrate(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS obsidian_links (
            document_id TEXT PRIMARY KEY,
            relative_path TEXT,
            managed_hash TEXT,
            state TEXT NOT NULL DEFAULT 'pending',
            generation INTEGER NOT NULL DEFAULT 0,
            error TEXT NOT NULL DEFAULT ''
        );",
    )
    .map_err(|error| error.to_string())?;
    for (key, value) in [(VAULT, ""), (FOLDER, "Paper Pilot"), (ENABLED, "false")] {
        conn.execute(
            "INSERT OR IGNORE INTO settings (key,value) VALUES (?1,?2)",
            params![key, value],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn setting(conn: &Connection, key: &str) -> AppResult<String> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

fn config(conn: &Connection) -> AppResult<ObsidianConfig> {
    Ok(ObsidianConfig {
        vault_path: setting(conn, VAULT)?,
        folder: setting(conn, FOLDER)?,
        enabled: setting(conn, ENABLED)? == "true",
    })
}

fn safe_relative(value: &str) -> AppResult<PathBuf> {
    let path = Path::new(value);
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("Obsidian 저장 폴더는 보관함 안의 상대 경로로 지정해 주세요.".into());
    }
    Ok(path.to_path_buf())
}

fn vault_root(value: &str) -> AppResult<PathBuf> {
    let root = Path::new(value)
        .canonicalize()
        .map_err(|error| format!("Obsidian 보관함을 열 수 없습니다: {error}"))?;
    if !root.join(".obsidian").is_dir() {
        return Err(".obsidian 폴더가 있는 보관함을 선택해 주세요.".into());
    }
    Ok(root)
}

fn destination(root: &Path, relative: &str) -> AppResult<PathBuf> {
    let relative = safe_relative(relative)?;
    let path = root.join(relative);
    let parent = path
        .parent()
        .ok_or("Obsidian 파일 경로가 올바르지 않습니다.")?;
    let canonical_parent = parent.canonicalize().map_err(|error| error.to_string())?;
    if !canonical_parent.starts_with(root)
        || path.extension().and_then(|value| value.to_str()) != Some("md")
    {
        return Err("Obsidian 보관함 밖의 파일에는 쓸 수 없습니다.".into());
    }
    Ok(path)
}

fn file_name(document: &DocumentRecord) -> String {
    let title: String = document
        .title
        .chars()
        .map(|ch| {
            if matches!(
                ch,
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\n' | '\r'
            ) {
                ' '
            } else {
                ch
            }
        })
        .take(90)
        .collect();
    let title = title.trim().trim_matches('.');
    let title = if title.is_empty() { "논문" } else { title };
    let short_id: String = document.id.chars().take(8).collect();
    format!("{title} - {short_id}.md")
}

fn managed_markers(id: &str) -> (String, String) {
    (
        format!("<!-- paper-pilot:start:{id} -->"),
        format!("<!-- paper-pilot:end:{id} -->"),
    )
}

fn managed_range(content: &str, id: &str) -> Option<(usize, usize)> {
    let (start, end) = managed_markers(id);
    let begin = content.find(&start)?;
    let finish = content[begin..].find(&end)? + begin + end.len();
    Some((begin, finish))
}

fn pdf_link(path: &str) -> String {
    // A file URI keeps spaces, Hangul and Markdown punctuation out of link syntax.
    tauri::Url::from_file_path(path)
        .map(|url| url.to_string())
        .unwrap_or_default()
}

fn managed_text(document: &DocumentRecord, markdown: &str) -> String {
    let (start, end) = managed_markers(&document.id);
    let source = document
        .source_path
        .as_deref()
        .unwrap_or(&document.file_path);
    format!("{start}\n# {}\n\n- 저자: {}\n- 연도: {}\n- 원본 PDF: [열기](<{}>)\n\n## Paper Pilot 노트\n\n{}\n{end}",
        document.title, document.authors, document.year, pdf_link(source), markdown)
}

fn initial_file(managed: &str) -> String {
    format!("{managed}\n\n<!-- paper-pilot:personal -->\n## Obsidian 메모\n\n")
}

fn atomic_replace(path: &Path, old: Option<&str>, next: &str) -> AppResult<bool> {
    let current = fs::read_to_string(path).ok();
    if current.as_deref() != old {
        return Ok(false);
    }
    let temp = path.with_extension(format!("paper-pilot-{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temp, next).map_err(|error| error.to_string())?;
    if fs::read_to_string(path).ok().as_deref() != old {
        let _ = fs::remove_file(&temp);
        return Ok(false);
    }
    if let Err(error) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(error.to_string());
    }
    Ok(true)
}

#[derive(Debug, PartialEq)]
enum WriteOutcome {
    Synced,
    Missing,
    Conflict,
    Foreign,
    Retry,
}

fn write_managed_file(
    path: &Path,
    id: &str,
    baseline: Option<&str>,
    desired: &str,
) -> AppResult<WriteOutcome> {
    let desired_hash = sha256_hex(desired.as_bytes());
    for _ in 0..3 {
        let existing = match fs::read_to_string(path) {
            Ok(content) => Some(content),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.to_string()),
        };
        if existing.is_none() && baseline.is_some() {
            return Ok(WriteOutcome::Missing);
        }
        let next = if let Some(ref content) = existing {
            let Some((begin, end)) = managed_range(content, id) else {
                return Ok(WriteOutcome::Foreign);
            };
            let actual_hash = sha256_hex(content[begin..end].as_bytes());
            if baseline.is_some_and(|hash| hash != actual_hash)
                || baseline.is_none() && actual_hash != desired_hash
            {
                return Ok(WriteOutcome::Conflict);
            }
            format!("{}{}{}", &content[..begin], desired, &content[end..])
        } else {
            initial_file(desired)
        };
        if existing.as_deref() == Some(next.as_str())
            || atomic_replace(path, existing.as_deref(), &next)?
        {
            return Ok(WriteOutcome::Synced);
        }
    }
    Ok(WriteOutcome::Retry)
}

fn set_state(
    conn: &Connection,
    id: &str,
    generation: i64,
    state: &str,
    error: &str,
    hash: Option<&str>,
) -> AppResult<()> {
    conn.execute(
        "UPDATE obsidian_links SET state=?3,error=?4,managed_hash=COALESCE(?5,managed_hash) WHERE document_id=?1 AND generation=?2",
        params![id,generation,state,error,hash],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

fn sync_one(app: &AppHandle, id: &str) -> AppResult<bool> {
    let conn = open_db(app)?;
    let cfg = config(&conn)?;
    if !cfg.enabled {
        return Ok(false);
    }
    let row: Option<(Option<String>,Option<String>,String,i64)> = conn.query_row(
        "SELECT relative_path,managed_hash,state,generation FROM obsidian_links WHERE document_id=?1",
        params![id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
    ).optional().map_err(|error| error.to_string())?;
    let Some((mut relative, baseline, state, generation)) = row else {
        return Ok(false);
    };
    if state != "pending" {
        return Ok(false);
    }
    let document = conn.query_row(
        "SELECT id,title,file_name,file_path,hash,page_count,authors,year,abstract_text,folder_id,bookmarked,created_at,updated_at,source_path FROM documents WHERE id=?1",
        params![id], row_document,
    ).optional().map_err(|error| error.to_string())?;
    let note: Option<String> = conn
        .query_row(
            "SELECT markdown FROM notes WHERE document_id=?1 ORDER BY updated_at DESC LIMIT 1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let (Some(document), Some(note)) = (document, note) else {
        set_state(&conn, id, generation, "disconnected", "", None)?;
        return Ok(false);
    };
    let root = match vault_root(&cfg.vault_path) {
        Ok(root) => root,
        Err(error) => {
            set_state(&conn, id, generation, "pending", &error, None)?;
            return Ok(true);
        }
    };
    let folder = safe_relative(&cfg.folder)?;
    let export_dir = root.join(folder);
    fs::create_dir_all(&export_dir).map_err(|error| error.to_string())?;
    if !export_dir
        .canonicalize()
        .map_err(|error| error.to_string())?
        .starts_with(&root)
    {
        set_state(
            &conn,
            id,
            generation,
            "attention",
            "저장 폴더가 보관함 밖을 가리킵니다.",
            None,
        )?;
        return Ok(false);
    }
    if relative.is_none() {
        let stem = file_name(&document);
        for number in 0..1000 {
            let name = if number == 0 {
                stem.clone()
            } else {
                stem.replace(".md", &format!("-{number}.md"))
            };
            let candidate = export_dir.join(name);
            if !candidate.exists() {
                let value = candidate
                    .strip_prefix(&root)
                    .map_err(|error| error.to_string())?
                    .to_string_lossy()
                    .into_owned();
                conn.execute("UPDATE obsidian_links SET relative_path=?2 WHERE document_id=?1 AND generation=?3", params![id,value,generation])
                    .map_err(|error| error.to_string())?;
                relative = Some(value);
                break;
            }
        }
    }
    let relative = relative.ok_or("Obsidian 파일 이름을 정할 수 없습니다.")?;
    if baseline.is_some() && !root.join(&relative).parent().is_some_and(Path::is_dir) {
        set_state(
            &conn,
            id,
            generation,
            "attention",
            "내보낸 파일의 폴더가 이동되거나 삭제되었습니다.",
            None,
        )?;
        return Ok(false);
    }
    let path = destination(&root, &relative)?;
    let desired = managed_text(&document, &note);
    let desired_hash = sha256_hex(desired.as_bytes());
    match write_managed_file(&path, id, baseline.as_deref(), &desired)? {
        WriteOutcome::Synced => {
            set_state(&conn, id, generation, "synced", "", Some(&desired_hash))?;
            Ok(false)
        }
        WriteOutcome::Missing => {
            set_state(
                &conn,
                id,
                generation,
                "attention",
                "내보낸 파일이 이동되거나 삭제되었습니다.",
                None,
            )?;
            Ok(false)
        }
        WriteOutcome::Foreign => {
            set_state(
                &conn,
                id,
                generation,
                "attention",
                "해당 경로에 Paper Pilot 형식이 아닌 파일이 있습니다.",
                None,
            )?;
            Ok(false)
        }
        WriteOutcome::Conflict => {
            set_state(
                &conn,
                id,
                generation,
                "conflict",
                "Obsidian에서 자동 관리 구역이 수정되었습니다.",
                None,
            )?;
            Ok(false)
        }
        WriteOutcome::Retry => {
            set_state(
                &conn,
                id,
                generation,
                "pending",
                "Obsidian 파일이 동시에 수정되어 다시 시도합니다.",
                None,
            )?;
            Ok(true)
        }
    }
}

pub fn start_worker(app: AppHandle) -> ObsidianWorker {
    let (sender, receiver) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut due = BTreeMap::<String, Instant>::new();
        if let Ok(conn) = open_db(&app) {
            if let Ok(mut stmt) =
                conn.prepare("SELECT document_id FROM obsidian_links WHERE state='pending'")
            {
                if let Ok(ids) = stmt.query_map([], |row| row.get::<_, String>(0)) {
                    for id in ids.flatten() {
                        due.insert(id, Instant::now());
                    }
                }
            }
        }
        loop {
            let wait = due
                .values()
                .min()
                .map(|at| at.saturating_duration_since(Instant::now()));
            let received = match wait {
                Some(duration) => receiver.recv_timeout(duration),
                None => receiver.recv().map_err(|_| RecvTimeoutError::Disconnected),
            };
            match received {
                Ok(id) => {
                    due.insert(id, Instant::now() + Duration::from_secs(1));
                }
                Err(RecvTimeoutError::Disconnected) => break,
                Err(RecvTimeoutError::Timeout) => {}
            }
            let ready: Vec<_> = due
                .iter()
                .filter(|(_, at)| **at <= Instant::now())
                .map(|(id, _)| id.clone())
                .collect();
            for id in ready {
                due.remove(&id);
                let retry = match sync_one(&app, &id) {
                    Ok(retry) => retry,
                    Err(error) => {
                        if let Ok(conn) = open_db(&app) {
                            let _ = conn.execute("UPDATE obsidian_links SET error=?2 WHERE document_id=?1 AND state='pending'",params![id,error]);
                        }
                        true
                    }
                };
                if retry {
                    due.insert(id, Instant::now() + RETRY);
                }
            }
        }
    });
    ObsidianWorker(sender)
}

pub fn queue(app: &AppHandle, conn: &Connection, id: &str) {
    if config(conn).is_ok_and(|cfg| cfg.enabled) {
        let has_note = conn
            .query_row(
                "SELECT 1 FROM notes WHERE document_id=?1 LIMIT 1",
                params![id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .ok()
            .flatten()
            .is_some();
        if !has_note {
            return;
        }
        let _ = conn.execute(
            "INSERT INTO obsidian_links(document_id,state,generation) VALUES(?1,'pending',1)
             ON CONFLICT(document_id) DO UPDATE SET
               state=CASE WHEN state IN ('conflict','attention','disconnected') THEN state ELSE 'pending' END,
               generation=generation+1",
            params![id],
        );
        let state: Option<String> = conn
            .query_row(
                "SELECT state FROM obsidian_links WHERE document_id=?1",
                params![id],
                |row| row.get(0),
            )
            .ok();
        if state.as_deref() == Some("pending") {
            if let Some(worker) = app.try_state::<ObsidianWorker>() {
                let _ = worker.0.send(id.to_string());
            }
        }
    }
}

#[tauri::command]
pub fn obsidian_status(app: AppHandle, document_id: String) -> AppResult<ObsidianStatus> {
    let conn = open_db(&app)?;
    if !config(&conn)?.enabled {
        return Ok(ObsidianStatus {
            state: "off".into(),
            error: String::new(),
            relative_path: None,
        });
    }
    Ok(conn
        .query_row(
            "SELECT state,error,relative_path FROM obsidian_links WHERE document_id=?1",
            params![document_id],
            |row| {
                Ok(ObsidianStatus {
                    state: row.get(0)?,
                    error: row.get(1)?,
                    relative_path: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or(ObsidianStatus {
            state: "none".into(),
            error: String::new(),
            relative_path: None,
        }))
}

#[tauri::command]
pub async fn obsidian_pick_vault(app: AppHandle) -> AppResult<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(selected) = app.dialog().file().blocking_pick_folder() else {
            return Ok(None);
        };
        let path = selected.into_path().map_err(|error| error.to_string())?;
        Ok(Some(
            vault_root(&path.to_string_lossy())?
                .to_string_lossy()
                .into_owned(),
        ))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn obsidian_configure(
    app: AppHandle,
    vault_path: String,
    folder: String,
    enabled: bool,
) -> AppResult<ObsidianConfig> {
    let folder = safe_relative(&folder)?.to_string_lossy().into_owned();
    let vault = if vault_path.is_empty() {
        String::new()
    } else {
        vault_root(&vault_path)?.to_string_lossy().into_owned()
    };
    if enabled && vault.is_empty() {
        return Err("Obsidian 보관함을 먼저 선택해 주세요.".into());
    }
    let mut conn = open_db(&app)?;
    let previous = config(&conn)?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    for (key, value) in [
        (VAULT, vault.as_str()),
        (FOLDER, folder.as_str()),
        (ENABLED, if enabled { "true" } else { "false" }),
    ] {
        tx.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value])
            .map_err(|error|error.to_string())?;
    }
    if previous.vault_path != vault || previous.folder != folder {
        tx.execute("UPDATE obsidian_links SET relative_path=NULL,managed_hash=NULL,state='pending',error='',generation=generation+1 WHERE state!='disconnected'",[])
            .map_err(|error|error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())?;
    let cfg = config(&conn)?;
    if cfg.enabled {
        queue_all(&app, &conn);
    }
    Ok(cfg)
}

fn queue_all(app: &AppHandle, conn: &Connection) -> usize {
    let ids: Vec<String> = conn
        .prepare("SELECT DISTINCT document_id FROM notes WHERE trim(markdown)!=''")
        .and_then(|mut stmt| {
            stmt.query_map([], |row| row.get::<_, String>(0))
                .and_then(|rows| rows.collect())
        })
        .unwrap_or_default();
    for id in &ids {
        queue(app, conn, id)
    }
    ids.len()
}

#[tauri::command]
pub fn obsidian_sync_now(app: AppHandle) -> AppResult<usize> {
    let conn = open_db(&app)?;
    if !config(&conn)?.enabled {
        return Err("Obsidian 연동을 켜 주세요.".into());
    }
    Ok(queue_all(&app, &conn))
}

#[tauri::command]
pub fn obsidian_resolve(app: AppHandle, document_id: String, action: String) -> AppResult<()> {
    let conn = open_db(&app)?;
    match action.as_str() {
        "disconnect" => {
            conn.execute(
                "UPDATE obsidian_links SET state='disconnected',error='' WHERE document_id=?1",
                params![document_id],
            )
            .map_err(|error| error.to_string())?;
        }
        "recreate" | "overwrite" => {
            if action == "overwrite" {
                let cfg = config(&conn)?;
                let root = vault_root(&cfg.vault_path)?;
                let relative: Option<String> = conn
                    .query_row(
                        "SELECT relative_path FROM obsidian_links WHERE document_id=?1",
                        params![document_id],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                if let Some(relative) = relative {
                    let path = destination(&root, &relative)?;
                    if path.exists() {
                        let backup = path.with_extension(format!(
                            "paper-pilot-backup-{}.md",
                            uuid::Uuid::new_v4()
                        ));
                        fs::copy(&path, backup).map_err(|error| error.to_string())?;
                        let content =
                            fs::read_to_string(&path).map_err(|error| error.to_string())?;
                        if let Some((begin, end)) = managed_range(&content, &document_id) {
                            let hash = sha256_hex(content[begin..end].as_bytes());
                            conn.execute(
                                "UPDATE obsidian_links SET managed_hash=?2 WHERE document_id=?1",
                                params![document_id, hash],
                            )
                            .map_err(|error| error.to_string())?;
                        } else {
                            fs::remove_file(&path).map_err(|error| error.to_string())?;
                            conn.execute(
                                "UPDATE obsidian_links SET managed_hash=NULL WHERE document_id=?1",
                                params![document_id],
                            )
                            .map_err(|error| error.to_string())?;
                        }
                    }
                }
            }
            if action == "recreate" {
                conn.execute("UPDATE obsidian_links SET relative_path=NULL,managed_hash=NULL,state='pending',error='',generation=generation+1 WHERE document_id=?1",params![document_id]).map_err(|error|error.to_string())?;
            } else {
                conn.execute("UPDATE obsidian_links SET state='pending',error='',generation=generation+1 WHERE document_id=?1",params![document_id]).map_err(|error|error.to_string())?;
            }
            if let Some(worker) = app.try_state::<ObsidianWorker>() {
                let _ = worker.0.send(document_id);
            }
        }
        _ => return Err("알 수 없는 Obsidian 복구 작업입니다.".into()),
    }
    Ok(())
}

#[tauri::command]
pub async fn obsidian_reconnect(app: AppHandle, document_id: String) -> AppResult<bool> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn=open_db(&app)?;
        let root=vault_root(&config(&conn)?.vault_path)?;
        let Some(selected)=app.dialog().file().add_filter("Markdown",&["md"]).blocking_pick_file() else {return Ok(false)};
        let path=selected.into_path().map_err(|error|error.to_string())?.canonicalize().map_err(|error|error.to_string())?;
        if !path.starts_with(&root) {return Err("보관함 안의 노트를 선택해 주세요.".into())}
        let content=fs::read_to_string(&path).map_err(|error|error.to_string())?;
        let (begin,end)=managed_range(&content,&document_id).ok_or("이 논문의 Paper Pilot 노트가 아닙니다.")?;
        let actual_hash=sha256_hex(content[begin..end].as_bytes());
        let baseline:Option<String>=conn.query_row("SELECT managed_hash FROM obsidian_links WHERE document_id=?1",params![document_id],|row|row.get(0)).map_err(|error|error.to_string())?;
        let state=if baseline.as_deref().is_some_and(|hash|hash!=actual_hash){"conflict"}else{"pending"};
        let relative=path.strip_prefix(&root).map_err(|error|error.to_string())?.to_string_lossy().into_owned();
        conn.execute("UPDATE obsidian_links SET relative_path=?2,state=?3,error='',generation=generation+1 WHERE document_id=?1",params![document_id,relative,state]).map_err(|error|error.to_string())?;
        if state=="pending" {if let Some(worker)=app.try_state::<ObsidianWorker>() {let _=worker.0.send(document_id);}}
        Ok(true)
    }).await.map_err(|error|error.to_string())?
}

#[tauri::command]
pub fn obsidian_open(app: AppHandle, document_id: String) -> AppResult<()> {
    let conn = open_db(&app)?;
    let root = vault_root(&config(&conn)?.vault_path)?;
    let relative: String = conn
        .query_row(
            "SELECT relative_path FROM obsidian_links WHERE document_id=?1",
            params![document_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let path = root.join(safe_relative(&relative)?);
    if !path.is_file() {
        conn.execute("UPDATE obsidian_links SET state='attention',error='내보낸 파일이 이동되거나 삭제되었습니다.' WHERE document_id=?1",params![document_id]).map_err(|error|error.to_string())?;
        return Err("Obsidian 노트 파일을 찾을 수 없습니다.".into());
    }
    let path = destination(&root, &relative)?;
    let mut url = tauri::Url::parse("obsidian://open").map_err(|error| error.to_string())?;
    url.query_pairs_mut()
        .append_pair("path", &path.to_string_lossy());
    app.opener()
        .open_url(url.to_string(), None::<&str>)
        .map_err(|error| error.to_string())
}

pub fn unlink(conn: &Connection, id: &str) {
    let _ = conn.execute(
        "UPDATE obsidian_links SET state='disconnected',error='' WHERE document_id=?1",
        params![id],
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn managed_region_preserves_personal_text_and_unicode() {
        let document = DocumentRecord {
            id: "12345678-a".into(),
            title: "한글 논문".into(),
            file_name: "a.pdf".into(),
            file_path: "/tmp/논문 a.pdf".into(),
            source_path: Some("/tmp/논문 a.pdf".into()),
            hash: "h".into(),
            page_count: 1,
            authors: "김".into(),
            year: "2026".into(),
            abstract_text: String::new(),
            folder_id: None,
            bookmarked: false,
            created_at: String::new(),
            updated_at: String::new(),
        };
        let old = initial_file(&managed_text(&document, "  들여쓰기\n$$x^2$$"));
        let personal = "나의 [[생각]] #태그";
        let old = format!("{old}{personal}");
        let (begin, end) = managed_range(&old, &document.id).unwrap();
        let new = format!(
            "{}{}{}",
            &old[..begin],
            managed_text(&document, "수정"),
            &old[end..]
        );
        assert!(new.contains(personal));
        assert!(new.contains("## Paper Pilot 노트\n\n수정"));
        assert!(old.contains("  들여쓰기\n$$x^2$$"));
    }
    #[test]
    fn rejects_paths_outside_vault() {
        assert!(safe_relative("../outside").is_err());
        assert!(safe_relative("/absolute").is_err());
        assert!(safe_relative("Paper Pilot").is_ok());
    }
    #[test]
    fn sync_preserves_personal_section_and_stops_on_conflict_or_missing_file() {
        let root =
            std::env::temp_dir().join(format!("paper-pilot-obsidian-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("한글 논문.md");
        let id = "document-123";
        let first = format!("{}\n처음\n{}", managed_markers(id).0, managed_markers(id).1);
        assert_eq!(
            write_managed_file(&path, id, None, &first).unwrap(),
            WriteOutcome::Synced
        );
        let baseline = sha256_hex(first.as_bytes());
        let mut content = fs::read_to_string(&path).unwrap();
        content.push_str("내 [[추가 메모]] #태그\n");
        fs::write(&path, &content).unwrap();
        let second = format!(
            "{}\n  $x^2$\n{}",
            managed_markers(id).0,
            managed_markers(id).1
        );
        assert_eq!(
            write_managed_file(&path, id, Some(&baseline), &second).unwrap(),
            WriteOutcome::Synced
        );
        let synced = fs::read_to_string(&path).unwrap();
        assert!(synced.contains("내 [[추가 메모]] #태그"));
        assert!(synced.contains("  $x^2$"));
        let new_baseline = sha256_hex(second.as_bytes());
        fs::write(&path, synced.replace("$x^2$", "$y^2$")).unwrap();
        assert_eq!(
            write_managed_file(&path, id, Some(&new_baseline), &first).unwrap(),
            WriteOutcome::Conflict
        );
        assert!(fs::read_to_string(&path).unwrap().contains("$y^2$"));
        fs::remove_file(&path).unwrap();
        assert_eq!(
            write_managed_file(&path, id, Some(&new_baseline), &first).unwrap(),
            WriteOutcome::Missing
        );
        fs::remove_dir_all(root).unwrap();
    }
}
