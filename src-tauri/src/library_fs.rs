use super::{
    now, row_document, sanitize_file_name, sha256_hex, AppResult, DocumentRecord, FolderRecord,
};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

pub fn folder_id(path: &Path) -> String {
    format!(
        "source-folder:{}",
        sha256_hex(path.to_string_lossy().as_bytes())
    )
}

// An explicit open from Finder or the file picker is the best evidence of the
// location the reader is using, even when another copy still exists.
pub fn remember_opened_source(
    conn: &Connection,
    document: &mut DocumentRecord,
    path: &Path,
    documents_dir: &Path,
) -> AppResult<()> {
    let source = path.to_string_lossy().into_owned();
    if document.source_path.as_deref() == Some(source.as_str()) && document.file_path == source {
        return Ok(());
    }
    let previous = PathBuf::from(&document.file_path);
    conn.execute(
        "UPDATE documents SET source_path = ?2, file_path = ?2 WHERE id = ?1",
        params![document.id, source],
    )
    .map_err(|error| error.to_string())?;
    document.source_path = Some(source.clone());
    document.file_path = source;
    document.folder_id = path.parent().map(folder_id);
    if previous != path
        && previous.starts_with(documents_dir)
        && file_hash(&previous).as_deref() == Some(document.hash.as_str())
    {
        let _ = fs::remove_file(previous);
    }
    Ok(())
}

pub fn register_linked_pdf(
    conn: &Connection,
    path: &Path,
    hash: &str,
    documents_dir: &Path,
) -> AppResult<DocumentRecord> {
    if path.starts_with(documents_dir) {
        return Err("앱 내부의 예전 사본 대신 원본 PDF를 선택해 주세요.".into());
    }
    let source = path.to_string_lossy().into_owned();
    let select = "SELECT id, title, file_name, file_path, hash, page_count, authors, year, abstract_text, folder_id, bookmarked, created_at, updated_at, source_path FROM documents";
    let by_path = conn
        .query_row(
            &format!("{select} WHERE source_path = ?1 OR file_path = ?1 LIMIT 1"),
            params![source],
            row_document,
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let existing = if by_path.is_some() {
        by_path
    } else {
        conn.query_row(
            &format!("{select} WHERE hash = ?1 LIMIT 1"),
            params![hash],
            row_document,
        )
        .optional()
        .map_err(|error| error.to_string())?
    };
    if let Some(mut document) = existing {
        remember_opened_source(conn, &mut document, path, documents_dir)?;
        if document.hash != hash {
            conn.execute(
                "UPDATE documents SET hash = ?2, page_count = 0 WHERE id = ?1",
                params![document.id, hash],
            )
            .map_err(|error| error.to_string())?;
            conn.execute(
                "DELETE FROM pages WHERE document_id = ?1",
                params![document.id],
            )
            .map_err(|error| error.to_string())?;
            for prefix in [
                "pdfTextExtractionVersion:",
                "documentOutlineVersion:",
                "pageTextLayoutAiVersion:",
            ] {
                conn.execute(
                    "DELETE FROM settings WHERE key = ?1",
                    params![format!("{prefix}{}", document.id)],
                )
                .map_err(|error| error.to_string())?;
            }
            for prefix in [
                "pageTextLayout:",
                "pageTextLayoutConfidence:",
                "pageTextLayoutSource:",
            ] {
                conn.execute(
                    "DELETE FROM settings WHERE key LIKE ?1",
                    params![format!("{prefix}{}:%", document.id)],
                )
                .map_err(|error| error.to_string())?;
            }
            document.hash = hash.to_string();
            document.page_count = 0;
        }
        return Ok(document);
    }
    let id = uuid::Uuid::new_v4().to_string();
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("Invalid PDF file name: {}", path.display()))?;
    let file_name = sanitize_file_name(file_name);
    let timestamp = now();
    let document = DocumentRecord {
        id,
        title: file_name.trim_end_matches(".pdf").replace('_', " "),
        file_name,
        file_path: source.clone(),
        source_path: Some(source),
        hash: hash.to_string(),
        page_count: 0,
        authors: String::new(),
        year: String::new(),
        abstract_text: String::new(),
        folder_id: path.parent().map(folder_id),
        bookmarked: false,
        created_at: timestamp.clone(),
        updated_at: timestamp,
    };
    conn.execute(
        "INSERT INTO documents (id,title,file_name,file_path,source_path,hash,page_count,authors,year,abstract_text,folder_id,bookmarked,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
        params![document.id, document.title, document.file_name, document.file_path, document.source_path,
            document.hash, document.page_count, document.authors, document.year, document.abstract_text,
            document.folder_id, 0, document.created_at, document.updated_at],
    ).map_err(|error| error.to_string())?;
    Ok(document)
}

