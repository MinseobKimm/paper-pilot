use base64::{engine::general_purpose, Engine as _};
use chrono::Utc;
use encoding_rs::EUC_KR;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::env;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Cursor, Read, Write};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Manager};
use uuid::Uuid;
use zip::write::SimpleFileOptions;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

type AppResult<T> = Result<T, String>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderRecord {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRecord {
    pub id: String,
    pub title: String,
    pub file_name: String,
    pub file_path: String,
    pub hash: String,
    pub page_count: i64,
    pub authors: String,
    pub year: String,
    pub abstract_text: String,
    pub folder_id: Option<String>,
    pub bookmarked: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRecord {
    pub document_id: String,
    pub page_number: i64,
    pub text: String,
    pub outline_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationRecord {
    pub id: String,
    pub document_id: String,
    pub page: i64,
    pub kind: String,
    pub color: String,
    pub text: String,
    pub range_hint: String,
    #[serde(default)]
    pub rects: Vec<HighlightRect>,
    pub comment: String,
    pub tag: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HighlightRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub basis_width: Option<f64>,
    #[serde(default)]
    pub basis_height: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentRecord {
    pub id: String,
    pub annotation_id: String,
    pub document_id: String,
    pub page: i64,
    pub text: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRecord {
    pub id: String,
    pub document_id: String,
    pub markdown: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiResultRecord {
    pub id: String,
    pub document_id: String,
    pub task_type: String,
    pub input_text: String,
    pub output_text: String,
    pub status: String,
    pub created_at: String,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub provider_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CitationCardRecord {
    pub id: String,
    pub document_id: String,
    pub raw_reference: String,
    pub title: String,
    pub authors: String,
    pub year: String,
    pub doi: String,
    pub url: String,
    pub reason: String,
    pub bibtex: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendationRunRecord {
    pub id: String,
    pub folder_id: String,
    pub query: String,
    pub result_json: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStateRecord {
    pub folders: Vec<FolderRecord>,
    pub documents: Vec<DocumentRecord>,
    pub pages: Vec<PageRecord>,
    pub annotations: Vec<AnnotationRecord>,
    pub comments: Vec<CommentRecord>,
    pub notes: Vec<NoteRecord>,
    pub ai_results: Vec<AiResultRecord>,
    pub citation_cards: Vec<CitationCardRecord>,
    pub recommendation_runs: Vec<RecommendationRunRecord>,
    pub settings: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeTask {
    pub id: String,
    pub task_type: String,
    pub document_id: String,
    #[serde(default = "default_agent_provider")]
    pub provider: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub provider_session_id: Option<String>,
    pub payload: Value,
    pub created_at: String,
    pub bridge_dir: String,
    pub file_path: String,
}

fn default_agent_provider() -> String {
    "codex-cli".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeResult {
    pub id: String,
    pub task_type: String,
    pub status: String,
    pub output: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeWorkerRun {
    pub started: bool,
    pub task_id: String,
    pub pid: Option<u32>,
    pub command: String,
    pub log_path: String,
    pub error_log_path: String,
    pub final_log_path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetWorkspaceResult {
    pub state: AppStateRecord,
    pub deleted_paths: Vec<String>,
    pub skipped_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportBundle {
    pub document: DocumentRecord,
    pub pages: Vec<PageRecord>,
    pub annotations: Vec<AnnotationRecord>,
    pub comments: Vec<CommentRecord>,
    pub notes: Vec<NoteRecord>,
    pub ai_results: Vec<AiResultRecord>,
    pub citation_cards: Vec<CitationCardRecord>,
    pub exported_at: String,
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn decode_process_bytes(bytes: &[u8]) -> String {
    match String::from_utf8(bytes.to_vec()) {
        Ok(text) => text,
        Err(_) => {
            let (text, _, _) = EUC_KR.decode(bytes);
            text.into_owned()
        }
    }
}

const LEGACY_LONG_COMMAND_MOJIBAKE: &str =
    "\u{fffd}\u{fffd}\u{fffd}\u{fffd}\u{fffd}\u{fffd}\u{fffd}\u{fffd} \u{fffd}\u{02b9}\u{fffd} \u{fffd}\u{fffd}\u{03f4}\u{fffd}.";

fn repair_legacy_mojibake(text: String) -> String {
    if text.trim() == LEGACY_LONG_COMMAND_MOJIBAKE {
        "명령줄이 너무 깁니다. 다시 실행하면 긴 프롬프트를 stdin으로 전달해 처리합니다.".to_string()
    } else {
        text
    }
}

fn app_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve app data directory: {error}"))?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn db_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app_dir(app)?.join("paperdock.sqlite3"))
}

fn open_db(app: &AppHandle) -> AppResult<Connection> {
    let conn = Connection::open(db_path(app)?).map_err(|error| error.to_string())?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS folders (
            id TEXT PRIMARY KEY,
            parent_id TEXT,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            file_name TEXT NOT NULL,
            file_path TEXT NOT NULL,
            hash TEXT NOT NULL,
            page_count INTEGER NOT NULL DEFAULT 0,
            authors TEXT NOT NULL DEFAULT '',
            year TEXT NOT NULL DEFAULT '',
            abstract_text TEXT NOT NULL DEFAULT '',
            folder_id TEXT,
            bookmarked INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pages (
            document_id TEXT NOT NULL,
            page_number INTEGER NOT NULL,
            text TEXT NOT NULL,
            outline_label TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (document_id, page_number)
        );

        CREATE TABLE IF NOT EXISTS annotations (
            id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL,
            page INTEGER NOT NULL,
            kind TEXT NOT NULL,
            color TEXT NOT NULL,
            text TEXT NOT NULL,
            range_hint TEXT NOT NULL DEFAULT '',
            rect_json TEXT NOT NULL DEFAULT '[]',
            comment TEXT NOT NULL DEFAULT '',
            tag TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS comments (
            id TEXT PRIMARY KEY,
            annotation_id TEXT NOT NULL,
            document_id TEXT NOT NULL,
            page INTEGER NOT NULL,
            text TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL,
            markdown TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ai_results (
            id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL,
            task_type TEXT NOT NULL,
            input_text TEXT NOT NULL,
            output_text TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            provider TEXT,
            model TEXT,
            provider_session_id TEXT
        );

        CREATE TABLE IF NOT EXISTS citation_cards (
            id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL,
            raw_reference TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            authors TEXT NOT NULL DEFAULT '',
            year TEXT NOT NULL DEFAULT '',
            doi TEXT NOT NULL DEFAULT '',
            url TEXT NOT NULL DEFAULT '',
            reason TEXT NOT NULL DEFAULT '',
            bibtex TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS recommendation_runs (
            id TEXT PRIMARY KEY,
            folder_id TEXT NOT NULL,
            query TEXT NOT NULL,
            result_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        ",
    )
    .map_err(|error| error.to_string())?;

    let _ = conn.execute(
        "ALTER TABLE annotations ADD COLUMN rect_json TEXT NOT NULL DEFAULT '[]'",
        [],
    );
    let _ = conn.execute("ALTER TABLE ai_results ADD COLUMN provider TEXT", []);
    let _ = conn.execute("ALTER TABLE ai_results ADD COLUMN model TEXT", []);
    let _ = conn.execute(
        "ALTER TABLE ai_results ADD COLUMN provider_session_id TEXT",
        [],
    );

    conn.execute(
        "INSERT OR IGNORE INTO folders (id, parent_id, name, created_at) VALUES ('root', NULL, 'Library', ?1)",
        params![now()],
    )
    .map_err(|error| error.to_string())?;

    let defaults = [
        ("language", "en"),
        ("theme", "light"),
        ("fontScale", "1"),
        ("mathDelimiter", "$$"),
        ("autoTranslate", "true"),
        ("autoTranslateAutostartMigrated", "true"),
        ("autoHighlight", "false"),
        ("aiProvider", "codex-cli"),
        ("aiModel", ""),
        ("codexModel", ""),
        ("codexReasoningEffort", ""),
        ("claudeModel", ""),
        ("bridgePath", "bridge"),
        ("customPrompt", ""),
        ("wordMeaningLookupEnabled", "true"),
    ];
    for (key, value) in defaults {
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)",
            params![key, value],
        )
        .map_err(|error| error.to_string())?;
    }
    conn.execute(
        "UPDATE settings SET value = 'codex-cli' WHERE key = 'aiProvider' AND value = 'chatgpt-web-bridge'",
        [],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        "UPDATE settings SET value = 'local-draft' WHERE key = 'aiProvider' AND value = 'api-provider'",
        [],
    )
    .map_err(|error| error.to_string())?;

    Ok(())
}

fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.trim_matches('_').is_empty() {
        "document.pdf".to_string()
    } else {
        cleaned
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn row_folder(row: &Row<'_>) -> rusqlite::Result<FolderRecord> {
    Ok(FolderRecord {
        id: row.get(0)?,
        parent_id: row.get(1)?,
        name: row.get(2)?,
        created_at: row.get(3)?,
    })
}

fn row_document(row: &Row<'_>) -> rusqlite::Result<DocumentRecord> {
    let bookmarked: i64 = row.get(10)?;
    Ok(DocumentRecord {
        id: row.get(0)?,
        title: row.get(1)?,
        file_name: row.get(2)?,
        file_path: row.get(3)?,
        hash: row.get(4)?,
        page_count: row.get(5)?,
        authors: row.get(6)?,
        year: row.get(7)?,
        abstract_text: row.get(8)?,
        folder_id: row.get(9)?,
        bookmarked: bookmarked != 0,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn row_page(row: &Row<'_>) -> rusqlite::Result<PageRecord> {
    Ok(PageRecord {
        document_id: row.get(0)?,
        page_number: row.get(1)?,
        text: row.get(2)?,
        outline_label: row.get(3)?,
    })
}

fn row_annotation(row: &Row<'_>) -> rusqlite::Result<AnnotationRecord> {
    let rect_json: String = row.get(7)?;
    let rects = serde_json::from_str::<Vec<HighlightRect>>(&rect_json).unwrap_or_default();
    Ok(AnnotationRecord {
        id: row.get(0)?,
        document_id: row.get(1)?,
        page: row.get(2)?,
        kind: row.get(3)?,
        color: row.get(4)?,
        text: row.get(5)?,
        range_hint: row.get(6)?,
        rects,
        comment: row.get(8)?,
        tag: row.get(9)?,
        created_at: row.get(10)?,
    })
}

fn row_comment(row: &Row<'_>) -> rusqlite::Result<CommentRecord> {
    Ok(CommentRecord {
        id: row.get(0)?,
        annotation_id: row.get(1)?,
        document_id: row.get(2)?,
        page: row.get(3)?,
        text: row.get(4)?,
        created_at: row.get(5)?,
    })
}

fn row_note(row: &Row<'_>) -> rusqlite::Result<NoteRecord> {
    Ok(NoteRecord {
        id: row.get(0)?,
        document_id: row.get(1)?,
        markdown: row.get(2)?,
        updated_at: row.get(3)?,
    })
}

fn row_ai_result(row: &Row<'_>) -> rusqlite::Result<AiResultRecord> {
    Ok(AiResultRecord {
        id: row.get(0)?,
        document_id: row.get(1)?,
        task_type: row.get(2)?,
        input_text: row.get(3)?,
        output_text: repair_legacy_mojibake(row.get(4)?),
        status: row.get(5)?,
        created_at: row.get(6)?,
        provider: row.get(7)?,
        model: row.get(8)?,
        reasoning_effort: None,
        provider_session_id: row.get(9)?,
    })
}

fn row_citation_card(row: &Row<'_>) -> rusqlite::Result<CitationCardRecord> {
    Ok(CitationCardRecord {
        id: row.get(0)?,
        document_id: row.get(1)?,
        raw_reference: row.get(2)?,
        title: row.get(3)?,
        authors: row.get(4)?,
        year: row.get(5)?,
        doi: row.get(6)?,
        url: row.get(7)?,
        reason: row.get(8)?,
        bibtex: row.get(9)?,
        created_at: row.get(10)?,
    })
}

fn row_recommendation_run(row: &Row<'_>) -> rusqlite::Result<RecommendationRunRecord> {
    Ok(RecommendationRunRecord {
        id: row.get(0)?,
        folder_id: row.get(1)?,
        query: row.get(2)?,
        result_json: row.get(3)?,
        created_at: row.get(4)?,
    })
}

fn collect_query<T, F>(conn: &Connection, sql: &str, mapper: F) -> AppResult<Vec<T>>
where
    F: FnMut(&Row<'_>) -> rusqlite::Result<T>,
{
    let mut stmt = conn.prepare(sql).map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], mapper)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

fn load_state_from_db(conn: &Connection) -> AppResult<AppStateRecord> {
    let folders = collect_query(
        conn,
        "SELECT id, parent_id, name, created_at FROM folders ORDER BY created_at ASC",
        row_folder,
    )?;
    let documents = collect_query(
        conn,
        "SELECT id, title, file_name, file_path, hash, page_count, authors, year, abstract_text, folder_id, bookmarked, created_at, updated_at FROM documents ORDER BY updated_at DESC",
        row_document,
    )?;
    let pages = collect_query(
        conn,
        "SELECT document_id, page_number, text, outline_label FROM pages ORDER BY document_id, page_number",
        row_page,
    )?;
    let annotations = collect_query(
        conn,
        "SELECT id, document_id, page, kind, color, text, range_hint, rect_json, comment, tag, created_at FROM annotations ORDER BY created_at DESC",
        row_annotation,
    )?;
    let comments = collect_query(
        conn,
        "SELECT id, annotation_id, document_id, page, text, created_at FROM comments ORDER BY created_at DESC",
        row_comment,
    )?;
    let notes = collect_query(
        conn,
        "SELECT id, document_id, markdown, updated_at FROM notes ORDER BY updated_at DESC",
        row_note,
    )?;
    let ai_results = collect_query(
        conn,
        "SELECT id, document_id, task_type, input_text, output_text, status, created_at, provider, model, provider_session_id FROM ai_results ORDER BY created_at DESC",
        row_ai_result,
    )?;
    let citation_cards = collect_query(
        conn,
        "SELECT id, document_id, raw_reference, title, authors, year, doi, url, reason, bibtex, created_at FROM citation_cards ORDER BY created_at DESC",
        row_citation_card,
    )?;
    let recommendation_runs = collect_query(
        conn,
        "SELECT id, folder_id, query, result_json, created_at FROM recommendation_runs ORDER BY created_at DESC",
        row_recommendation_run,
    )?;

    let mut stmt = conn
        .prepare("SELECT key, value FROM settings ORDER BY key")
        .map_err(|error| error.to_string())?;
    let settings = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<BTreeMap<_, _>, _>>()
        .map_err(|error| error.to_string())?;

    Ok(AppStateRecord {
        folders,
        documents,
        pages,
        annotations,
        comments,
        notes,
        ai_results,
        citation_cards,
        recommendation_runs,
        settings,
    })
}

fn export_bundle(conn: &Connection, document_id: &str) -> AppResult<ExportBundle> {
    let document = conn
        .query_row(
            "SELECT id, title, file_name, file_path, hash, page_count, authors, year, abstract_text, folder_id, bookmarked, created_at, updated_at FROM documents WHERE id = ?1",
            params![&document_id],
            row_document,
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Document not found".to_string())?;

    let pages = {
        let mut stmt = conn
            .prepare(
                "SELECT document_id, page_number, text, outline_label FROM pages WHERE document_id = ?1 ORDER BY page_number",
            )
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map(params![document_id], row_page)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    let annotations = {
        let mut stmt = conn
            .prepare("SELECT id, document_id, page, kind, color, text, range_hint, rect_json, comment, tag, created_at FROM annotations WHERE document_id = ?1 ORDER BY created_at DESC")
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map(params![document_id], row_annotation)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    let comments = {
        let mut stmt = conn
            .prepare("SELECT id, annotation_id, document_id, page, text, created_at FROM comments WHERE document_id = ?1 ORDER BY created_at DESC")
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map(params![document_id], row_comment)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    let notes = {
        let mut stmt = conn
            .prepare("SELECT id, document_id, markdown, updated_at FROM notes WHERE document_id = ?1 ORDER BY updated_at DESC")
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map(params![document_id], row_note)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    let ai_results = {
        let mut stmt = conn
            .prepare("SELECT id, document_id, task_type, input_text, output_text, status, created_at, provider, model, provider_session_id FROM ai_results WHERE document_id = ?1 ORDER BY created_at DESC")
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map(params![document_id], row_ai_result)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    let citation_cards = {
        let mut stmt = conn
            .prepare("SELECT id, document_id, raw_reference, title, authors, year, doi, url, reason, bibtex, created_at FROM citation_cards WHERE document_id = ?1 ORDER BY created_at DESC")
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map(params![document_id], row_citation_card)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };

    Ok(ExportBundle {
        document,
        pages,
        annotations,
        comments,
        notes,
        ai_results,
        citation_cards,
        exported_at: now(),
    })
}

#[tauri::command]
fn load_app_state(app: AppHandle) -> AppResult<AppStateRecord> {
    let conn = open_db(&app)?;
    load_state_from_db(&conn)
}

fn path_within(path: &Path, root: &Path) -> bool {
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    path.starts_with(root)
}

fn clear_directory(path: &Path) -> AppResult<()> {
    if !path.exists() {
        fs::create_dir_all(path).map_err(|error| error.to_string())?;
        return Ok(());
    }
    for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let entry_path = entry.path();
        if entry_path.is_dir() {
            fs::remove_dir_all(&entry_path).map_err(|error| error.to_string())?;
        } else {
            fs::remove_file(&entry_path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn reset_workspace_files(app: AppHandle, bridge_dir: String) -> AppResult<ResetWorkspaceResult> {
    let app_data = app_dir(&app)?;
    let root = project_root(&app);
    let mut deleted_paths = Vec::new();
    let mut skipped_paths = Vec::new();

    {
        let mut conn = open_db(&app)?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        for table in [
            "comments",
            "annotations",
            "pages",
            "notes",
            "ai_results",
            "citation_cards",
            "recommendation_runs",
            "documents",
        ] {
            tx.execute(&format!("DELETE FROM {table}"), [])
                .map_err(|error| error.to_string())?;
        }
        tx.execute("DELETE FROM folders WHERE id <> 'root'", [])
            .map_err(|error| error.to_string())?;
        tx.execute(
            "INSERT OR REPLACE INTO folders (id, parent_id, name, created_at) VALUES ('root', NULL, 'Library', ?1)",
            params![now()],
        )
        .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
    }

    let documents_dir = app_data.join("documents");
    if path_within(&documents_dir, &app_data) {
        clear_directory(&documents_dir)?;
        deleted_paths.push(documents_dir.to_string_lossy().to_string());
    } else {
        skipped_paths.push(documents_dir.to_string_lossy().to_string());
    }

    let bridge_path = bridge_base(&app, &bridge_dir)?;
    if path_within(&bridge_path, &root) || path_within(&bridge_path, &app_data) {
        clear_directory(&bridge_path)?;
        fs::create_dir_all(bridge_path.join("outbox")).map_err(|error| error.to_string())?;
        fs::create_dir_all(bridge_path.join("inbox")).map_err(|error| error.to_string())?;
        fs::create_dir_all(bridge_path.join("processed")).map_err(|error| error.to_string())?;
        fs::create_dir_all(bridge_path.join("logs")).map_err(|error| error.to_string())?;
        deleted_paths.push(bridge_path.to_string_lossy().to_string());
    } else {
        skipped_paths.push(bridge_path.to_string_lossy().to_string());
    }

    let conn = open_db(&app)?;
    Ok(ResetWorkspaceResult {
        state: load_state_from_db(&conn)?,
        deleted_paths,
        skipped_paths,
    })
}

#[tauri::command]
fn import_pdf(app: AppHandle, name: String, bytes: Vec<u8>) -> AppResult<DocumentRecord> {
    let conn = open_db(&app)?;
    let hash = sha256_hex(&bytes);
    let existing = conn
        .query_row(
            "SELECT id, title, file_name, file_path, hash, page_count, authors, year, abstract_text, folder_id, bookmarked, created_at, updated_at FROM documents WHERE hash = ?1",
            params![hash],
            row_document,
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(document) = existing {
        return Ok(document);
    }

    let id = Uuid::new_v4().to_string();
    let safe_name = sanitize_file_name(&name);
    let docs_dir = app_dir(&app)?.join("documents");
    fs::create_dir_all(&docs_dir).map_err(|error| error.to_string())?;
    let file_path = docs_dir.join(format!("{id}-{safe_name}"));
    fs::write(&file_path, bytes).map_err(|error| error.to_string())?;
    let timestamp = now();
    let title = safe_name.trim_end_matches(".pdf").replace('_', " ");

    let document = DocumentRecord {
        id,
        title,
        file_name: safe_name,
        file_path: file_path.to_string_lossy().to_string(),
        hash,
        page_count: 0,
        authors: String::new(),
        year: String::new(),
        abstract_text: String::new(),
        folder_id: Some("root".to_string()),
        bookmarked: false,
        created_at: timestamp.clone(),
        updated_at: timestamp,
    };

    conn.execute(
        "INSERT INTO documents (id, title, file_name, file_path, hash, page_count, authors, year, abstract_text, folder_id, bookmarked, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            document.id,
            document.title,
            document.file_name,
            document.file_path,
            document.hash,
            document.page_count,
            document.authors,
            document.year,
            document.abstract_text,
            document.folder_id,
            if document.bookmarked { 1 } else { 0 },
            document.created_at,
            document.updated_at
        ],
    )
    .map_err(|error| error.to_string())?;

    Ok(document)
}

#[tauri::command]
fn read_document_bytes(app: AppHandle, document_id: String) -> AppResult<Vec<u8>> {
    let conn = open_db(&app)?;
    let path: String = conn
        .query_row(
            "SELECT file_path FROM documents WHERE id = ?1",
            params![&document_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    fs::read(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn ensure_document_markdown(
    app: AppHandle,
    bridge_dir: String,
    document_id: String,
) -> AppResult<Option<DocumentMarkdownResult>> {
    let conn = open_db(&app)?;
    let document = conn
        .query_row(
            "SELECT id, title, file_name, file_path, hash, page_count, authors, year, abstract_text, folder_id, bookmarked, created_at, updated_at FROM documents WHERE id = ?1",
            params![&document_id],
            row_document,
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Document not found: {document_id}"))?;
    let base = bridge_base(&app, &bridge_dir)?;
    let root = project_root(&app);
    let attachment = prepare_pdf_markdown_attachment(
        &base,
        &root,
        &document.id,
        &document.id,
        Path::new(&document.file_path),
    )?;
    Ok(attachment.map(|attachment| document_markdown_result(&document.id, attachment)))
}

#[tauri::command]
fn update_document(app: AppHandle, document: DocumentRecord) -> AppResult<DocumentRecord> {
    let conn = open_db(&app)?;
    let mut updated = document;
    updated.updated_at = now();
    conn.execute(
        "UPDATE documents SET title = ?2, file_name = ?3, file_path = ?4, hash = ?5, page_count = ?6, authors = ?7, year = ?8, abstract_text = ?9, folder_id = ?10, bookmarked = ?11, updated_at = ?13 WHERE id = ?1",
        params![
            updated.id,
            updated.title,
            updated.file_name,
            updated.file_path,
            updated.hash,
            updated.page_count,
            updated.authors,
            updated.year,
            updated.abstract_text,
            updated.folder_id,
            if updated.bookmarked { 1 } else { 0 },
            updated.created_at,
            updated.updated_at
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(updated)
}

#[tauri::command]
fn delete_document(app: AppHandle, document_id: String) -> AppResult<()> {
    let mut conn = open_db(&app)?;
    let file_path: Option<String> = conn
        .query_row(
            "SELECT file_path FROM documents WHERE id = ?1",
            params![document_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;

    let tx = conn.transaction().map_err(|error| error.to_string())?;
    for table in [
        "comments",
        "annotations",
        "pages",
        "notes",
        "ai_results",
        "citation_cards",
    ] {
        tx.execute(
            &format!("DELETE FROM {table} WHERE document_id = ?1"),
            params![document_id],
        )
        .map_err(|error| error.to_string())?;
    }
    tx.execute("DELETE FROM documents WHERE id = ?1", params![&document_id])
        .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;

    if let Some(path) = file_path {
        let docs_dir = app_dir(&app)?.join("documents");
        let path = PathBuf::from(path);
        if path_within(&path, &docs_dir) && path.exists() {
            fs::remove_file(path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn save_pages(app: AppHandle, document_id: String, pages: Vec<PageRecord>) -> AppResult<()> {
    let conn = open_db(&app)?;
    conn.execute(
        "DELETE FROM pages WHERE document_id = ?1",
        params![document_id],
    )
    .map_err(|error| error.to_string())?;
    for page in pages {
        conn.execute(
            "INSERT INTO pages (document_id, page_number, text, outline_label) VALUES (?1, ?2, ?3, ?4)",
            params![page.document_id, page.page_number, page.text, page.outline_label],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn upsert_folder(app: AppHandle, folder: FolderRecord) -> AppResult<FolderRecord> {
    let conn = open_db(&app)?;
    conn.execute(
        "INSERT INTO folders (id, parent_id, name, created_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, name = excluded.name",
        params![folder.id, folder.parent_id, folder.name, folder.created_at],
    )
    .map_err(|error| error.to_string())?;
    Ok(folder)
}

#[tauri::command]
fn delete_folders(app: AppHandle, ids: Vec<String>, reassign_folder_id: String) -> AppResult<()> {
    let mut conn = open_db(&app)?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let timestamp = now();
    for id in ids.iter().filter(|id| id.as_str() != "root") {
        tx.execute(
            "UPDATE documents SET folder_id = ?1, updated_at = ?2 WHERE folder_id = ?3",
            params![reassign_folder_id, timestamp, id],
        )
        .map_err(|error| error.to_string())?;
        tx.execute("DELETE FROM folders WHERE id = ?1", params![id])
            .map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn upsert_annotation(app: AppHandle, annotation: AnnotationRecord) -> AppResult<AnnotationRecord> {
    let conn = open_db(&app)?;
    let rect_json = serde_json::to_string(&annotation.rects).map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO annotations (id, document_id, page, kind, color, text, range_hint, rect_json, comment, tag, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET page = excluded.page, kind = excluded.kind, color = excluded.color, text = excluded.text, range_hint = excluded.range_hint, rect_json = excluded.rect_json, comment = excluded.comment, tag = excluded.tag",
        params![
            annotation.id,
            annotation.document_id,
            annotation.page,
            annotation.kind,
            annotation.color,
            annotation.text,
            annotation.range_hint,
            rect_json,
            annotation.comment,
            annotation.tag,
            annotation.created_at
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(annotation)
}

#[tauri::command]
fn delete_annotation(app: AppHandle, id: String) -> AppResult<()> {
    let conn = open_db(&app)?;
    conn.execute("DELETE FROM comments WHERE annotation_id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    conn.execute("DELETE FROM annotations WHERE id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn upsert_comment(app: AppHandle, comment: CommentRecord) -> AppResult<CommentRecord> {
    let conn = open_db(&app)?;
    conn.execute(
        "INSERT INTO comments (id, annotation_id, document_id, page, text, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET annotation_id = excluded.annotation_id, document_id = excluded.document_id, page = excluded.page, text = excluded.text",
        params![
            comment.id,
            comment.annotation_id,
            comment.document_id,
            comment.page,
            comment.text,
            comment.created_at
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(comment)
}

#[tauri::command]
fn upsert_note(app: AppHandle, note: NoteRecord) -> AppResult<NoteRecord> {
    let conn = open_db(&app)?;
    conn.execute(
        "INSERT INTO notes (id, document_id, markdown, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET markdown = excluded.markdown, updated_at = excluded.updated_at",
        params![note.id, note.document_id, note.markdown, note.updated_at],
    )
    .map_err(|error| error.to_string())?;
    Ok(note)
}

#[tauri::command]
fn delete_note(app: AppHandle, id: String) -> AppResult<()> {
    let conn = open_db(&app)?;
    conn.execute("DELETE FROM notes WHERE id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn upsert_citation_card(
    app: AppHandle,
    citation: CitationCardRecord,
) -> AppResult<CitationCardRecord> {
    let conn = open_db(&app)?;
    conn.execute(
        "INSERT INTO citation_cards (id, document_id, raw_reference, title, authors, year, doi, url, reason, bibtex, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET raw_reference = excluded.raw_reference, title = excluded.title, authors = excluded.authors, year = excluded.year, doi = excluded.doi, url = excluded.url, reason = excluded.reason, bibtex = excluded.bibtex",
        params![
            citation.id,
            citation.document_id,
            citation.raw_reference,
            citation.title,
            citation.authors,
            citation.year,
            citation.doi,
            citation.url,
            citation.reason,
            citation.bibtex,
            citation.created_at
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(citation)
}

#[tauri::command]
fn delete_citation_card(app: AppHandle, id: String) -> AppResult<()> {
    let conn = open_db(&app)?;
    conn.execute("DELETE FROM citation_cards WHERE id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn save_ai_result(app: AppHandle, result: AiResultRecord) -> AppResult<AiResultRecord> {
    let conn = open_db(&app)?;
    conn.execute(
        "INSERT INTO ai_results (id, document_id, task_type, input_text, output_text, status, created_at, provider, model, provider_session_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET output_text = excluded.output_text, status = excluded.status, provider = excluded.provider, model = excluded.model, provider_session_id = excluded.provider_session_id",
        params![
            result.id,
            result.document_id,
            result.task_type,
            result.input_text,
            result.output_text,
            result.status,
            result.created_at,
            result.provider,
            result.model,
            result.provider_session_id
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(result)
}

#[tauri::command]
fn save_pdf_file(suggested_file_name: String, bytes: Vec<u8>) -> AppResult<Option<String>> {
    let script = r#"
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.SaveFileDialog
$dialog.Title = 'Save translated PDF'
$dialog.Filter = 'PDF files (*.pdf)|*.pdf|All files (*.*)|*.*'
$dialog.DefaultExt = 'pdf'
$dialog.AddExtension = $true
$dialog.OverwritePrompt = $true
$dialog.FileName = $env:PAPERDOCK_SAVE_NAME
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  [Console]::Out.Write($dialog.FileName)
}
$owner.Dispose()
"#;
    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-STA", "-Command", script])
        .env("PAPERDOCK_SAVE_NAME", suggested_file_name)
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .stdout(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        return Ok(None);
    }
    fs::write(&path, bytes).map_err(|error| error.to_string())?;
    Ok(Some(path))
}

#[tauri::command]
fn delete_ai_results(app: AppHandle, ids: Vec<String>) -> AppResult<()> {
    let conn = open_db(&app)?;
    for id in ids {
        conn.execute("DELETE FROM ai_results WHERE id = ?1", params![id])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn save_recommendation_run(
    app: AppHandle,
    run: RecommendationRunRecord,
) -> AppResult<RecommendationRunRecord> {
    let conn = open_db(&app)?;
    conn.execute(
        "INSERT INTO recommendation_runs (id, folder_id, query, result_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET query = excluded.query, result_json = excluded.result_json",
        params![run.id, run.folder_id, run.query, run.result_json, run.created_at],
    )
    .map_err(|error| error.to_string())?;
    Ok(run)
}

#[tauri::command]
fn set_setting(app: AppHandle, key: String, value: String) -> AppResult<()> {
    let conn = open_db(&app)?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn write_bridge_task(
    app: AppHandle,
    bridge_dir: String,
    task_type: String,
    document_id: String,
    provider: String,
    model: Option<String>,
    reasoning_effort: Option<String>,
    provider_session_id: Option<String>,
    payload_json: String,
) -> AppResult<BridgeTask> {
    let base = bridge_base(&app, &bridge_dir)?;
    let outbox = base.join("outbox");
    fs::create_dir_all(&outbox).map_err(|error| error.to_string())?;
    fs::create_dir_all(base.join("inbox")).map_err(|error| error.to_string())?;
    let payload: Value = serde_json::from_str(&payload_json)
        .map_err(|error| format!("Bridge payload JSON is invalid: {error}"))?;

    let task = BridgeTask {
        id: Uuid::new_v4().to_string(),
        task_type,
        document_id,
        provider,
        model,
        reasoning_effort,
        provider_session_id,
        payload,
        created_at: now(),
        bridge_dir: base.to_string_lossy().to_string(),
        file_path: outbox
            .join("placeholder.json")
            .to_string_lossy()
            .to_string(),
    };
    let path = outbox.join(format!("{}.json", task.id));
    let task = BridgeTask {
        file_path: path.to_string_lossy().to_string(),
        ..task
    };
    fs::write(
        &path,
        serde_json::to_vec_pretty(&task).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(task)
}

#[tauri::command]
fn read_bridge_result(
    app: AppHandle,
    bridge_dir: String,
    task_id: String,
) -> AppResult<Option<BridgeResult>> {
    let path = bridge_base(&app, &bridge_dir)?
        .join("inbox")
        .join(format!("{task_id}.json"));
    if !path.exists() {
        return Ok(None);
    }
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut buffer = String::new();
    file.read_to_string(&mut buffer)
        .map_err(|error| error.to_string())?;
    let raw: Value = serde_json::from_str(&buffer).map_err(|error| error.to_string())?;
    let result = BridgeResult {
        id: raw
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or(&task_id)
            .to_string(),
        task_type: raw
            .get("taskType")
            .or_else(|| raw.get("task_type"))
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        status: raw
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("complete")
            .to_string(),
        output: repair_legacy_mojibake(
            raw.get("output")
                .or_else(|| raw.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        ),
        payload: raw,
    };
    Ok(Some(result))
}

fn bridge_base(app: &AppHandle, bridge_dir: &str) -> AppResult<PathBuf> {
    let path = PathBuf::from(bridge_dir);
    if path.is_absolute() {
        fs::create_dir_all(&path).map_err(|error| error.to_string())?;
        return Ok(path);
    }
    let base = project_root(app).join(path);
    fs::create_dir_all(&base).map_err(|error| error.to_string())?;
    Ok(base)
}

fn project_root(app: &AppHandle) -> PathBuf {
    let mut candidates = Vec::new();

    if let Ok(cwd) = env::current_dir() {
        candidates.extend(cwd.ancestors().take(4).map(Path::to_path_buf));
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.extend(parent.ancestors().take(5).map(Path::to_path_buf));
        }
    }
    if let Ok(dir) = app_dir(app) {
        candidates.push(dir);
    }

    candidates
        .iter()
        .find(|path| {
            path.join("package.json").exists() && path.join("src-tauri").join("Cargo.toml").exists()
        })
        .cloned()
        .or_else(|| env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
}

#[derive(Debug, Clone)]
struct ResolvedAgentCommand {
    command: PathBuf,
    args_prefix: Vec<String>,
    source: PathBuf,
}

#[derive(Debug, Clone)]
struct MarkdownAttachment {
    path: PathBuf,
    source_path: PathBuf,
    reused_cache: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentMarkdownResult {
    pub document_id: String,
    pub markdown_path: String,
    pub source_path: String,
    pub reused_cache: bool,
    pub converter: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceFingerprint {
    source_path: String,
    len: u64,
    modified_secs: u64,
    modified_nanos: u32,
}

fn normalize_provider(value: &str) -> String {
    match value {
        "claude-code" => "claude-code".to_string(),
        "local-draft" | "api-provider" => "local-draft".to_string(),
        _ => "codex-cli".to_string(),
    }
}

fn home_dir() -> PathBuf {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn path_dirs() -> Vec<PathBuf> {
    env::var_os("PATH")
        .map(|value| env::split_paths(&value).collect())
        .unwrap_or_default()
}

fn expand_executable_candidate(path: PathBuf) -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        if path.extension().is_none() {
            let mut candidates = Vec::new();
            candidates.push(path.with_extension("exe"));
            candidates.push(path.with_extension("cmd"));
            candidates.push(path.with_extension("bat"));
            candidates.push(path);
            return candidates;
        }
    }
    vec![path]
}

fn command_candidates(provider: &str) -> Vec<PathBuf> {
    let provider = normalize_provider(provider);
    let home = home_dir();
    let local_appdata = env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let mut raw = Vec::new();

    let (env_names, command_name) = if provider == "claude-code" {
        (vec!["CLAUDE_CODE_BIN", "CLAUDE_BIN"], "claude")
    } else {
        (vec!["CODEX_BIN", "CODEX_PATH"], "codex")
    };

    for name in env_names {
        if let Some(value) = env::var_os(name) {
            raw.push(PathBuf::from(value));
        }
    }
    for dir in path_dirs() {
        raw.push(dir.join(command_name));
    }

    if provider == "claude-code" {
        raw.push(home.join(".npm-global").join("bin").join("claude"));
        raw.push(home.join(".local").join("bin").join("claude"));
        raw.push(home.join(".claude").join("bin").join("claude"));
        raw.push(
            home.join("AppData")
                .join("Roaming")
                .join("npm")
                .join("claude"),
        );
        raw.push(PathBuf::from("/opt/homebrew/bin/claude"));
        raw.push(PathBuf::from("/usr/local/bin/claude"));
    } else {
        raw.push(home.join(".npm-global").join("bin").join("codex"));
        raw.push(home.join(".local").join("bin").join("codex"));
        raw.push(home.join(".bun").join("bin").join("codex"));
        raw.push(home.join(".codex").join("bin").join("codex"));
        raw.push(
            home.join("AppData")
                .join("Roaming")
                .join("npm")
                .join("codex"),
        );
        if let Some(base) = local_appdata.clone() {
            let codex_bin = base.join("OpenAI").join("Codex").join("bin");
            raw.push(codex_bin.join("codex"));
            if let Ok(entries) = fs::read_dir(&codex_bin) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        raw.push(path.join("codex"));
                    }
                }
            }
            raw.push(base.join("Microsoft").join("WindowsApps").join("codex"));
        }
        raw.push(PathBuf::from(
            "/Applications/Codex.app/Contents/Resources/codex",
        ));
        raw.push(PathBuf::from("/opt/homebrew/bin/codex"));
        raw.push(PathBuf::from("/usr/local/bin/codex"));
    }

    let mut candidates = Vec::new();
    for path in raw {
        for expanded in expand_executable_candidate(path) {
            if !candidates.contains(&expanded) {
                candidates.push(expanded);
            }
        }
    }
    candidates
}

fn resolve_agent_command(provider: &str) -> AppResult<ResolvedAgentCommand> {
    let candidates = command_candidates(provider);
    let executable = candidates
        .iter()
        .find(|path| path.exists())
        .cloned()
        .ok_or_else(|| {
            let searched = candidates
                .iter()
                .take(12)
                .map(|path| path.to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join(", ");
            if normalize_provider(provider) == "claude-code" {
                format!("Claude Code CLI was not found. Searched: {searched}. Set CLAUDE_CODE_BIN if needed.")
            } else {
                format!("Codex CLI was not found. Searched: {searched}. Set CODEX_BIN if needed.")
            }
        })?;

    #[cfg(windows)]
    {
        let extension = executable
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if extension == "cmd" || extension == "bat" {
            return Ok(ResolvedAgentCommand {
                command: PathBuf::from("cmd.exe"),
                args_prefix: vec![
                    "/C".to_string(),
                    "call".to_string(),
                    executable.to_string_lossy().to_string(),
                ],
                source: executable,
            });
        }
    }

    Ok(ResolvedAgentCommand {
        command: executable.clone(),
        args_prefix: Vec::new(),
        source: executable,
    })
}

#[tauri::command]
fn get_agent_provider_status(provider: String) -> AppResult<Value> {
    let provider = normalize_provider(&provider);
    if provider == "local-draft" {
        return Ok(json!({
            "provider": provider,
            "installed": true,
            "message": "Local draft is available without a CLI."
        }));
    }

    match resolve_agent_command(&provider) {
        Ok(resolved) => Ok(json!({
            "provider": provider,
            "installed": true,
            "command": resolved.command.to_string_lossy(),
            "source": resolved.source.to_string_lossy(),
            "message": "Installed"
        })),
        Err(error) => Ok(json!({
            "provider": provider,
            "installed": false,
            "message": error
        })),
    }
}

fn task_string(task: &BridgeTask, key: &str) -> Option<String> {
    task.payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn task_prompt(task: &BridgeTask) -> String {
    task_string(task, "prompt").unwrap_or_else(|| {
        format!(
            "Paper Pilot task: {}\n\nPayload:\n{}",
            task.task_type,
            serde_json::to_string_pretty(&task.payload).unwrap_or_default()
        )
    })
}

fn task_document_file_path(task: &BridgeTask) -> Option<PathBuf> {
    task.payload
        .get("document")
        .and_then(|document| document.get("filePath"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn push_add_dir_arg(args: &mut Vec<String>, dir: &Path) {
    let value = dir.to_string_lossy().to_string();
    if args
        .windows(2)
        .any(|pair| pair[0] == "--add-dir" && pair[1] == value)
    {
        return;
    }
    args.push("--add-dir".to_string());
    args.push(value);
}

fn push_parent_add_dir_arg(args: &mut Vec<String>, path: &Path) {
    if let Some(parent) = path.parent().filter(|path| !path.as_os_str().is_empty()) {
        push_add_dir_arg(args, parent);
    }
}

fn push_codex_chat_source_access_args(
    args: &mut Vec<String>,
    task: &BridgeTask,
    markdown_path: Option<&Path>,
) {
    if task.task_type != "chatWithPaper" {
        return;
    }
    if let Some(path) = markdown_path {
        push_parent_add_dir_arg(args, path);
        return;
    }
    if let Some(pdf_path) = task_document_file_path(task) {
        push_parent_add_dir_arg(args, &pdf_path);
    }
}

fn markitdown_mcp_candidates() -> Vec<PathBuf> {
    let home = home_dir();
    let mut raw = Vec::new();
    if let Some(value) = env::var_os("MARKITDOWN_MCP_BIN") {
        raw.push(PathBuf::from(value));
    }
    for dir in path_dirs() {
        raw.push(dir.join("markitdown-mcp"));
    }
    raw.push(home.join(".local").join("bin").join("markitdown-mcp"));
    raw.push(
        home.join("AppData")
            .join("Roaming")
            .join("Python")
            .join("Scripts")
            .join("markitdown-mcp"),
    );

    let mut candidates = Vec::new();
    for path in raw {
        for expanded in expand_executable_candidate(path) {
            if !candidates.contains(&expanded) {
                candidates.push(expanded);
            }
        }
    }
    candidates
}

fn resolve_markitdown_mcp_command() -> AppResult<ResolvedAgentCommand> {
    let candidates = markitdown_mcp_candidates();
    let executable = candidates
        .iter()
        .find(|path| path.exists())
        .cloned()
        .ok_or_else(|| {
            let searched = candidates
                .iter()
                .take(12)
                .map(|path| path.to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join(", ");
            format!("MarkItDown MCP server was not found. Searched: {searched}. Set MARKITDOWN_MCP_BIN if needed.")
        })?;

    #[cfg(windows)]
    {
        let extension = executable
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if extension == "cmd" || extension == "bat" {
            return Ok(ResolvedAgentCommand {
                command: PathBuf::from("cmd.exe"),
                args_prefix: vec![
                    "/C".to_string(),
                    "call".to_string(),
                    executable.to_string_lossy().to_string(),
                ],
                source: executable,
            });
        }
    }

    Ok(ResolvedAgentCommand {
        command: executable.clone(),
        args_prefix: Vec::new(),
        source: executable,
    })
}

fn percent_encode_uri_path(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.as_bytes() {
        let ch = *byte as char;
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '~' | '/' | ':') {
            encoded.push(ch);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn path_to_file_uri(path: &Path) -> String {
    let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let mut value = canonical.to_string_lossy().replace('\\', "/");
    if let Some(stripped) = value.strip_prefix("//?/UNC/") {
        value = format!("//{stripped}");
    } else if let Some(stripped) = value.strip_prefix("//?/") {
        value = stripped.to_string();
    }

    if value.starts_with("//") {
        format!("file:{}", percent_encode_uri_path(&value))
    } else {
        format!(
            "file:///{}",
            percent_encode_uri_path(value.trim_start_matches('/'))
        )
    }
}

fn send_mcp_message(stdin: &mut impl Write, value: &Value) -> AppResult<()> {
    let line = serde_json::to_string(value).map_err(|error| error.to_string())?;
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|error| error.to_string())
}

fn read_mcp_response(reader: &mut impl BufRead, id: i64) -> AppResult<Value> {
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Err(format!(
                "MarkItDown MCP closed stdout before response id {id}."
            ));
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if message.get("id").and_then(Value::as_i64) == Some(id) {
            return Ok(message);
        }
    }
}

fn mcp_error_text(value: &Value) -> String {
    value
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| value.get("detail").and_then(Value::as_str))
        .unwrap_or("Unknown MCP error")
        .to_string()
}

fn mcp_content_text(result: &Value) -> String {
    result
        .get("content")
        .and_then(Value::as_array)
        .map(|content| {
            content
                .iter()
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .filter(|text| !text.trim().is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join("\n\n")
        })
        .unwrap_or_default()
}

fn extract_mcp_tool_text(response: Value) -> AppResult<String> {
    if let Some(error) = response.get("error") {
        return Err(mcp_error_text(error));
    }
    let result = response
        .get("result")
        .ok_or_else(|| "MarkItDown MCP response did not include a result.".to_string())?;
    let text = mcp_content_text(result);
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        return Err(if text.trim().is_empty() {
            "MarkItDown MCP returned an error.".to_string()
        } else {
            text
        });
    }
    if text.trim().is_empty() {
        Err("MarkItDown MCP returned empty Markdown.".to_string())
    } else {
        Ok(text)
    }
}

fn convert_pdf_to_markdown_with_mcp(pdf_path: &Path, root: &Path) -> AppResult<String> {
    let resolved = resolve_markitdown_mcp_command()?;
    let mut command = Command::new(&resolved.command);
    command
        .args(&resolved.args_prefix)
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command.spawn().map_err(|error| {
        format!(
            "Failed to start MarkItDown MCP server at {}: {error}",
            resolved.source.to_string_lossy()
        )
    })?;
    let result = (|| {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "MarkItDown MCP stdin was unavailable.".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "MarkItDown MCP stdout was unavailable.".to_string())?;
        let mut reader = BufReader::new(stdout);
        send_mcp_message(
            &mut stdin,
            &json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {
                        "name": "paper-pilot",
                        "version": "0.1.0"
                    }
                }
            }),
        )?;
        let _ = read_mcp_response(&mut reader, 1)?;
        send_mcp_message(
            &mut stdin,
            &json!({
                "jsonrpc": "2.0",
                "method": "notifications/initialized"
            }),
        )?;
        send_mcp_message(
            &mut stdin,
            &json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "convert_to_markdown",
                    "arguments": {
                        "uri": path_to_file_uri(pdf_path)
                    }
                }
            }),
        )?;
        let response = read_mcp_response(&mut reader, 2)?;
        extract_mcp_tool_text(response)
    })();
    let _ = child.kill();
    let _ = child.wait();
    result
}

fn source_fingerprint(path: &Path) -> AppResult<SourceFingerprint> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    let modified = metadata
        .modified()
        .unwrap_or(UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| std::time::Duration::from_secs(0));
    Ok(SourceFingerprint {
        source_path: path.to_string_lossy().to_string(),
        len: metadata.len(),
        modified_secs: modified.as_secs(),
        modified_nanos: modified.subsec_nanos(),
    })
}

fn markdown_cache_paths(base: &Path, document_id: &str, fallback_id: &str) -> (PathBuf, PathBuf) {
    let raw = if document_id.trim().is_empty() {
        fallback_id
    } else {
        document_id
    };
    let mut stem = sanitize_file_name(raw);
    if stem.trim_matches('_').is_empty() {
        stem = sanitize_file_name(fallback_id);
    }
    let markdown_path = base.join("markitdown").join(format!("{stem}.md"));
    let metadata_path = markdown_path.with_extension("meta.json");
    (markdown_path, metadata_path)
}

fn cached_markdown_is_fresh(metadata_path: &Path, fingerprint: &SourceFingerprint) -> bool {
    fs::read_to_string(metadata_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<SourceFingerprint>(&raw).ok())
        .as_ref()
        == Some(fingerprint)
}

fn prepare_markdown_attachment(
    base: &Path,
    root: &Path,
    task: &BridgeTask,
) -> AppResult<Option<MarkdownAttachment>> {
    if task.task_type != "chatWithPaper" {
        return Ok(None);
    }
    let Some(pdf_path) = task_document_file_path(task) else {
        return Ok(None);
    };
    prepare_pdf_markdown_attachment(base, root, &task.document_id, &task.id, &pdf_path)
}

fn prepare_pdf_markdown_attachment(
    base: &Path,
    root: &Path,
    document_id: &str,
    fallback_id: &str,
    pdf_path: &Path,
) -> AppResult<Option<MarkdownAttachment>> {
    let pdf_path = if pdf_path.is_absolute() {
        pdf_path.to_path_buf()
    } else {
        root.join(pdf_path)
    };
    let is_pdf = pdf_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false);
    if !is_pdf {
        return Ok(None);
    }
    if !pdf_path.exists() {
        return Err(format!(
            "PDF file does not exist and cannot be converted to Markdown: {}",
            pdf_path.to_string_lossy()
        ));
    }

    let fingerprint = source_fingerprint(&pdf_path)?;
    let (markdown_path, metadata_path) = markdown_cache_paths(base, document_id, fallback_id);
    if markdown_path.exists() && cached_markdown_is_fresh(&metadata_path, &fingerprint) {
        return Ok(Some(MarkdownAttachment {
            path: markdown_path,
            source_path: pdf_path,
            reused_cache: true,
        }));
    }

    if let Some(parent) = markdown_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let markdown = convert_pdf_to_markdown_with_mcp(&pdf_path, root)?;
    let tmp_path = markdown_path.with_extension("md.tmp");
    fs::write(&tmp_path, markdown).map_err(|error| error.to_string())?;
    let _ = fs::remove_file(&markdown_path);
    fs::rename(&tmp_path, &markdown_path).map_err(|error| error.to_string())?;
    fs::write(
        &metadata_path,
        serde_json::to_vec_pretty(&fingerprint).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;

    Ok(Some(MarkdownAttachment {
        path: markdown_path,
        source_path: pdf_path,
        reused_cache: false,
    }))
}

fn document_markdown_result(
    document_id: &str,
    attachment: MarkdownAttachment,
) -> DocumentMarkdownResult {
    DocumentMarkdownResult {
        document_id: document_id.to_string(),
        markdown_path: attachment.path.to_string_lossy().to_string(),
        source_path: attachment.source_path.to_string_lossy().to_string(),
        reused_cache: attachment.reused_cache,
        converter: "markitdown-mcp".to_string(),
    }
}

fn image_extension(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        _ => "png",
    }
}

fn write_task_image(base: &Path, task: &BridgeTask) -> AppResult<Option<PathBuf>> {
    let Some(data_url) = task.payload.get("imageDataUrl").and_then(Value::as_str) else {
        return Ok(None);
    };
    let Some((header, encoded)) = data_url.split_once(',') else {
        return Err("imageDataUrl is not a data URL.".to_string());
    };
    let mime = header
        .strip_prefix("data:")
        .and_then(|value| value.split(';').next())
        .unwrap_or("image/png")
        .to_ascii_lowercase();
    let encoded = encoded
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect::<String>();
    let bytes = general_purpose::STANDARD
        .decode(encoded.as_bytes())
        .map_err(|error| format!("imageDataUrl base64 is invalid: {error}"))?;
    let dir = base.join("attachments");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = dir.join(format!("{}.{}", task.id, image_extension(&mime)));
    fs::write(&path, bytes).map_err(|error| error.to_string())?;
    Ok(Some(path))
}

fn command_line_display(resolved: &ResolvedAgentCommand, args: &[String]) -> String {
    let mut parts = vec![resolved.command.to_string_lossy().to_string()];
    parts.extend(resolved.args_prefix.clone());
    parts.extend(args.iter().cloned());
    parts
        .into_iter()
        .map(|part| {
            if part.contains(' ') {
                format!("\"{}\"", part.replace('"', "\\\""))
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn codex_args(
    task: &BridgeTask,
    root: &Path,
    response_file: &Path,
    image_path: Option<&Path>,
    markdown_path: Option<&Path>,
) -> Vec<String> {
    let model = task
        .model
        .as_deref()
        .filter(|value| !value.trim().is_empty());
    let reasoning_effort = task
        .reasoning_effort
        .as_deref()
        .map(str::trim)
        .filter(|value| matches!(*value, "none" | "low" | "medium" | "high" | "xhigh"));
    let mut args = vec!["exec".to_string()];

    args.extend(["--json".to_string(), "--skip-git-repo-check".to_string()]);
    push_codex_chat_source_access_args(&mut args, task, markdown_path);
    args.extend([
        "--sandbox".to_string(),
        "read-only".to_string(),
        "--cd".to_string(),
        root.to_string_lossy().to_string(),
        "-o".to_string(),
        response_file.to_string_lossy().to_string(),
    ]);
    if let Some(model) = model {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    if let Some(reasoning_effort) = reasoning_effort {
        args.push("-c".to_string());
        args.push(format!("model_reasoning_effort=\"{reasoning_effort}\""));
    }
    if let Some(path) = image_path {
        args.push("--image".to_string());
        args.push(path.to_string_lossy().to_string());
    }
    args
}

fn claude_args(task: &BridgeTask, root: &Path, markdown_path: Option<&Path>) -> Vec<String> {
    let mut args = vec![
        "--print".to_string(),
        "--verbose".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--include-partial-messages".to_string(),
        "--permission-mode".to_string(),
        "bypassPermissions".to_string(),
        "--tools".to_string(),
        "Read,Glob,Grep,Bash".to_string(),
        "--add-dir".to_string(),
        root.to_string_lossy().to_string(),
    ];
    if let Some(path) = markdown_path {
        push_parent_add_dir_arg(&mut args, path);
    }
    if task.task_type == "chatWithPaper" {
        if let Some(session_id) = task
            .provider_session_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            args.push("--resume".to_string());
            args.push(session_id.to_string());
        }
    }
    if let Some(model) = task
        .model
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    args
}

fn markdown_prompt_section(markdown: &MarkdownAttachment) -> String {
    format!(
        "Full paper Markdown file path:\n{}\n\nConverted from PDF:\n{}\n\nUse this converted Markdown file as the primary full-paper source. Do not read the PDF directly unless the Markdown file is missing or obviously incomplete.",
        markdown.path.to_string_lossy(),
        markdown.source_path.to_string_lossy()
    )
}

fn prompt_with_markdown_attachment(
    prompt: String,
    task: &BridgeTask,
    markdown: &MarkdownAttachment,
) -> String {
    let prompt = prompt
        .replace(
            "Use the PDF file path below as the primary source and inspect the entire paper when the question requires cross-page synthesis.",
            "Use the converted Markdown file path below as the primary source and inspect the entire paper when the question requires cross-page synthesis.",
        )
        .replace(
            "If the PDF cannot be read directly, say that clearly and then answer only from any provided extracted page capsules.",
            "If the converted Markdown file cannot be read directly, say that clearly and then answer only from any provided extracted page capsules.",
        )
        .replace(
            "using only the provided PDF evidence",
            "using only the provided converted Markdown/paper evidence",
        )
        .replace(
            "based only on provided PDF evidence",
            "based only on provided converted Markdown/paper evidence",
        );
    let section = markdown_prompt_section(markdown);
    if let Some(pdf_path) = task_document_file_path(task) {
        let old = format!("Full PDF file path:\n{}", pdf_path.to_string_lossy());
        if prompt.contains(&old) {
            return prompt.replace(&old, &section);
        }
    }
    format!("{prompt}\n\n{section}")
}

fn agent_stdin_prompt(
    task: &BridgeTask,
    image_path: Option<&Path>,
    markdown: Option<&MarkdownAttachment>,
) -> String {
    let mut prompt = task_prompt(task);
    if let Some(markdown) = markdown {
        prompt = prompt_with_markdown_attachment(prompt, task, markdown);
    }
    if task.provider == "claude-code" {
        if let Some(path) = image_path {
            prompt.push_str(&format!(
                "\n\nSelected image crop file path: {}",
                path.to_string_lossy()
            ));
        }
    }
    prompt
}

fn collect_text_parts(value: &Value) -> Vec<String> {
    let mut parts = Vec::new();
    if let Some(text) = value.get("text").and_then(Value::as_str) {
        if !text.trim().is_empty() {
            parts.push(text.to_string());
        }
    }
    if let Some(content) = value.get("content").and_then(Value::as_array) {
        for part in content {
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                if !text.trim().is_empty() {
                    parts.push(text.to_string());
                }
            }
        }
    }
    parts
}

fn readable_agent_error(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        if let Some(message) = value
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
        {
            return message.to_string();
        }
        if let Some(detail) = value.get("detail").and_then(Value::as_str) {
            return detail.to_string();
        }
        if let Some(message) = value.get("message").and_then(Value::as_str) {
            return message.to_string();
        }
    }
    trimmed.to_string()
}

fn parse_codex_output(stdout: &str, response_file: &Path) -> (Option<String>, String) {
    let mut session_id = None;
    let mut messages = Vec::new();
    let mut errors = Vec::new();
    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let event_type = event
            .get("type")
            .or_else(|| event.get("event"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if event_type == "thread.started" {
            session_id = event
                .get("thread_id")
                .and_then(Value::as_str)
                .map(ToString::to_string);
        }
        if event_type == "error" {
            if let Some(message) = event.get("message").and_then(Value::as_str) {
                let message = readable_agent_error(message);
                if !message.is_empty() {
                    errors.push(message);
                }
            }
        }
        if event_type == "turn.failed" {
            if let Some(message) = event
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
            {
                let message = readable_agent_error(message);
                if !message.is_empty() {
                    errors.push(message);
                }
            }
        }
        let Some(item) = event.get("item") else {
            continue;
        };
        if event_type == "item.completed"
            && item.get("type").and_then(Value::as_str) == Some("agent_message")
        {
            messages.extend(collect_text_parts(item));
        }
    }
    let content = fs::read_to_string(response_file)
        .unwrap_or_default()
        .trim()
        .to_string();
    let content = if content.is_empty() {
        messages.join("\n\n").trim().to_string()
    } else {
        content
    };
    let content = if content.is_empty() && !errors.is_empty() {
        errors.join("\n")
    } else {
        content
    };
    (session_id, content)
}

fn parse_claude_output(stdout: &str) -> (Option<String>, String) {
    let mut session_id = None;
    let mut messages = Vec::new();
    let mut result = String::new();
    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if event.get("type").and_then(Value::as_str) == Some("system")
            && event.get("subtype").and_then(Value::as_str) == Some("init")
        {
            session_id = event
                .get("session_id")
                .and_then(Value::as_str)
                .map(ToString::to_string);
        }
        if event.get("type").and_then(Value::as_str) == Some("assistant") {
            if let Some(message) = event.get("message") {
                messages.extend(collect_text_parts(message));
            }
        }
        if event.get("type").and_then(Value::as_str) == Some("result") {
            if let Some(text) = event.get("result").and_then(Value::as_str) {
                result = text.to_string();
            }
        }
    }
    let content = messages.join("\n\n").trim().to_string();
    let content = if content.is_empty() {
        result.trim().to_string()
    } else {
        content
    };
    (session_id, content)
}

fn run_agent_command(
    resolved: &ResolvedAgentCommand,
    args: &[String],
    stdin_text: Option<&str>,
    root: &Path,
    log_path: &Path,
    error_log_path: &Path,
) -> AppResult<(i32, String, String)> {
    let mut command = Command::new(&resolved.command);
    command
        .args(&resolved.args_prefix)
        .args(args)
        .current_dir(root)
        .stdin(if stdin_text.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    if let Some(input) = stdin_text {
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(input.as_bytes())
                .map_err(|error| error.to_string())?;
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    fs::write(log_path, &output.stdout).map_err(|error| error.to_string())?;
    fs::write(error_log_path, &output.stderr).map_err(|error| error.to_string())?;
    Ok((
        output.status.code().unwrap_or(-1),
        decode_process_bytes(&output.stdout),
        decode_process_bytes(&output.stderr),
    ))
}

fn write_json_file(path: &Path, value: &Value) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(
        path,
        serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn finish_agent_task(
    base: &Path,
    task_file: &Path,
    task: &BridgeTask,
    metadata: Value,
) -> AppResult<()> {
    let inbox_file = base.join("inbox").join(format!("{}.json", task.id));
    write_json_file(&inbox_file, &metadata)?;
    let processed_file = base.join("processed").join(format!("{}.json", task.id));
    write_json_file(
        &processed_file,
        &json!({
            "task": task,
            "processedAt": now(),
            "capture": metadata,
        }),
    )?;
    let _ = fs::remove_file(task_file);
    Ok(())
}

fn run_agent_task(
    root: &Path,
    base: &Path,
    task_file: &Path,
    log_path: &Path,
    error_log_path: &Path,
    final_log_path: &Path,
) -> AppResult<Value> {
    let raw = fs::read_to_string(task_file).map_err(|error| error.to_string())?;
    let mut task: BridgeTask = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    task.provider = normalize_provider(&task.provider);
    let image_path = write_task_image(base, &task)?;
    let response_file = base.join("logs").join(format!("{}.response.md", task.id));

    if let Ok(mock) = env::var("PAPERDOCK_AI_MOCK_RESPONSE") {
        let metadata = json!({
            "id": &task.id,
            "taskType": &task.task_type,
            "documentId": &task.document_id,
            "provider": &task.provider,
            "model": &task.model,
            "providerSessionId": &task.provider_session_id,
            "status": "complete",
            "output": mock,
            "payload": {
                "mock": true,
                "provider": &task.provider,
                "model": &task.model,
                "providerSessionId": &task.provider_session_id,
                "logPath": log_path,
                "errorLogPath": error_log_path,
                "finalLogPath": final_log_path,
            },
            "savedAt": now(),
        });
        finish_agent_task(base, task_file, &task, metadata.clone())?;
        return Ok(metadata);
    }

    if task.provider == "local-draft" {
        let metadata = json!({
            "id": &task.id,
            "taskType": &task.task_type,
            "documentId": &task.document_id,
            "provider": &task.provider,
            "model": &task.model,
            "providerSessionId": &task.provider_session_id,
            "status": "failed",
            "output": "Local draft provider does not use the agent worker.",
            "payload": {
                "provider": &task.provider,
                "model": &task.model,
                "providerSessionId": &task.provider_session_id,
                "logPath": log_path,
                "errorLogPath": error_log_path,
                "finalLogPath": final_log_path,
            },
            "savedAt": now(),
        });
        finish_agent_task(base, task_file, &task, metadata.clone())?;
        return Ok(metadata);
    }

    let resolved = match resolve_agent_command(&task.provider) {
        Ok(command) => command,
        Err(error) => {
            let error_message = error;
            let metadata = json!({
                "id": &task.id,
                "taskType": &task.task_type,
                "documentId": &task.document_id,
                "provider": &task.provider,
                "model": &task.model,
                "providerSessionId": &task.provider_session_id,
                "status": "failed",
                "output": error_message.clone(),
                "payload": {
                    "provider": &task.provider,
                    "model": &task.model,
                    "providerSessionId": &task.provider_session_id,
                    "error": error_message,
                    "logPath": log_path,
                    "errorLogPath": error_log_path,
                    "finalLogPath": final_log_path,
                },
                "savedAt": now(),
            });
            finish_agent_task(base, task_file, &task, metadata.clone())?;
            return Ok(metadata);
        }
    };

    let markdown_attachment = match prepare_markdown_attachment(base, root, &task) {
        Ok(attachment) => attachment,
        Err(error) => {
            let error_message = format!("PDF to Markdown conversion failed: {error}");
            let metadata = json!({
                "id": &task.id,
                "taskType": &task.task_type,
                "documentId": &task.document_id,
                "provider": &task.provider,
                "model": &task.model,
                "providerSessionId": &task.provider_session_id,
                "status": "failed",
                "output": error_message.clone(),
                "payload": {
                    "provider": &task.provider,
                    "model": &task.model,
                    "providerSessionId": &task.provider_session_id,
                    "error": error_message,
                    "markdownConverter": "markitdown-mcp",
                    "logPath": log_path,
                    "errorLogPath": error_log_path,
                    "finalLogPath": final_log_path,
                },
                "savedAt": now(),
            });
            finish_agent_task(base, task_file, &task, metadata.clone())?;
            return Ok(metadata);
        }
    };
    let markdown_path = markdown_attachment
        .as_ref()
        .map(|attachment| attachment.path.as_path());
    let args = if task.provider == "claude-code" {
        claude_args(&task, root, markdown_path)
    } else {
        codex_args(
            &task,
            root,
            &response_file,
            image_path.as_deref(),
            markdown_path,
        )
    };
    let stdin_prompt =
        agent_stdin_prompt(&task, image_path.as_deref(), markdown_attachment.as_ref());
    let command_display = format!(
        "{} <prompt via stdin>",
        command_line_display(&resolved, &args)
    );
    let (exit_code, stdout, stderr) = run_agent_command(
        &resolved,
        &args,
        Some(&stdin_prompt),
        root,
        log_path,
        error_log_path,
    )?;
    let (new_session_id, content) = if task.provider == "claude-code" {
        parse_claude_output(&stdout)
    } else {
        parse_codex_output(&stdout, &response_file)
    };
    let provider_session_id = new_session_id.or(task.provider_session_id.clone());
    let saw_agent_error_event = task.provider == "codex-cli"
        && stdout.lines().any(|line| {
            line.contains("\"type\":\"error\"") || line.contains("\"type\":\"turn.failed\"")
        });
    let status = if exit_code == 0 && !content.trim().is_empty() {
        "complete"
    } else if !content.trim().is_empty() && !saw_agent_error_event {
        "partial"
    } else {
        "failed"
    };
    let output = if content.trim().is_empty() {
        let detail = stderr.trim();
        if detail.is_empty() {
            format!(
                "{} exited with code {exit_code} and returned no assistant message.",
                task.provider
            )
        } else {
            detail.to_string()
        }
    } else {
        content
    };

    let metadata = json!({
        "id": &task.id,
        "taskType": &task.task_type,
        "documentId": &task.document_id,
        "provider": &task.provider,
        "model": &task.model,
        "providerSessionId": &provider_session_id,
        "status": status,
        "output": output,
        "payload": {
            "provider": &task.provider,
            "model": &task.model,
            "providerSessionId": &provider_session_id,
            "command": command_display,
            "stdinPrompt": true,
            "commandSource": resolved.source,
            "exitCode": exit_code,
            "logPath": log_path,
            "errorLogPath": error_log_path,
            "finalLogPath": final_log_path,
            "responseFile": response_file,
            "imagePath": image_path,
            "markdownPath": markdown_attachment.as_ref().map(|attachment| attachment.path.clone()),
            "markdownSourcePath": markdown_attachment.as_ref().map(|attachment| attachment.source_path.clone()),
            "markdownCacheReused": markdown_attachment.as_ref().map(|attachment| attachment.reused_cache),
            "markdownConverter": markdown_attachment.as_ref().map(|_| "markitdown-mcp"),
        },
        "savedAt": now(),
    });
    finish_agent_task(base, task_file, &task, metadata.clone())?;
    Ok(metadata)
}

fn parse_worker_arg(args: &[String], name: &str) -> Option<String> {
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].clone())
}

fn run_agent_worker_from_args(args: &[String]) -> AppResult<()> {
    let project_root = parse_worker_arg(args, "--project-root")
        .map(PathBuf::from)
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let bridge_dir = parse_worker_arg(args, "--bridge-dir")
        .map(PathBuf::from)
        .ok_or_else(|| "--bridge-dir is required".to_string())?;
    let task_id =
        parse_worker_arg(args, "--task-id").ok_or_else(|| "--task-id is required".to_string())?;
    let log_path = parse_worker_arg(args, "--log-path")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            bridge_dir
                .join("logs")
                .join(format!("{task_id}.agent.out.log"))
        });
    let error_log_path = parse_worker_arg(args, "--error-log-path")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            bridge_dir
                .join("logs")
                .join(format!("{task_id}.agent.err.log"))
        });
    let final_log_path = parse_worker_arg(args, "--status-file")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            bridge_dir
                .join("logs")
                .join(format!("{task_id}.agent.status.json"))
        });
    let task_file = bridge_dir.join("outbox").join(format!("{task_id}.json"));
    let result = run_agent_task(
        &project_root,
        &bridge_dir,
        &task_file,
        &log_path,
        &error_log_path,
        &final_log_path,
    )
    .unwrap_or_else(|error| {
        let error_message = error;
        let metadata = json!({
            "id": task_id,
            "taskType": "unknown",
            "documentId": "",
            "provider": "unknown",
            "status": "failed",
            "output": error_message.clone(),
            "payload": {
                "error": error_message,
                "logPath": log_path,
                "errorLogPath": error_log_path,
                "finalLogPath": final_log_path,
            },
            "savedAt": now(),
        });
        let inbox_file = bridge_dir.join("inbox").join(format!("{task_id}.json"));
        let _ = write_json_file(&inbox_file, &metadata);
        metadata
    });
    write_json_file(&final_log_path, &result)?;
    Ok(())
}

#[tauri::command]
fn start_bridge_worker(
    app: AppHandle,
    bridge_dir: String,
    task_id: String,
) -> AppResult<BridgeWorkerRun> {
    let root = project_root(&app);
    let base = bridge_base(&app, &bridge_dir)?;
    let outbox_file = base.join("outbox").join(format!("{task_id}.json"));
    let logs_dir = base.join("logs");
    fs::create_dir_all(&logs_dir).map_err(|error| error.to_string())?;

    let log_path = logs_dir.join(format!("{task_id}.agent.out.log"));
    let error_log_path = logs_dir.join(format!("{task_id}.agent.err.log"));
    let final_log_path = logs_dir.join(format!("{task_id}.agent.status.json"));
    let command_path = env::current_exe().map_err(|error| error.to_string())?;
    let command_display = format!(
        "{} --paperdock-agent-worker --project-root \"{}\" --bridge-dir \"{}\" --task-id \"{}\" --log-path \"{}\" --error-log-path \"{}\" --status-file \"{}\"",
        command_path.to_string_lossy(),
        root.to_string_lossy(),
        base.to_string_lossy(),
        task_id,
        log_path.to_string_lossy(),
        error_log_path.to_string_lossy(),
        final_log_path.to_string_lossy()
    );

    if !outbox_file.exists() {
        return Ok(BridgeWorkerRun {
            started: false,
            task_id,
            pid: None,
            command: command_display,
            log_path: log_path.to_string_lossy().to_string(),
            error_log_path: error_log_path.to_string_lossy().to_string(),
            final_log_path: final_log_path.to_string_lossy().to_string(),
            message: format!(
                "Agent task file does not exist: {}",
                outbox_file.to_string_lossy()
            ),
        });
    }

    let stdout = File::create(&log_path).map_err(|error| error.to_string())?;
    let stderr = File::create(&error_log_path).map_err(|error| error.to_string())?;

    let mut command = Command::new(&command_path);
    command
        .arg("--paperdock-agent-worker")
        .arg("--project-root")
        .arg(&root)
        .arg("--bridge-dir")
        .arg(&base)
        .arg("--task-id")
        .arg(&task_id)
        .arg("--log-path")
        .arg(&log_path)
        .arg("--error-log-path")
        .arg(&error_log_path)
        .arg("--status-file")
        .arg(&final_log_path)
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    match command.spawn() {
        Ok(child) => Ok(BridgeWorkerRun {
            started: true,
            task_id,
            pid: Some(child.id()),
            command: command_display,
            log_path: log_path.to_string_lossy().to_string(),
            error_log_path: error_log_path.to_string_lossy().to_string(),
            final_log_path: final_log_path.to_string_lossy().to_string(),
            message: "Paper Pilot agent worker started.".to_string(),
        }),
        Err(error) => Ok(BridgeWorkerRun {
            started: false,
            task_id,
            pid: None,
            command: command_display,
            log_path: log_path.to_string_lossy().to_string(),
            error_log_path: error_log_path.to_string_lossy().to_string(),
            final_log_path: final_log_path.to_string_lossy().to_string(),
            message: format!("Failed to start Paper Pilot agent worker: {error}"),
        }),
    }
}

#[tauri::command]
fn export_document_json(app: AppHandle, document_id: String) -> AppResult<ExportBundle> {
    let conn = open_db(&app)?;
    export_bundle(&conn, &document_id)
}

#[tauri::command]
fn export_document_zip(app: AppHandle, document_id: String) -> AppResult<String> {
    let conn = open_db(&app)?;
    let bundle = export_bundle(&conn, &document_id)?;
    let exports_dir = app_dir(&app)?.join("exports");
    fs::create_dir_all(&exports_dir).map_err(|error| error.to_string())?;
    let safe_title = sanitize_file_name(&bundle.document.title);
    let zip_path = exports_dir.join(format!("{}-{}.zip", bundle.document.id, safe_title));
    let file = File::create(&zip_path).map_err(|error| error.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

    zip.start_file("metadata.json", options)
        .map_err(|error| error.to_string())?;
    zip.write_all(
        serde_json::to_vec_pretty(&bundle)
            .map_err(|error| error.to_string())?
            .as_slice(),
    )
    .map_err(|error| error.to_string())?;

    if Path::new(&bundle.document.file_path).exists() {
        zip.start_file(bundle.document.file_name.clone(), options)
            .map_err(|error| error.to_string())?;
        let bytes = fs::read(&bundle.document.file_path).map_err(|error| error.to_string())?;
        let mut reader = Cursor::new(bytes);
        std::io::copy(&mut reader, &mut zip).map_err(|error| error.to_string())?;
    }

    zip.finish().map_err(|error| error.to_string())?;
    Ok(zip_path.to_string_lossy().to_string())
}

#[tauri::command]
fn healthcheck(app: AppHandle) -> AppResult<Value> {
    let conn = open_db(&app)?;
    let state = load_state_from_db(&conn)?;
    Ok(json!({
        "ok": true,
        "documents": state.documents.len(),
        "folders": state.folders.len(),
        "annotations": state.annotations.len()
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_cp949_process_output() {
        let bytes = [
            0xB8, 0xED, 0xB7, 0xC9, 0xC1, 0xD9, 0xC0, 0xCC, 0x20, 0xB3, 0xCA, 0xB9, 0xAB, 0x20,
            0xB1, 0xE9, 0xB4, 0xCF, 0xB4, 0xD9, 0x2E, 0x0D, 0x0A,
        ];
        assert_eq!(decode_process_bytes(&bytes), "명령줄이 너무 깁니다.\r\n");
    }

    #[test]
    fn repairs_legacy_mojibake_message() {
        assert_eq!(
            repair_legacy_mojibake(LEGACY_LONG_COMMAND_MOJIBAKE.to_string()),
            "명령줄이 너무 깁니다. 다시 실행하면 긴 프롬프트를 stdin으로 전달해 처리합니다."
        );
    }
}

pub fn run() {
    let args = env::args().collect::<Vec<_>>();
    if args.iter().any(|arg| arg == "--paperdock-agent-worker") {
        if let Err(error) = run_agent_worker_from_args(&args) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }

    tauri::Builder::default()
        .setup(|app| {
            open_db(&app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            healthcheck,
            load_app_state,
            import_pdf,
            read_document_bytes,
            ensure_document_markdown,
            update_document,
            delete_document,
            save_pages,
            upsert_folder,
            delete_folders,
            upsert_annotation,
            delete_annotation,
            upsert_comment,
            upsert_note,
            delete_note,
            upsert_citation_card,
            delete_citation_card,
            save_ai_result,
            save_pdf_file,
            save_recommendation_run,
            set_setting,
            reset_workspace_files,
            write_bridge_task,
            read_bridge_result,
            start_bridge_worker,
            get_agent_provider_status,
            export_document_json,
            export_document_zip,
            delete_ai_results,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
