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
use std::io::{Cursor, Read, Write};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
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
    #[serde(default)]
    pub parent_result_id: Option<String>,
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
            provider_session_id TEXT,
            parent_result_id TEXT
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
    let _ = conn.execute(
        "ALTER TABLE ai_results ADD COLUMN parent_result_id TEXT",
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
        parent_result_id: row.get(10)?,
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
        "SELECT id, document_id, task_type, input_text, output_text, status, created_at, provider, model, provider_session_id, parent_result_id FROM ai_results ORDER BY created_at DESC",
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
            .prepare("SELECT id, document_id, task_type, input_text, output_text, status, created_at, provider, model, provider_session_id, parent_result_id FROM ai_results WHERE document_id = ?1 ORDER BY created_at DESC")
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

fn escape_sql_like(value: &str) -> String {
    let mut escaped = String::new();
    for ch in value.chars() {
        match ch {
            '\\' | '%' | '_' => {
                escaped.push('\\');
                escaped.push(ch);
            }
            _ => escaped.push(ch),
        }
    }
    escaped
}

fn prune_document_word_meanings(
    tx: &rusqlite::Transaction<'_>,
    document_id: &str,
) -> AppResult<()> {
    let raw: Option<String> = tx
        .query_row(
            "SELECT value FROM settings WHERE key = 'wordMeaningMapJson'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(raw) = raw else {
        return Ok(());
    };
    let mut parsed: Value = match serde_json::from_str(&raw) {
        Ok(Value::Object(map)) => Value::Object(map),
        _ => return Ok(()),
    };
    let Some(map) = parsed.as_object_mut() else {
        return Ok(());
    };

    let mut changed = false;
    let mut empty_keys = Vec::new();
    for (key, value) in map.iter_mut() {
        let Some(entries) = value.as_array_mut() else {
            continue;
        };
        let before = entries.len();
        entries.retain(|entry| {
            entry
                .get("documentId")
                .and_then(Value::as_str)
                .map(|entry_document_id| entry_document_id != document_id)
                .unwrap_or(true)
        });
        if entries.len() != before {
            changed = true;
        }
        if entries.is_empty() {
            empty_keys.push(key.clone());
        }
    }
    for key in empty_keys {
        map.remove(&key);
    }
    if changed {
        let value = serde_json::to_string(&parsed).map_err(|error| error.to_string())?;
        tx.execute(
            "INSERT INTO settings (key, value) VALUES ('wordMeaningMapJson', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![value],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn delete_document_scoped_settings(
    tx: &rusqlite::Transaction<'_>,
    document_id: &str,
) -> AppResult<()> {
    prune_document_word_meanings(tx, document_id)?;

    for key in [
        format!("documentZoom:{document_id}"),
        format!("documentScrollLeft:{document_id}"),
        format!("readerBookmarks:{document_id}"),
        format!("readerLastViewport:{document_id}"),
        format!("pageTextLayoutAiVersion:{document_id}"),
        format!("documentOutlineVersion:{document_id}"),
        format!("readingStatus:{document_id}"),
        format!("documentWordList:{document_id}"),
    ] {
        tx.execute("DELETE FROM settings WHERE key = ?1", params![key])
            .map_err(|error| error.to_string())?;
    }

    let escaped_document_id = escape_sql_like(document_id);
    for prefix in [
        "pageTextLayout:",
        "pageTextLayoutConfidence:",
        "pageTextLayoutSource:",
    ] {
        let pattern = format!("{prefix}{escaped_document_id}:%");
        tx.execute(
            "DELETE FROM settings WHERE key LIKE ?1 ESCAPE '\\'",
            params![pattern],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
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
            params![&document_id],
        )
        .map_err(|error| error.to_string())?;
    }
    delete_document_scoped_settings(&tx, &document_id)?;
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
fn upsert_pages(app: AppHandle, document_id: String, pages: Vec<PageRecord>) -> AppResult<()> {
    let conn = open_db(&app)?;
    for page in pages
        .into_iter()
        .filter(|page| page.document_id == document_id)
    {
        conn.execute(
            "INSERT INTO pages (document_id, page_number, text, outline_label) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(document_id, page_number) DO UPDATE SET text = excluded.text, outline_label = excluded.outline_label",
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
        "INSERT INTO ai_results (id, document_id, task_type, input_text, output_text, status, created_at, provider, model, provider_session_id, parent_result_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET output_text = excluded.output_text, status = excluded.status, provider = excluded.provider, model = excluded.model, provider_session_id = excluded.provider_session_id, parent_result_id = excluded.parent_result_id",
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
            result.provider_session_id,
            result.parent_result_id
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
        if let Some(base) = local_appdata.clone() {
            raw.push(base.join("Microsoft").join("WindowsApps").join("claude"));
        }
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

fn task_ask_mode(task: &BridgeTask) -> String {
    task.payload
        .get("askMode")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            if value.eq_ignore_ascii_case("direct") {
                "deep".to_string()
            } else {
                value.to_ascii_lowercase()
            }
        })
        .unwrap_or_else(|| "auto".to_string())
}

fn task_payload_string(task: &BridgeTask, key: &str) -> String {
    task.payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string()
}

fn json_string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string()
}

fn compact_for_prompt(value: &str, limit: usize) -> String {
    let clean = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() > limit {
        format!("{}...", clean.chars().take(limit).collect::<String>())
    } else {
        clean
    }
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

fn push_codex_chat_source_access_args(args: &mut Vec<String>, task: &BridgeTask) {
    if task.task_type != "chatWithPaper" {
        return;
    }
    if let Some(pdf_path) = task_document_file_path(task) {
        push_parent_add_dir_arg(args, &pdf_path);
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
    allow_resume: bool,
    allow_pdf_access: bool,
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
    let resume_session_id = if allow_resume && task.task_type == "chatWithPaper" {
        task.provider_session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
    } else {
        None
    };
    let mut args = vec!["exec".to_string()];
    args.extend(["--json".to_string(), "--skip-git-repo-check".to_string()]);
    if allow_pdf_access {
        push_codex_chat_source_access_args(&mut args, task);
    }
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
    if let Some(session_id) = resume_session_id {
        args.push("resume".to_string());
        args.push(session_id.to_string());
        args.push("-".to_string());
    }
    args
}

fn claude_args(
    task: &BridgeTask,
    root: &Path,
    allow_resume: bool,
    allow_pdf_access: bool,
) -> Vec<String> {
    let max_turns = if task.task_type == "chatWithPaper" && allow_pdf_access {
        "8"
    } else {
        "4"
    };
    let mut args = vec![
        "--print".to_string(),
        "--verbose".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--include-partial-messages".to_string(),
        "--permission-mode".to_string(),
        "dontAsk".to_string(),
        "--tools".to_string(),
        "Read,Glob,Grep".to_string(),
        "--allowedTools".to_string(),
        "Read,Glob,Grep".to_string(),
        "--strict-mcp-config".to_string(),
        "--max-turns".to_string(),
        max_turns.to_string(),
        "--add-dir".to_string(),
        root.to_string_lossy().to_string(),
    ];
    if allow_pdf_access && task.task_type == "chatWithPaper" {
        if let Some(pdf_path) = task_document_file_path(task) {
            push_parent_add_dir_arg(&mut args, &pdf_path);
        }
    }
    if allow_resume && task.task_type == "chatWithPaper" {
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
    if let Some(effort) = task
        .reasoning_effort
        .as_deref()
        .map(str::trim)
        .filter(|value| matches!(*value, "low" | "medium" | "high" | "xhigh" | "max"))
    {
        args.push("--effort".to_string());
        args.push(effort.to_string());
    }
    args
}

fn agent_stdin_prompt(task: &BridgeTask, image_path: Option<&Path>) -> String {
    let mut prompt = task_prompt(task);
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

fn extract_json_object(text: &str) -> AppResult<Value> {
    let trimmed = text.trim();
    let fenced = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .map(|value| value.trim())
        .and_then(|value| value.strip_suffix("```").map(str::trim))
        .unwrap_or(trimmed);
    if let Ok(value) = serde_json::from_str::<Value>(fenced) {
        return Ok(value);
    }
    let start = fenced
        .find('{')
        .ok_or_else(|| "No JSON object found in agent output.".to_string())?;
    let end = fenced
        .rfind('}')
        .ok_or_else(|| "No complete JSON object found in agent output.".to_string())?;
    serde_json::from_str::<Value>(&fenced[start..=end]).map_err(|error| error.to_string())
}

fn planner_prompt(task: &BridgeTask, forced_mode: Option<&str>) -> String {
    let question = task_payload_string(task, "question");
    let document_title = task
        .payload
        .get("document")
        .and_then(|document| document.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let mode_instruction = if forced_mode == Some("fast") {
        "The mode is forced to fast. Return fast and include retrievalQueries."
    } else {
        "Choose deep if answering requires directly inspecting equations, figures, tables, algorithms, visual layout, or complex cross-page reasoning in the original PDF. Choose fast if text retrieval evidence should be enough."
    };
    format!(
        "Convert the user's paper question into English and choose the answer mode.\n\n{mode_instruction}\n\nReturn only JSON. Do not include a reason.\nFor fast: {{\"englishQuestion\": string, \"mode\": \"fast\", \"retrievalQueries\": string[]}}\nFor deep: {{\"englishQuestion\": string, \"mode\": \"deep\"}}\n\nDocument title: {}\nUser question:\n{}",
        compact_for_prompt(document_title, 500),
        compact_for_prompt(&question, 3000)
    )
}

fn normalize_planner_result(
    value: Value,
    forced_mode: Option<&str>,
    fallback_question: &str,
) -> Value {
    let mut english_question = json_string(&value, "englishQuestion");
    if english_question.is_empty() {
        english_question = fallback_question.to_string();
    }
    let mut mode = json_string(&value, "mode").to_ascii_lowercase();
    if let Some(forced) = forced_mode {
        mode = forced.to_string();
    }
    if mode != "deep" {
        mode = "fast".to_string();
    }
    let mut output = json!({
        "englishQuestion": english_question,
        "mode": mode,
    });
    if output.get("mode").and_then(Value::as_str) == Some("fast") {
        let queries = value
            .get("retrievalQueries")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|item| !item.is_empty())
                    .take(6)
                    .map(|item| Value::String(item.to_string()))
                    .collect::<Vec<_>>()
            })
            .filter(|items| !items.is_empty())
            .unwrap_or_else(|| vec![Value::String(fallback_question.to_string())]);
        output["retrievalQueries"] = Value::Array(queries);
    }
    output
}

fn direct_deep_prompt(
    task: &BridgeTask,
    english_question: &str,
    original_question: &str,
) -> String {
    let pdf_path = task_document_file_path(task)
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();
    let context = task
        .payload
        .get("documentContextPack")
        .map(|value| serde_json::to_string_pretty(value).unwrap_or_default())
        .unwrap_or_default();
    format!(
        "You are Paper Pilot, a private academic PDF research assistant.\n\nWrite the final answer in the same language as the original user question. Use Markdown LaTeX for math: inline `$...$`, display `$$...$$`.\n\nUse the original PDF file as the primary source. Inspect the entire paper when the question requires cross-page synthesis. Cite factual claims with page markers like (p. 12). If a page number cannot be verified, do not invent it.\n\nFull PDF file path:\n{}\n\nOriginal user question:\n{}\n\nEnglish inspection question:\n{}\n\nDocument Context Pack (navigation aid only):\n{}",
        pdf_path,
        compact_for_prompt(original_question, 3000),
        compact_for_prompt(english_question, 3000),
        compact_for_prompt(&context, 12000)
    )
}

fn evidence_text_for_prompt(evidence: &[Value]) -> String {
    evidence
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let page = item
                .get("pageNumber")
                .and_then(Value::as_i64)
                .unwrap_or_default();
            let score = item
                .get("score")
                .and_then(Value::as_f64)
                .unwrap_or_default();
            let text = item.get("text").and_then(Value::as_str).unwrap_or("");
            format!(
                "[{}] p.{} score={:.3}\n{}",
                index + 1,
                page,
                score,
                compact_for_prompt(text, 1400)
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn fast_answer_prompt(planner: &Value, retrieval: &Value, original_question: &str) -> String {
    let english_question = json_string(planner, "englishQuestion");
    let evidence = retrieval
        .get("evidence")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    format!(
        "Answer the paper question using only the retrieved evidence below.\n\nReturn only JSON with this exact shape: {{\"answerMarkdown\": string, \"evidenceSufficient\": boolean}}\n\nRules:\n- Do not use model memory or the PDF path.\n- Cite every factual claim with page markers like (p. 12), using only page numbers shown in the evidence.\n- If the evidence only partially answers the question, still write the best evidence-based answer and set evidenceSufficient to false.\n- If evidence is empty or unrelated, answer briefly from the lack of evidence and set evidenceSufficient to false.\n- Write answerMarkdown in the same language as the original user question.\n\nOriginal user question:\n{}\n\nEnglish question:\n{}\n\nRetrieved evidence:\n{}",
        compact_for_prompt(original_question, 3000),
        compact_for_prompt(&english_question, 3000),
        evidence_text_for_prompt(&evidence)
    )
}

fn run_agent_stage(
    task: &BridgeTask,
    resolved: &ResolvedAgentCommand,
    root: &Path,
    prompt: &str,
    response_file: &Path,
    log_path: &Path,
    error_log_path: &Path,
    allow_resume: bool,
    allow_pdf_access: bool,
) -> AppResult<(i32, String, String, Option<String>, String)> {
    let args = if task.provider == "claude-code" {
        claude_args(task, root, allow_resume, allow_pdf_access)
    } else {
        codex_args(
            task,
            root,
            response_file,
            None,
            allow_resume,
            allow_pdf_access,
        )
    };
    let (exit_code, stdout, stderr) = run_agent_command(
        resolved,
        &args,
        Some(prompt),
        root,
        log_path,
        error_log_path,
    )?;
    let (session_id, content) = if task.provider == "claude-code" {
        parse_claude_output(&stdout)
    } else {
        parse_codex_output(&stdout, response_file)
    };
    if task.provider == "claude-code" {
        write_agent_response_file(response_file, &content)?;
    }
    Ok((exit_code, stdout, stderr, session_id, content))
}

fn python_command_candidates() -> Vec<ResolvedAgentCommand> {
    let mut candidates = Vec::new();
    candidates.push(ResolvedAgentCommand {
        command: PathBuf::from("python"),
        args_prefix: Vec::new(),
        source: PathBuf::from("python"),
    });
    candidates.push(ResolvedAgentCommand {
        command: PathBuf::from("py"),
        args_prefix: vec!["-3".to_string()],
        source: PathBuf::from("py -3"),
    });
    candidates
}

fn run_sparse_retrieval(
    root: &Path,
    base: &Path,
    task: &BridgeTask,
    planner: &Value,
) -> AppResult<Value> {
    let script = root
        .join("retrieval-adapter")
        .join("paperqa_sparse_retrieve.py");
    if !script.exists() {
        return Err(format!(
            "Sparse retrieval adapter not found: {}",
            script.to_string_lossy()
        ));
    }
    let queries = planner
        .get("retrievalQueries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let input = json!({
        "documentId": &task.document_id,
        "englishQuestion": json_string(planner, "englishQuestion"),
        "queries": queries,
        "pages": task.payload.get("pages").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
        "cacheDir": base.join("retrieval-cache").to_string_lossy().to_string(),
        "chunkSize": 1100,
        "overlap": 220,
        "maxChunks": 6,
    });
    let work_dir = base.join("retrieval");
    fs::create_dir_all(&work_dir).map_err(|error| error.to_string())?;
    let input_path = work_dir.join(format!("{}.retrieval.input.json", task.id));
    let output_path = work_dir.join(format!("{}.retrieval.output.json", task.id));
    write_json_file(&input_path, &input)?;

    let mut last_error = String::new();
    for resolved in python_command_candidates() {
        let mut command = Command::new(&resolved.command);
        command
            .args(&resolved.args_prefix)
            .arg(&script)
            .arg("--input")
            .arg(&input_path)
            .arg("--output")
            .arg(&output_path)
            .current_dir(root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        match command.output() {
            Ok(output) if output.status.success() => {
                let raw = fs::read_to_string(&output_path).map_err(|error| error.to_string())?;
                return serde_json::from_str::<Value>(&raw).map_err(|error| error.to_string());
            }
            Ok(output) => {
                last_error = decode_process_bytes(&output.stderr);
                if last_error.trim().is_empty() {
                    last_error = decode_process_bytes(&output.stdout);
                }
            }
            Err(error) => {
                last_error = error.to_string();
            }
        }
    }
    Err(format!("Sparse retrieval failed: {last_error}"))
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

fn collect_claude_error(value: &Value) -> Option<String> {
    if let Some(error) = value.get("error") {
        if let Some(message) = error.get("message").and_then(Value::as_str) {
            return Some(message.to_string());
        }
        if let Some(message) = error.as_str() {
            return Some(message.to_string());
        }
    }
    if let Some(message) = value.get("message").and_then(Value::as_str) {
        return Some(message.to_string());
    }
    if let Some(detail) = value.get("detail").and_then(Value::as_str) {
        return Some(detail.to_string());
    }
    None
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
    let mut errors = Vec::new();
    let mut parsed_any = false;
    for event in stdout.lines().map(str::trim).filter_map(|line| {
        if line.is_empty() {
            return None;
        }
        serde_json::from_str::<Value>(line).ok()
    }) {
        parsed_any = true;
        if event.get("type").and_then(Value::as_str) == Some("system")
            && event.get("subtype").and_then(Value::as_str) == Some("init")
        {
            session_id = event
                .get("session_id")
                .and_then(Value::as_str)
                .map(ToString::to_string);
        }
        if session_id.is_none() {
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
        if let Some(text) = event.get("result").and_then(Value::as_str) {
            result = text.to_string();
        }
        if result.trim().is_empty() {
            if let Some(structured) = event.get("structured_output") {
                result = serde_json::to_string_pretty(structured).unwrap_or_default();
            }
        }
        let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
        let subtype = event.get("subtype").and_then(Value::as_str).unwrap_or("");
        if event_type == "error"
            || (event_type == "result" && !matches!(subtype, "" | "success" | "init"))
            || (result.trim().is_empty() && event.get("error").is_some())
        {
            if let Some(message) = collect_claude_error(&event) {
                errors.push(readable_agent_error(&message));
            }
        }
    }

    if !parsed_any {
        if let Ok(event) = serde_json::from_str::<Value>(stdout.trim()) {
            session_id = event
                .get("session_id")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            if let Some(text) = event.get("result").and_then(Value::as_str) {
                result = text.to_string();
            } else if let Some(structured) = event.get("structured_output") {
                result = serde_json::to_string_pretty(structured).unwrap_or_default();
            }
            if let Some(message) = collect_claude_error(&event) {
                errors.push(readable_agent_error(&message));
            }
        }
    }

    let content = result.trim().to_string();
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

fn write_agent_response_file(path: &Path, content: &str) -> AppResult<()> {
    if content.trim().is_empty() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, content).map_err(|error| error.to_string())
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

fn write_agent_progress(base: &Path, task: &BridgeTask, metadata: Value) -> AppResult<()> {
    let inbox_file = base.join("inbox").join(format!("{}.json", task.id));
    write_json_file(&inbox_file, &metadata)
}

fn run_planned_chat_task(
    root: &Path,
    base: &Path,
    task_file: &Path,
    task: &BridgeTask,
    resolved: &ResolvedAgentCommand,
    final_log_path: &Path,
) -> AppResult<Value> {
    let requested_mode = task_ask_mode(task);
    let forced_mode = if requested_mode == "fast" {
        Some("fast")
    } else {
        None
    };
    let original_question = task_payload_string(task, "question");
    let plan_response_file = base
        .join("logs")
        .join(format!("{}.planner.response.md", task.id));
    let plan_log_path = base
        .join("logs")
        .join(format!("{}.planner.out.log", task.id));
    let plan_error_log_path = base
        .join("logs")
        .join(format!("{}.planner.err.log", task.id));
    let plan_prompt = planner_prompt(task, forced_mode);
    let (plan_exit_code, _plan_stdout, plan_stderr, _plan_session_id, plan_content) =
        run_agent_stage(
            task,
            resolved,
            root,
            &plan_prompt,
            &plan_response_file,
            &plan_log_path,
            &plan_error_log_path,
            false,
            false,
        )?;
    if plan_content.trim().is_empty() {
        let message = if plan_stderr.trim().is_empty() {
            format!("Planner exited with code {plan_exit_code} and returned no JSON.")
        } else {
            plan_stderr
        };
        let metadata = json!({
            "id": &task.id,
            "taskType": &task.task_type,
            "documentId": &task.document_id,
            "provider": &task.provider,
            "model": &task.model,
            "providerSessionId": &task.provider_session_id,
            "status": "failed",
            "output": message,
            "payload": {
                "askMode": requested_mode,
                "provider": &task.provider,
                "model": &task.model,
                "plannerExitCode": plan_exit_code,
                "plannerLogPath": plan_log_path,
                "plannerErrorLogPath": plan_error_log_path,
                "finalLogPath": final_log_path,
            },
            "savedAt": now(),
        });
        finish_agent_task(base, task_file, task, metadata.clone())?;
        return Ok(metadata);
    }
    let planner = normalize_planner_result(
        extract_json_object(&plan_content)?,
        forced_mode,
        &original_question,
    );
    let english_question = json_string(&planner, "englishQuestion");
    let planned_mode = json_string(&planner, "mode");
    let progress_output = if planned_mode == "deep" {
        "Deep is checking the original PDF."
    } else {
        "Fast Answer is retrieving page evidence."
    };
    write_agent_progress(
        base,
        task,
        json!({
            "id": &task.id,
            "taskType": &task.task_type,
            "documentId": &task.document_id,
            "provider": &task.provider,
            "model": &task.model,
            "providerSessionId": &task.provider_session_id,
            "status": "pending",
            "output": progress_output,
            "payload": {
                "askMode": &planned_mode,
                "requestedAskMode": &requested_mode,
                "planner": planner.clone(),
                "englishQuestion": &english_question,
                "originalQuestion": &original_question,
                "provider": &task.provider,
                "model": &task.model,
                "stage": "planned",
                "plannerLogPath": plan_log_path,
                "plannerErrorLogPath": plan_error_log_path,
                "finalLogPath": final_log_path,
            },
            "savedAt": now(),
        }),
    )?;
    if planned_mode == "deep" {
        let deep_response_file = base
            .join("logs")
            .join(format!("{}.deep.response.md", task.id));
        let deep_log_path = base.join("logs").join(format!("{}.deep.out.log", task.id));
        let deep_error_log_path = base.join("logs").join(format!("{}.deep.err.log", task.id));
        let prompt = direct_deep_prompt(task, &english_question, &original_question);
        let (exit_code, stdout, stderr, new_session_id, content) = run_agent_stage(
            task,
            resolved,
            root,
            &prompt,
            &deep_response_file,
            &deep_log_path,
            &deep_error_log_path,
            true,
            true,
        )?;
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
            if stderr.trim().is_empty() {
                format!(
                    "{} exited with code {exit_code} and returned no assistant message.",
                    task.provider
                )
            } else {
                stderr
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
                "askMode": "deep",
                "requestedAskMode": requested_mode,
                "planner": planner,
                "englishQuestion": english_question,
                "originalQuestion": original_question,
                "provider": &task.provider,
                "model": &task.model,
                "exitCode": exit_code,
                "plannerLogPath": plan_log_path,
                "plannerErrorLogPath": plan_error_log_path,
                "logPath": deep_log_path,
                "errorLogPath": deep_error_log_path,
                "finalLogPath": final_log_path,
                "responseFile": deep_response_file,
            },
            "savedAt": now(),
        });
        finish_agent_task(base, task_file, task, metadata.clone())?;
        return Ok(metadata);
    }

    let retrieval = run_sparse_retrieval(root, base, task, &planner)?;
    let answer_response_file = base
        .join("logs")
        .join(format!("{}.fast-answer.response.md", task.id));
    let answer_log_path = base
        .join("logs")
        .join(format!("{}.fast-answer.out.log", task.id));
    let answer_error_log_path = base
        .join("logs")
        .join(format!("{}.fast-answer.err.log", task.id));
    let answer_prompt = fast_answer_prompt(&planner, &retrieval, &original_question);
    let (answer_exit_code, answer_stdout, answer_stderr, new_session_id, answer_content) =
        run_agent_stage(
            task,
            resolved,
            root,
            &answer_prompt,
            &answer_response_file,
            &answer_log_path,
            &answer_error_log_path,
            false,
            false,
        )?;
    let provider_session_id = new_session_id.or(task.provider_session_id.clone());
    let parsed_answer = extract_json_object(&answer_content).unwrap_or_else(|_| {
        json!({
            "answerMarkdown": answer_content,
            "evidenceSufficient": true,
        })
    });
    let answer_markdown = json_string(&parsed_answer, "answerMarkdown");
    let evidence_sufficient = parsed_answer
        .get("evidenceSufficient")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let saw_agent_error_event = task.provider == "codex-cli"
        && answer_stdout.lines().any(|line| {
            line.contains("\"type\":\"error\"") || line.contains("\"type\":\"turn.failed\"")
        });
    let status = if answer_exit_code == 0 && !answer_markdown.trim().is_empty() {
        "complete"
    } else if !answer_markdown.trim().is_empty() && !saw_agent_error_event {
        "partial"
    } else {
        "failed"
    };
    let output = if answer_markdown.trim().is_empty() {
        if answer_stderr.trim().is_empty() {
            format!(
                "{} exited with code {answer_exit_code} and returned no fast answer.",
                task.provider
            )
        } else {
            answer_stderr
        }
    } else {
        answer_markdown
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
            "askMode": "fast",
            "requestedAskMode": requested_mode,
            "planner": planner,
            "retrieval": retrieval,
            "englishQuestion": english_question,
            "originalQuestion": original_question,
            "evidenceSufficient": evidence_sufficient,
            "provider": &task.provider,
            "model": &task.model,
            "exitCode": answer_exit_code,
            "plannerLogPath": plan_log_path,
            "plannerErrorLogPath": plan_error_log_path,
            "logPath": answer_log_path,
            "errorLogPath": answer_error_log_path,
            "finalLogPath": final_log_path,
            "responseFile": answer_response_file,
        },
        "savedAt": now(),
    });
    finish_agent_task(base, task_file, task, metadata.clone())?;
    Ok(metadata)
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

    let ask_mode = task_ask_mode(&task);
    if task.task_type == "chatWithPaper" && (ask_mode == "auto" || ask_mode == "fast") {
        return run_planned_chat_task(root, base, task_file, &task, &resolved, final_log_path);
    }

    let args = if task.provider == "claude-code" {
        claude_args(&task, root, true, true)
    } else {
        codex_args(
            &task,
            root,
            &response_file,
            image_path.as_deref(),
            true,
            true,
        )
    };
    let stdin_prompt = agent_stdin_prompt(&task, image_path.as_deref());
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
    if task.provider == "claude-code" {
        write_agent_response_file(&response_file, &content)?;
    }
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
            "askMode": task_ask_mode(&task),
            "englishQuestion": task_payload_string(&task, "englishQuestion"),
            "originalQuestion": task_payload_string(&task, "originalQuestion"),
            "triggeredBy": task_payload_string(&task, "triggeredBy"),
            "parentResultId": task_payload_string(&task, "parentResultId"),
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
    fn bridge_task_with_ask_mode_and_session(
        ask_mode: &str,
        provider_session_id: Option<&str>,
    ) -> BridgeTask {
        BridgeTask {
            id: "task-test".to_string(),
            task_type: "chatWithPaper".to_string(),
            document_id: "doc-test".to_string(),
            provider: "codex-cli".to_string(),
            model: None,
            reasoning_effort: None,
            provider_session_id: provider_session_id.map(ToString::to_string),
            payload: json!({
                "askMode": ask_mode,
                "document": {
                    "filePath": "C:/papers/test.pdf"
                }
            }),
            created_at: now(),
            bridge_dir: "bridge".to_string(),
            file_path: "bridge/outbox/task-test.json".to_string(),
        }
    }

    fn bridge_task_with_ask_mode(ask_mode: &str) -> BridgeTask {
        bridge_task_with_ask_mode_and_session(ask_mode, None)
    }

    #[test]
    fn direct_chat_adds_pdf_access_args() {
        let task = bridge_task_with_ask_mode("direct");
        let mut args = Vec::new();
        push_codex_chat_source_access_args(&mut args, &task);
        assert_eq!(args, vec!["--add-dir".to_string(), "C:/papers".to_string()]);
    }

    #[test]
    fn extracts_json_from_fenced_agent_output() {
        let parsed = extract_json_object(
            "```json\n{\"mode\":\"fast\",\"englishQuestion\":\"What is it?\"}\n```",
        )
        .expect("fenced JSON should parse");
        assert_eq!(parsed["mode"], "fast");
        assert_eq!(parsed["englishQuestion"], "What is it?");
    }

    #[test]
    fn forced_fast_planner_result_adds_retrieval_query() {
        let normalized = normalize_planner_result(
            json!({
                "englishQuestion": "How does the method work?",
                "mode": "deep"
            }),
            Some("fast"),
            "fallback query",
        );
        assert_eq!(normalized["mode"], "fast");
        assert_eq!(normalized["englishQuestion"], "How does the method work?");
        assert_eq!(normalized["retrievalQueries"][0], "fallback query");
    }

    #[test]
    fn fast_codex_stage_does_not_add_pdf_access_args() {
        let task = bridge_task_with_ask_mode("fast");
        let args = codex_args(
            &task,
            Path::new("C:/workspace"),
            Path::new("C:/workspace/response.md"),
            None,
            false,
            false,
        );
        assert!(!args.iter().any(|arg| arg == "--add-dir"));
        assert!(args.iter().any(|arg| arg == "read-only"));
    }

    #[test]
    fn deep_codex_stage_resumes_existing_chat_session() {
        let session_id = "123e4567-e89b-12d3-a456-426614174000";
        let task = bridge_task_with_ask_mode_and_session("deep", Some(session_id));
        let args = codex_args(
            &task,
            Path::new("C:/workspace"),
            Path::new("C:/workspace/response.md"),
            None,
            true,
            true,
        );
        assert!(args
            .windows(3)
            .any(|window| window == ["resume", session_id, "-"]));
    }

    #[test]
    fn claude_args_use_read_only_non_interactive_mode() {
        let mut task = bridge_task_with_ask_mode("deep");
        task.provider = "claude-code".to_string();
        let args = claude_args(&task, Path::new("C:/workspace"), false, true);
        assert!(args
            .windows(2)
            .any(|window| window == ["--permission-mode", "dontAsk"]));
        assert!(args
            .windows(2)
            .any(|window| window == ["--tools", "Read,Glob,Grep"]));
        assert!(args
            .windows(2)
            .any(|window| window == ["--allowedTools", "Read,Glob,Grep"]));
        assert!(args.iter().any(|arg| arg == "--strict-mcp-config"));
        assert!(args.windows(2).any(|window| window == ["--max-turns", "8"]));
        assert!(!args.iter().any(|arg| arg == "bypassPermissions"));
        assert!(!args.iter().any(|arg| arg == "Bash"));
    }

    #[test]
    fn claude_args_resume_existing_chat_session() {
        let session_id = "claude-session-123";
        let mut task = bridge_task_with_ask_mode_and_session("deep", Some(session_id));
        task.provider = "claude-code".to_string();
        let args = claude_args(&task, Path::new("C:/workspace"), true, true);
        assert!(args
            .windows(2)
            .any(|window| window == ["--resume", session_id]));
    }

    #[test]
    fn parse_claude_stream_json_prefers_final_result() {
        let stdout = r#"{"type":"system","subtype":"init","session_id":"session-1"}
{"type":"assistant","message":{"content":[{"type":"text","text":"intermediate"}]}}
{"type":"result","subtype":"success","session_id":"session-1","result":"final answer"}"#;
        let (session_id, content) = parse_claude_output(stdout);
        assert_eq!(session_id.as_deref(), Some("session-1"));
        assert_eq!(content, "final answer");
    }

    #[test]
    fn parse_claude_single_json_output() {
        let stdout =
            r#"{"session_id":"session-json","result":"json answer","total_cost_usd":0.01}"#;
        let (session_id, content) = parse_claude_output(stdout);
        assert_eq!(session_id.as_deref(), Some("session-json"));
        assert_eq!(content, "json answer");
    }

    #[test]
    fn parse_claude_result_error_message() {
        let stdout = r#"{"type":"result","subtype":"error","error":{"message":"not logged in"}}"#;
        let (_session_id, content) = parse_claude_output(stdout);
        assert_eq!(content, "not logged in");
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
            upsert_pages,
            get_agent_provider_status,
            export_document_json,
            export_document_zip,
            delete_ai_results,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