// Downloads do not constitute an explicit relocation of an existing original.
// Check and register in one write transaction, including imports racing in
// another window while the download was in progress.
pub fn register_downloaded_pdf(
    conn: &mut Connection,
    path: &Path,
    hash: &str,
    documents_dir: &Path,
) -> AppResult<(DocumentRecord, bool)> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let select = "SELECT id,title,file_name,file_path,hash,page_count,authors,year,abstract_text,folder_id,bookmarked,created_at,updated_at,source_path FROM documents";
    let existing = tx.query_row(&format!("{select} WHERE hash=?1 LIMIT 1"), [hash], row_document)
        .optional().map_err(|error| error.to_string())?;
    if let Some(document) = existing { return Ok((document, false)); }
    let path_used: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM documents WHERE source_path=?1 OR file_path=?1)", [path.to_string_lossy().as_ref()], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if path_used { return Err("이 저장 경로는 기존 논문에 연결되어 있습니다. 다른 이름을 사용해 주세요.".into()); }
    let document = register_linked_pdf(&tx, path, hash, documents_dir)?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok((document, true))
}

pub fn migrate_stored_sources(conn: &Connection, documents_dir: &Path) -> AppResult<()> {
    let mut stmt = conn.prepare(
        "SELECT id, title, file_name, file_path, hash, page_count, authors, year, abstract_text, folder_id, bookmarked, created_at, updated_at, source_path
         FROM documents WHERE source_path IS NOT NULL AND file_path != source_path",
    ).map_err(|error| error.to_string())?;
    let documents = stmt
        .query_map([], row_document)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    for mut document in documents {
        let Some(source) = document.source_path.as_deref().map(PathBuf::from) else {
            continue;
        };
        if file_hash(&source).as_deref() == Some(document.hash.as_str()) {
            remember_opened_source(conn, &mut document, &source, documents_dir)?;
        }
    }
    Ok(())
}

// Display the smallest connected trees, stopping at ordinary storage locations.
// A lone paper shows only its own directory; related directories retain connectors.
fn visible_paths(parents: &BTreeSet<PathBuf>, home: &Path) -> BTreeSet<PathBuf> {
    let mut groups: BTreeMap<PathBuf, Vec<PathBuf>> = BTreeMap::new();
    for path in parents {
        let mut boundaries = vec![home.to_path_buf()];
        boundaries
            .extend(["Desktop", "Documents", "Downloads", "Library"].map(|name| home.join(name)));
        // Keep separate external volumes and other users' home directories separate.
        for base in [Path::new("/Volumes"), Path::new("/Users")] {
            if let Ok(relative) = path.strip_prefix(base) {
                if let Some(component) = relative.components().next() {
                    boundaries.push(base.join(component));
                }
            }
        }
        let boundary = boundaries
            .into_iter()
            .filter(|base| !base.as_os_str().is_empty() && path.starts_with(base))
            .max_by_key(|base| base.components().count())
            .unwrap_or_else(|| path.ancestors().last().unwrap_or(path).to_path_buf());
        let key = if parents.contains(&boundary) {
            boundary
        } else {
            path.strip_prefix(&boundary)
                .ok()
                .and_then(|relative| relative.components().next())
                .map(|component| boundary.join(component))
                .unwrap_or(boundary)
        };
        groups.entry(key).or_default().push(path.clone());
    }
    let mut visible = BTreeSet::new();
    for paths in groups.values() {
        let mut common = paths[0].clone();
        while !paths.iter().all(|path| path.starts_with(&common)) {
            if !common.pop() {
                break;
            }
        }
        for path in paths {
            for ancestor in path.ancestors() {
                visible.insert(ancestor.to_path_buf());
                if ancestor == common {
                    break;
                }
            }
        }
    }
    visible
}

pub fn append_source_folders(
    folders: &mut Vec<FolderRecord>,
    documents: &[DocumentRecord],
    home: &Path,
) {
    let mut retained = BTreeSet::from(["root".to_string()]);
    for document in documents
        .iter()
        .filter(|document| document.source_path.is_none())
    {
        let mut cursor = document.folder_id.as_deref();
        while let Some(id) = cursor {
            if !retained.insert(id.to_string()) {
                break;
            }
            cursor = folders
                .iter()
                .find(|folder| folder.id == id)
                .and_then(|folder| folder.parent_id.as_deref());
        }
    }
    folders.retain(|folder| retained.contains(&folder.id));
    let parents = documents
        .iter()
        .filter_map(|document| document.source_path.as_deref())
        .filter_map(|path| Path::new(path).parent().map(Path::to_path_buf))
        .collect();
    let paths = visible_paths(&parents, home);
    let timestamp = now();
    for path in &paths {
        folders.push(FolderRecord {
            id: folder_id(path),
            parent_id: Some(
                path.parent()
                    .filter(|parent| paths.contains(*parent))
                    .map(folder_id)
                    .unwrap_or_else(|| "root".into()),
            ),
            name: path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.display().to_string()),
            created_at: timestamp.clone(),
            source_path: Some(path.to_string_lossy().into_owned()),
        });
    }
}

fn file_hash(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = file.read(&mut buffer).ok()?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Some(format!("{:x}", hash.finalize()))
}

// Recover only already-imported PDFs. Size and content hash must both match;
// filenames alone are insufficient and unrelated PDFs are never imported.
#[cfg(test)]
pub fn recover_sources(conn: &Connection, home: &Path, app_data: &Path) -> AppResult<()> {
    let mut stmt = conn
        .prepare("SELECT id, hash, file_path, source_path FROM documents")
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut missing = BTreeMap::new();
    let mut directories = BTreeSet::new();
    for row in rows {
        let (id, hash, cached, source) = row.map_err(|error| error.to_string())?;
        if source
            .as_ref()
            .is_some_and(|path| Path::new(path).is_file())
        {
            continue;
        }
        if let Some(parent) = source.as_deref().and_then(|path| Path::new(path).parent()) {
            directories.insert(parent.to_path_buf());
        }
        if let Ok(metadata) = fs::metadata(cached) {
            missing.insert(id, (hash, metadata.len()));
        }
    }
    if missing.is_empty() {
        return Ok(());
    }
    // Search ordinary user folders, including custom research folders, but skip
    // application data, hidden folders, packages, symlinks and build outputs.
    directories.insert(home.to_path_buf());
    let mut pending: Vec<_> = directories.into_iter().collect();
    let mut visited = BTreeSet::new();
    let mut entries_seen = 0;
    while let Some(directory) = pending.pop() {
        if missing.is_empty() || entries_seen >= 100_000 {
            break;
        }
        if directory.starts_with(app_data) || !visited.insert(directory.clone()) {
            continue;
        }
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            entries_seen += 1;
            if entries_seen >= 100_000 {
                break;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if path.starts_with(app_data) || name.starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if !matches!(
                    name.as_str(),
                    "Library" | "node_modules" | "target" | "build" | "dist"
                ) && !["app", "photoslibrary", "bundle"].contains(
                    &path
                        .extension()
                        .and_then(|value| value.to_str())
                        .unwrap_or(""),
                ) {
                    pending.push(path);
                }
                continue;
            }
            if !kind.is_file()
                || !path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
            {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if !missing.values().any(|(_, size)| *size == metadata.len()) {
                continue;
            }
            let Some(hash) = file_hash(&path) else {
                continue;
            };
            let matches: Vec<_> = missing
                .iter()
                .filter(|(_, (expected, _))| *expected == hash)
                .map(|(id, _)| id.clone())
                .collect();
            for id in matches {
                let path = path.canonicalize().unwrap_or_else(|_| path.clone());
                conn.execute(
                    "UPDATE documents SET source_path = ?2 WHERE id = ?1",
                    params![id, path.to_string_lossy()],
                )
                .map_err(|error| error.to_string())?;
                missing.remove(&id);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(values: &[&str]) -> BTreeSet<PathBuf> {
        values.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn one_folder_omits_all_ancestors() {
        let input = paths(&["/Users/test/Research/projects/paper/references"]);
        assert_eq!(visible_paths(&input, Path::new("/Users/test")), input);
    }

    #[test]
    fn siblings_and_nested_papers_include_only_connecting_ancestors() {
        let input = paths(&[
            "/Users/test/Desktop/Research/A",
            "/Users/test/Desktop/Research/B/More",
        ]);
        assert_eq!(
            visible_paths(&input, Path::new("/Users/test")),
            paths(&[
                "/Users/test/Desktop/Research",
                "/Users/test/Desktop/Research/A",
                "/Users/test/Desktop/Research/B",
                "/Users/test/Desktop/Research/B/More",
            ])
        );
        let nested = paths(&["/Users/test/Research", "/Users/test/Research/A/B"]);
        assert_eq!(
            visible_paths(&nested, Path::new("/Users/test")),
            paths(&[
                "/Users/test/Research",
                "/Users/test/Research/A",
                "/Users/test/Research/A/B",
            ])
        );
    }

    #[test]
    fn unrelated_locations_and_same_named_folders_remain_separate() {
        let input = paths(&[
            "/Users/test/Downloads",
            "/Users/test/Research/references",
            "/Users/test/Teaching/references",
        ]);
        assert_eq!(visible_paths(&input, Path::new("/Users/test")), input);
        assert_ne!(
            folder_id(Path::new("/Users/test/Research/references")),
            folder_id(Path::new("/Users/test/Teaching/references"))
        );
    }

    #[test]
    fn recovery_matches_content_and_keeps_existing_document_data() {
        let root =
            std::env::temp_dir().join(format!("paper-pilot-source-test-{}", uuid::Uuid::new_v4()));
        let original = root.join("Research/한국어 폴더");
        let cache = root.join("Library/App/documents");
        fs::create_dir_all(&original).unwrap();
        fs::create_dir_all(&cache).unwrap();
        fs::write(original.join("renamed.pdf"), b"paper").unwrap();
        fs::write(original.join("same-size.pdf"), b"other").unwrap();
        fs::write(cache.join("cached.pdf"), b"paper").unwrap();
        let conn = Connection::open_in_memory().unwrap();
        super::super::migrate(&conn).unwrap();
        conn.execute("INSERT INTO documents (id,title,file_name,file_path,hash,created_at,updated_at) VALUES ('existing','Title','old.pdf',?1,?2,'before','before')",
            params![cache.join("cached.pdf").to_string_lossy(), sha256_hex(b"paper")]).unwrap();
        recover_sources(&conn, &root, &root.join("Library/App")).unwrap();
        let (source, title, timestamp): (String, String, String) = conn
            .query_row(
                "SELECT source_path,title,updated_at FROM documents WHERE id='existing'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            Path::new(&source),
            original.join("renamed.pdf").canonicalize().unwrap()
        );
        assert_eq!(title, "Title");
        assert_eq!(timestamp, "before");
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM documents", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        let library = super::super::load_library_from_db(&conn).unwrap();
        assert_eq!(library.folders.len(), 2);
        assert_eq!(
            library.documents[0].folder_id.as_deref(),
            Some(library.folders[1].id.as_str())
        );
        assert_eq!(library.folders[1].name, "한국어 폴더");
        fs::rename(original.join("renamed.pdf"), root.join("moved.pdf")).unwrap();
        recover_sources(&conn, &root, &root.join("Library/App")).unwrap();
        let moved = super::super::load_library_from_db(&conn).unwrap();
        assert_eq!(moved.documents.len(), 1);
        assert_eq!(
            Path::new(moved.documents[0].source_path.as_ref().unwrap()),
            root.join("moved.pdf").canonicalize().unwrap()
        );
        assert_eq!(moved.folders.len(), 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn opening_another_copy_moves_the_library_entry_to_that_folder() {
        let root =
            std::env::temp_dir().join(format!("paper-pilot-open-test-{}", uuid::Uuid::new_v4()));
        let downloads = root.join("Downloads");
        let papers = root.join("papers");
        fs::create_dir_all(&downloads).unwrap();
        fs::create_dir_all(&papers).unwrap();
        let old_path = downloads.join("paper.pdf");
        let new_path = papers.join("paper.pdf");
        fs::write(&old_path, b"same pdf").unwrap();
        fs::write(&new_path, b"same pdf").unwrap();
        let conn = Connection::open_in_memory().unwrap();
        super::super::migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO documents (id,title,file_name,file_path,hash,source_path,created_at,updated_at) VALUES ('existing','Paper','paper.pdf',?1,?2,?3,'before','before')",
            params![old_path.to_string_lossy(), sha256_hex(b"same pdf"), old_path.to_string_lossy()],
        ).unwrap();
        let mut document = super::super::load_library_from_db(&conn)
            .unwrap()
            .documents
            .remove(0);
        remember_opened_source(
            &conn,
            &mut document,
            &new_path,
            &root.join("Library/App/documents"),
        )
        .unwrap();
        assert!(old_path.is_file());
        assert_eq!(document.source_path.as_deref(), new_path.to_str());
        assert_eq!(document.file_path, new_path.to_string_lossy());
        let library = super::super::load_library_from_db(&conn).unwrap();
        assert_eq!(library.documents.len(), 1);
        assert_eq!(
            library.documents[0].folder_id.as_deref(),
            Some(folder_id(&papers).as_str())
        );
        assert!(library
            .folders
            .iter()
            .any(|folder| folder.source_path.as_deref() == papers.to_str()));
        assert!(!library
            .folders
            .iter()
            .any(|folder| folder.source_path.as_deref() == downloads.to_str()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn linked_import_keeps_one_document_and_never_copies_the_pdf() {
        let root =
            std::env::temp_dir().join(format!("paper-pilot-linked-test-{}", uuid::Uuid::new_v4()));
        let documents_dir = root.join("App/documents");
        let downloads = root.join("Downloads");
        let papers = root.join("papers");
        fs::create_dir_all(&downloads).unwrap();
        fs::create_dir_all(&papers).unwrap();
        let first = downloads.join("paper.pdf");
        let second = papers.join("paper.pdf");
        fs::write(&first, b"%PDF-same").unwrap();
        fs::write(&second, b"%PDF-same").unwrap();
        let conn = Connection::open_in_memory().unwrap();
        super::super::migrate(&conn).unwrap();
        let hash = sha256_hex(b"%PDF-same");
        let imported = register_linked_pdf(&conn, &first, &hash, &documents_dir).unwrap();
        assert_eq!(imported.file_path, first.to_string_lossy());
        assert!(!documents_dir.exists());
        let reopened = register_linked_pdf(&conn, &second, &hash, &documents_dir).unwrap();
        assert_eq!(imported.id, reopened.id);
        assert_eq!(reopened.file_path, second.to_string_lossy());
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM documents", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(!documents_dir.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn migration_preserves_notes_and_removes_only_verified_app_copy() {
        let root =
            std::env::temp_dir().join(format!("paper-pilot-migrate-test-{}", uuid::Uuid::new_v4()));
        let documents_dir = root.join("App/documents");
        fs::create_dir_all(&documents_dir).unwrap();
        let original = root.join("paper.pdf");
        let cached = documents_dir.join("cached.pdf");
        fs::write(&original, b"%PDF-paper").unwrap();
        fs::write(&cached, b"%PDF-paper").unwrap();
        let conn = Connection::open_in_memory().unwrap();
        super::super::migrate(&conn).unwrap();
        conn.execute("INSERT INTO documents (id,title,file_name,file_path,source_path,hash,created_at,updated_at) VALUES ('existing','Paper','paper.pdf',?1,?2,?3,'before','before')",
            params![cached.to_string_lossy(), original.to_string_lossy(), sha256_hex(b"%PDF-paper")]).unwrap();
        conn.execute("INSERT INTO notes (id,document_id,markdown,updated_at) VALUES ('note','existing','keep me','before')", []).unwrap();
        migrate_stored_sources(&conn, &documents_dir).unwrap();
        let library = super::super::load_library_from_db(&conn).unwrap();
        assert_eq!(library.documents[0].id, "existing");
        assert_eq!(library.documents[0].file_path, original.to_string_lossy());
        assert!(!cached.exists());
        assert_eq!(
            conn.query_row("SELECT markdown FROM notes WHERE id='note'", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap(),
            "keep me"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn migration_keeps_cached_copy_when_original_has_changed() {
        let root =
            std::env::temp_dir().join(format!("paper-pilot-changed-test-{}", uuid::Uuid::new_v4()));
        let documents_dir = root.join("App/documents");
        fs::create_dir_all(&documents_dir).unwrap();
        let original = root.join("paper.pdf");
        let cached = documents_dir.join("cached.pdf");
        fs::write(&original, b"%PDF-new-version").unwrap();
        fs::write(&cached, b"%PDF-annotated-version").unwrap();
        let conn = Connection::open_in_memory().unwrap();
        super::super::migrate(&conn).unwrap();
        conn.execute("INSERT INTO documents (id,title,file_name,file_path,source_path,hash,created_at,updated_at) VALUES ('existing','Paper','paper.pdf',?1,?2,?3,'before','before')",
            params![cached.to_string_lossy(), original.to_string_lossy(), sha256_hex(b"%PDF-annotated-version")]).unwrap();
        migrate_stored_sources(&conn, &documents_dir).unwrap();
        let document = super::super::load_library_from_db(&conn)
            .unwrap()
            .documents
            .remove(0);
        assert_eq!(document.file_path, cached.to_string_lossy());
        assert!(cached.is_file());
        fs::remove_dir_all(root).unwrap();
    }
}
