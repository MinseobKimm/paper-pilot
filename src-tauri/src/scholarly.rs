//! Desktop scholarly lookup. All network traffic stays outside the webview.
use super::*;
use quick_xml::de::from_str;
use regex::Regex;
use reqwest::blocking::Client;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, OnceLock,
};
use std::time::{Duration, Instant};

const PAGE_SIZE: usize = 20;
const CACHE_SECONDS: i64 = 86400;
const DOC_SELECT: &str = "SELECT id,title,file_name,file_path,hash,page_count,authors,year,abstract_text,folder_id,bookmarked,created_at,updated_at,source_path FROM documents";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScholarlyPaper {
    pub title: String,
    pub authors: String,
    pub year: String,
    pub abstract_text: String,
    pub arxiv_id: String,
    pub version: Option<u32>,
    pub doi: String,
    pub open_alex_id: String,
    pub categories: Vec<String>,
    pub published: String,
    pub updated: String,
    pub journal_ref: String,
    pub url: String,
    pub pdf_url: String,
    pub source: String,
    pub cited_by_count: Option<u64>,
    pub referenced_works: Vec<String>,
    pub related_works: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentScholarlyProfile {
    pub document_id: String,
    pub paper: ScholarlyPaper,
    pub local_version: Option<u32>,
    pub fetched_at: String,
    #[serde(default)]
    pub arxiv_fetched_at: String,
    #[serde(default)]
    pub open_alex_fetched_at: String,
    pub confirmed_fields: Vec<String>,
    #[serde(default)]
    pub enrichment_error: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperMatchCandidate {
    pub paper: ScholarlyPaper,
    pub evidence: String,
    pub identifier_match: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperPage {
    pub papers: Vec<ScholarlyPaper>,
    pub total: usize,
    pub page: usize,
    pub fetched_at: String,
    pub stale: bool,
    pub notice: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub query: String,
    pub category: String,
    pub from: String,
    pub at: String,
    pub sort: String,
    pub page: usize,
    pub request_id: String,
    #[serde(default)]
    pub refresh: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedIdentity {
    pub document_id: String,
    pub arxiv_id: String,
    pub local_version: Option<u32>,
    pub open_alex_id: String,
}

#[derive(Deserialize, Default)]
struct AtomFeed {
    #[serde(default, rename = "entry")]
    entries: Vec<AtomEntry>,
    #[serde(default, rename = "totalResults")]
    total: usize,
}
#[derive(Deserialize, Default)]
struct AtomEntry {
    #[serde(default)]
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    published: String,
    #[serde(default)]
    updated: String,
    #[serde(default, rename = "author")]
    authors: Vec<AtomAuthor>,
    #[serde(default, rename = "category")]
    categories: Vec<AtomCategory>,
    #[serde(default)]
    doi: String,
    #[serde(default)]
    journal_ref: String,
}
#[derive(Deserialize)]
struct AtomAuthor {
    name: String,
}
#[derive(Deserialize)]
struct AtomCategory {
    #[serde(rename = "@term")]
    term: String,
}
fn compact(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}
pub fn arxiv_identity(raw: &str) -> Option<(String, Option<u32>)> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i)^(?:arxiv:\s*|https?://(?:export\.)?arxiv\.org/(?:abs|pdf)/)?((?:\d{4}\.\d{4,5}|[a-z][a-z0-9.-]*(?:\.[a-z]{2})?/\d{7}))(?:v(\d+))?(?:\.pdf)?(?:[?#].*)?$").unwrap());
    let caps = re.captures(raw.trim())?;
    Some((
        caps[1].to_lowercase(),
        caps.get(2)
            .and_then(|v| v.as_str().parse().ok())
            .filter(|v| *v > 0),
    ))
}
fn filename_identity(file_name: &str) -> Option<(String, Option<u32>)> {
    static COPY: OnceLock<Regex> = OnceLock::new();
    static PREFIX: OnceLock<Regex> = OnceLock::new();
    let name = file_name.trim();
    let name = if name.to_ascii_lowercase().ends_with(".pdf") {
        &name[..name.len() - 4]
    } else {
        name
    };
    let name = COPY
        .get_or_init(|| Regex::new(r"(?:\s*\(\d+\)|_+\d+_)$").unwrap())
        .replace(name, "");
    let name = PREFIX
        .get_or_init(|| Regex::new(r"(?i)^arxiv[\s:_-]*").unwrap())
        .replace(&name, "");
    if name.to_ascii_lowercase().ends_with("v0") {
        return None;
    }
    arxiv_identity(&name.replace('_', "/"))
}
fn versioned_id(paper: &ScholarlyPaper) -> String {
    format!(
        "{}{}",
        paper.arxiv_id,
        paper.version.map(|v| format!("v{v}")).unwrap_or_default()
    )
}
fn parse_atom(xml: &str) -> AppResult<(Vec<ScholarlyPaper>, usize)> {
    let mut reader = quick_xml::Reader::from_str(xml);
    loop {
        match reader
            .read_event()
            .map_err(|_| "arXiv XML 응답 오류".to_string())?
        {
            quick_xml::events::Event::Start(e) | quick_xml::events::Event::Empty(e) => {
                if e.local_name().as_ref() != b"feed" {
                    return Err("arXiv Atom 응답이 아닙니다.".into());
                }
                break;
            }
            quick_xml::events::Event::Eof => return Err("빈 arXiv 응답".into()),
            _ => {}
        }
    }
    let feed: AtomFeed =
        from_str(xml).map_err(|_| "arXiv 응답을 해석할 수 없습니다.".to_string())?;
    let mut papers = Vec::new();
    for e in feed.entries {
        let (id, version) =
            arxiv_identity(&e.id).ok_or_else(|| format!("arXiv 오류: {}", compact(&e.summary)))?;
        let full = format!(
            "{id}{}",
            version.map(|v| format!("v{v}")).unwrap_or_default()
        );
        papers.push(ScholarlyPaper {
            title: compact(&e.title),
            authors: e
                .authors
                .iter()
                .map(|a| a.name.clone())
                .collect::<Vec<_>>()
                .join(", "),
            year: e.published.get(..4).unwrap_or_default().into(),
            abstract_text: compact(&e.summary),
            arxiv_id: id,
            version,
            doi: clean_doi(&e.doi),
            categories: e.categories.into_iter().map(|c| c.term).collect(),
            published: e.published,
            updated: e.updated,
            journal_ref: compact(&e.journal_ref),
            url: format!("https://arxiv.org/abs/{full}"),
            pdf_url: format!("https://arxiv.org/pdf/{full}"),
            source: "arXiv".into(),
            ..Default::default()
        });
    }
    papers.truncate(PAGE_SIZE);
    Ok((papers, feed.total))
}
fn clean_doi(value: &str) -> String {
    value
        .trim()
        .trim_start_matches("https://doi.org/")
        .trim_start_matches("http://doi.org/")
        .trim_start_matches("doi:")
        .trim_end_matches(['.', ',', ';', ')', ']'])
        .to_lowercase()
}
pub fn migrate(conn: &Connection) -> AppResult<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS scholarly_profiles (
        document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
        arxiv_id TEXT NOT NULL, local_version INTEGER, openalex_id TEXT NOT NULL, json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS scholarly_cache (key TEXT PRIMARY KEY, body TEXT NOT NULL, fetched_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS scholarly_scans (id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS scholarly_scan_items (
        scan_id TEXT NOT NULL REFERENCES scholarly_scans(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, status TEXT NOT NULL, candidates TEXT NOT NULL DEFAULT '[]', error TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(scan_id,document_id));").map_err(|e| e.to_string())
}
pub fn profile(
    conn: &Connection,
    document_id: &str,
) -> AppResult<Option<DocumentScholarlyProfile>> {
    let data: Option<String> = conn
        .query_row(
            "SELECT json FROM scholarly_profiles WHERE document_id=?1",
            [document_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    data.map(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
        .transpose()
}
fn save_profile(conn: &Connection, profile: &DocumentScholarlyProfile) -> AppResult<()> {
    conn.execute("INSERT INTO scholarly_profiles(document_id,arxiv_id,local_version,openalex_id,json) VALUES (?1,?2,?3,?4,?5)
        ON CONFLICT(document_id) DO UPDATE SET arxiv_id=excluded.arxiv_id,local_version=excluded.local_version,openalex_id=excluded.openalex_id,json=excluded.json",
        params![profile.document_id, profile.paper.arxiv_id, profile.local_version, profile.paper.open_alex_id, serde_json::to_string(profile).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
    Ok(())
}
struct Operation(Arc<AtomicBool>);
static OPERATIONS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
fn operations() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    OPERATIONS.get_or_init(Default::default)
}
impl Operation {
    fn new(id: &str) -> AppResult<Self> {
        let flag = Arc::new(AtomicBool::new(false));
        let flag = operations()
            .lock()
            .map_err(|e| e.to_string())?
            .entry(id.into())
            .or_insert(flag)
            .clone();
        Ok(Self(flag))
    }
    fn check(&self) -> AppResult<()> {
        if self.0.load(Ordering::Relaxed) {
            Err("CANCELLED".into())
        } else {
            Ok(())
        }
    }
    fn wait(&self, duration: Duration) -> AppResult<()> {
        let end = Instant::now() + duration;
        while Instant::now() < end {
            self.check()?;
            std::thread::sleep(
                Duration::from_millis(75).min(end.saturating_duration_since(Instant::now())),
            );
        }
        self.check()
    }
}
struct OperationGuard {
    id: String,
    op: Operation,
}
impl OperationGuard {
    fn new(id: &str) -> AppResult<Self> {
        Ok(Self {
            id: id.into(),
            op: Operation::new(id)?,
        })
    }
}
impl Drop for OperationGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = operations().lock() {
            map.remove(&self.id);
        }
    }
}
#[tauri::command]
pub fn scholarly_cancel(request_id: String) {
    if let Ok(mut map) = operations().lock() {
        if map.len() > 512 {
            map.retain(|_, flag| Arc::strong_count(flag) > 1);
        }
        map.entry(request_id)
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .store(true, Ordering::Relaxed);
    }
}
fn client() -> AppResult<Client> {
    Client::builder()
        .user_agent("PaperPilot/0.1 (personal desktop research reader)")
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|_| "HTTP 클라이언트 초기화 실패".into())
}
// Keep the connection lock until the response has been read, across every arXiv consumer.
static ARXIV_QUEUE: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
fn get_body(
    app: &AppHandle,
    url: &str,
    arxiv: bool,
    refresh: bool,
    op: &Operation,
) -> AppResult<(String, String, bool)> {
    cached_body(
        || open_db(app),
        url,
        arxiv,
        refresh,
        op,
        || fetch_body(url, arxiv, op),
    )
}
fn cached_body(
    open: impl Fn() -> AppResult<Connection>,
    url: &str,
    arxiv: bool,
    refresh: bool,
    op: &Operation,
    fetch: impl FnOnce() -> AppResult<String>,
) -> AppResult<(String, String, bool)> {
    op.check()?;
    let conn = open()?;
    let cached: Option<(String, String)> = conn
        .query_row(
            "SELECT body,fetched_at FROM scholarly_cache WHERE key=?1",
            [url],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if !refresh {
        if let Some((body, at)) = &cached {
            if chrono::DateTime::parse_from_rfc3339(at)
                .is_ok_and(|t| Utc::now().signed_duration_since(t).num_seconds() < CACHE_SECONDS)
            {
                return Ok((body.clone(), at.clone(), false));
            }
        }
    }
    drop(conn);
    let result: AppResult<(String, String, bool)> = (|| {
        let body = fetch()?;
        op.check()?;
        // Never persist a malformed response as a successful cache entry.
        if arxiv {
            parse_atom(&body)?;
        } else {
            let value = serde_json::from_str::<Value>(&body)
                .map_err(|_| "OpenAlex 응답 해석 실패".to_string())?;
            if !value["results"].is_array() && !value["id"].is_string() {
                return Err("OpenAlex 논문 응답이 아닙니다.".into());
            }
        }
        let at = now();
        let conn = open()?;
        conn.execute(
            "INSERT OR REPLACE INTO scholarly_cache(key,body,fetched_at) VALUES (?1,?2,?3)",
            params![url, body, at],
        )
        .map_err(|e| e.to_string())?;
        return Ok((body, at, false));
    })();
    match result {
        Err(e)
            if e != "CANCELLED"
                && !e.starts_with("RATE_LIMIT")
                && !e.starts_with("AUTH_OR_LIMIT") =>
        {
            cached.map(|(b, t)| (b, t, true)).ok_or(e)
        }
        other => other,
    }
}
fn fetch_body(url: &str, arxiv: bool, op: &Operation) -> AppResult<String> {
    let queue = ARXIV_QUEUE.get_or_init(Default::default);
    let mut guard = if arxiv {
        loop {
            op.check()?;
            if let Ok(g) = queue.try_lock() {
                break Some(g);
            }
            op.wait(Duration::from_millis(100))?;
        }
    } else {
        None
    };
    let http = client()?;
    for attempt in 0..3 {
        op.check()?;
        if let Some(g) = guard.as_mut() {
            if let Some(last) = **g {
                op.wait(Duration::from_secs(3).saturating_sub(last.elapsed()))?;
            }
            **g = Some(Instant::now());
        }
        let mut req = http.get(url).header(
            "Accept",
            if arxiv {
                "application/atom+xml"
            } else {
                "application/json"
            },
        );
        if !arxiv {
            if let Some(key) = read_key()? {
                req = req.bearer_auth(key);
            }
        }
        let response = match req.send() {
            Ok(response) => response,
            Err(_) if attempt < 2 => {
                op.wait(Duration::from_secs(2 * (1 << attempt)))?;
                continue;
            }
            Err(_) => return Err("네트워크 연결 실패. 다시 시도해 주세요.".into()),
        };
        let status = response.status();
        if status.as_u16() == 429 || status.is_server_error() {
            let delay = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(3 * (1 << attempt))
                .min(30);
            if attempt < 2 {
                op.wait(Duration::from_secs(delay))?;
                continue;
            }
            return Err(if status.as_u16() == 429 {
                if arxiv {
                    "RATE_LIMIT: arXiv 요청이 제한되었습니다. 잠시 후 재시도해 주세요.".into()
                } else {
                    "RATE_LIMIT: OpenAlex 조회 한도에 도달했습니다. 잠시 후 재시도하거나 설정에서 API 키를 추가해 주세요.".into()
                }
            } else {
                format!("조회 서비스 오류: {status}")
            });
        }
        if status.as_u16() == 401 || status.as_u16() == 403 || status.as_u16() == 409 {
            return Err(if arxiv {
                "AUTH_OR_LIMIT: arXiv 조회가 제한되었습니다. 잠시 후 재시도해 주세요.".into()
            } else {
                "AUTH_OR_LIMIT: OpenAlex 키 또는 조회 한도를 확인해 주세요.".into()
            });
        }
        if !status.is_success() {
            return Err(format!("조회 실패: HTTP {status}"));
        }
        let mut body = String::new();
        response
            .take(16 * 1024 * 1024 + 1)
            .read_to_string(&mut body)
            .map_err(|_| "응답 읽기 실패".to_string())?;
        if body.len() > 16 * 1024 * 1024 {
            return Err("응답 크기 초과".into());
        }
        op.check()?;
        return Ok(body);
    }
    Err("조회 실패".into())
}
fn quote_query(raw: &str) -> String {
    raw.replace(['"', '\\', '(', ')', ':'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
fn date_query(raw: &str) -> AppResult<String> {
    chrono::DateTime::parse_from_rfc3339(raw)
        .map(|t| t.with_timezone(&Utc).format("%Y%m%d%H%M").to_string())
        .map_err(|_| "날짜 형식이 올바르지 않습니다.".into())
}
fn search_url(request: &SearchRequest) -> AppResult<String> {
    if request.page == 0 || request.page > 1500 {
        return Err("페이지 범위를 확인해 주세요.".into());
    }
    let mut url = reqwest::Url::parse("https://export.arxiv.org/api/query").unwrap();
    let mut p = url.query_pairs_mut();
    if let Some((id, version)) = arxiv_identity(&request.query) {
        p.append_pair(
            "id_list",
            &format!(
                "{id}{}",
                version.map(|v| format!("v{v}")).unwrap_or_default()
            ),
        );
    } else {
        let mut terms = Vec::new();
        if !request.query.trim().is_empty() {
            let raw = request.query.trim();
            if let Some(author) = raw.strip_prefix("au:") {
                terms.push(format!("au:\"{}\"", quote_query(author)));
            } else if let Some(title) = raw.strip_prefix("ti:") {
                terms.push(format!("ti:\"{}\"", quote_query(title)));
            } else {
                terms.extend(
                    quote_query(raw)
                        .split_whitespace()
                        .map(|t| format!("all:\"{t}\"")),
                );
            }
        }
        if !request.category.is_empty() {
            if !request
                .category
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
            {
                return Err("분야 코드가 올바르지 않습니다.".into());
            }
            terms.push(format!(
                "cat:{}{}",
                request.category,
                if matches!(
                    request.category.as_str(),
                    "math" | "physics" | "q-bio" | "q-fin" | "econ"
                ) {
                    ".*"
                } else {
                    ""
                }
            ));
        }
        let end = date_query(&request.at)?;
        let start = if request.from.is_empty() {
            "199101010000".into()
        } else {
            date_query(&request.from)?
        };
        if start > end {
            return Err("시작일은 종료일보다 이전이어야 합니다.".into());
        }
        terms.push(format!("submittedDate:[{start} TO {end}]"));
        p.append_pair("search_query", &terms.join(" AND "));
    }
    let sort = match request.sort.as_str() {
        "relevance" => "relevance",
        "lastUpdatedDate" => "lastUpdatedDate",
        _ => "submittedDate",
    };
    p.append_pair("sortBy", sort)
        .append_pair("sortOrder", "descending")
        .append_pair("start", &((request.page - 1) * PAGE_SIZE).to_string())
        .append_pair("max_results", &PAGE_SIZE.to_string());
    drop(p);
    Ok(url.to_string())
}
fn search(app: &AppHandle, request: &SearchRequest, op: &Operation) -> AppResult<PaperPage> {
    let (body, at, stale) = get_body(app, &search_url(request)?, true, request.refresh, op)?;
    let (papers, total) = parse_atom(&body)?;
    Ok(PaperPage {
        papers,
        total,
        page: request.page,
        fetched_at: at,
        stale,
        notice: if stale {
            "오프라인 캐시 결과입니다.".into()
        } else {
            String::new()
        },
    })
}
#[tauri::command]
pub async fn scholarly_search(app: AppHandle, request: SearchRequest) -> AppResult<PaperPage> {
    tauri::async_runtime::spawn_blocking(move || {
        let guard = OperationGuard::new(&request.request_id)?;
        search(&app, &request, &guard.op)
    })
    .await
    .map_err(|e| e.to_string())?
}
fn openalex_paper(v: &Value) -> ScholarlyPaper {
    let string = |key: &str| v[key].as_str().unwrap_or_default().to_string();
    let authors = v["authorships"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x["author"]["display_name"].as_str())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let mut abstract_words: Vec<(u64, String)> = Vec::new();
    if let Some(index) = v["abstract_inverted_index"].as_object() {
        for (word, positions) in index {
            if let Some(a) = positions.as_array() {
                for pos in a {
                    if let Some(n) = pos.as_u64() {
                        abstract_words.push((n, word.clone()));
                    }
                }
            }
        }
    }
    abstract_words.sort_by_key(|(n, _)| *n);
    let mut arxiv_id = String::new();
    let mut version = None;
    if let Some(locations) = v["locations"].as_array() {
        for l in locations {
            for field in ["landing_page_url", "pdf_url"] {
                if let Some((id, ver)) = l[field].as_str().and_then(arxiv_identity) {
                    arxiv_id = id;
                    version = ver;
                    break;
                }
            }
            if !arxiv_id.is_empty() {
                break;
            }
        }
    }
    let ids = |key: &str| {
        v[key]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|s| s.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    };
    ScholarlyPaper {
        title: string("display_name"),
        authors,
        year: v["publication_year"]
            .as_u64()
            .map(|n| n.to_string())
            .unwrap_or_default(),
        abstract_text: abstract_words
            .into_iter()
            .map(|(_, w)| w)
            .collect::<Vec<_>>()
            .join(" "),
        doi: clean_doi(&string("doi")),
        open_alex_id: string("id"),
        arxiv_id,
        version,
        url: v["primary_location"]["landing_page_url"]
            .as_str()
            .unwrap_or_else(|| v["id"].as_str().unwrap_or_default())
            .into(),
        pdf_url: v["primary_location"]["pdf_url"]
            .as_str()
            .unwrap_or_default()
            .into(),
        published: string("publication_date"),
        updated: string("updated_date"),
        source: "OpenAlex".into(),
        cited_by_count: v["cited_by_count"].as_u64(),
        referenced_works: ids("referenced_works"),
        related_works: ids("related_works"),
        ..Default::default()
    }
}
fn oa_url(path: &str, pairs: &[(&str, String)]) -> AppResult<String> {
    let mut url = reqwest::Url::parse(&format!("https://api.openalex.org/{path}"))
        .map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .extend_pairs(pairs.iter().map(|(k, v)| (*k, v.as_str())));
    Ok(url.into())
}
fn oa_lookup(
    app: &AppHandle,
    query: &str,
    doi: &str,
    refresh: bool,
    op: &Operation,
) -> AppResult<(Vec<ScholarlyPaper>, String, bool)> {
    let url = if !doi.is_empty() {
        oa_url(&format!("works/https://doi.org/{}", clean_doi(doi)), &[])?
    } else {
        oa_url(
            "works",
            &[("search", query.into()), ("per_page", "5".into())],
        )?
    };
    let (body, at, stale) = get_body(app, &url, false, refresh, op)?;
    let v: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let papers = if !doi.is_empty() {
        vec![openalex_paper(&v)]
    } else {
        v["results"]
            .as_array()
            .map(|a| a.iter().map(openalex_paper).collect())
            .unwrap_or_default()
    };
    Ok((
        papers.into_iter().filter(|p| !p.title.is_empty()).collect(),
        at,
        stale,
    ))
}
fn pdf_identifiers(text: &str) -> (Option<(String, Option<u32>)>, String) {
    static AR: OnceLock<Regex> = OnceLock::new();
    static DOI: OnceLock<Regex> = OnceLock::new();
    let ar = AR.get_or_init(|| Regex::new(r"(?i)(?:arxiv:\s*|arxiv\.org/(?:abs|pdf)/)((?:\d{4}\.\d{4,5}|[a-z][a-z0-9.-]*/\d{7})(?:v\d+)?)").unwrap());
    let doi = DOI.get_or_init(|| Regex::new(r#"(?i)\b10\.\d{4,9}/[^\s<>"{}]+"#).unwrap());
    (
        ar.captures(text).and_then(|c| arxiv_identity(&c[1])),
        doi.find(text)
            .map(|m| clean_doi(m.as_str()))
            .unwrap_or_default(),
    )
}
fn candidate(paper: ScholarlyPaper, exact: bool, document: &DocumentRecord) -> PaperMatchCandidate {
    let evidence = if exact {
        "PDF 식별자 일치".into()
    } else {
        let normalized = |s: &str| {
            s.chars()
                .filter(|c| c.is_alphanumeric())
                .flat_map(char::to_lowercase)
                .collect::<String>()
        };
        let title = if normalized(&paper.title) == normalized(&document.title) {
            "제목 일치"
        } else {
            "제목 비교 필요"
        };
        let author = document.authors.split(',').any(|name| {
            let name = normalized(name);
            !name.is_empty() && normalized(&paper.authors).contains(&name)
        });
        let year = !document.year.is_empty() && document.year == paper.year;
        format!(
            "{title} · 저자 {} · 연도 {}",
            if author { "겹침" } else { "비교 필요" },
            if year { "일치" } else { "비교 필요" }
        )
    };
    PaperMatchCandidate {
        paper,
        evidence,
        identifier_match: exact,
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidatePage {
    pub candidates: Vec<PaperMatchCandidate>,
    pub notice: String,
    pub local_version: Option<u32>,
    pub pause_reason: String,
}
fn find_candidates(
    app: &AppHandle,
    document_id: &str,
    query: &str,
    text: &str,
    op: &Operation,
) -> AppResult<CandidatePage> {
    let conn = open_db(app)?;
    let document = conn
        .query_row(
            &format!("{DOC_SELECT} WHERE id=?1"),
            [document_id],
            row_document,
        )
        .map_err(|e| e.to_string())?;
    let (pdf_id, doi) = pdf_identifiers(text);
    let pdf_id = filename_identity(&document.file_name).or(pdf_id);
    let inferred_title = text
        .lines()
        .find_map(|line| line.strip_prefix("PAPER_PILOT_TITLE:"))
        .filter(|title| title.len() >= 6 && title.len() <= 260);
    let imported_title = document
        .file_name
        .trim_end_matches(".pdf")
        .replace('_', " ");
    let search_title = if document.title.is_empty() || document.title == imported_title {
        inferred_title.unwrap_or(&document.title)
    } else {
        &document.title
    };
    // An explicit search lets the user change an incorrect existing match.
    let direct = if query.trim().is_empty() {
        pdf_id.clone()
    } else {
        arxiv_identity(query)
    };
    let mut candidates = Vec::new();
    let mut errors = Vec::new();
    let q = direct
        .as_ref()
        .map(|(id, v)| format!("{id}{}", v.map(|n| format!("v{n}")).unwrap_or_default()))
        .unwrap_or_else(|| {
            if query.trim().is_empty() {
                format!("ti:{}", search_title)
            } else {
                query.into()
            }
        });
    let request = SearchRequest {
        query: q,
        category: String::new(),
        from: String::new(),
        at: now(),
        sort: "relevance".into(),
        page: 1,
        request_id: String::new(),
        refresh: false,
    };
    match search(app, &request, op) {
        Ok(page) => {
            if page.stale {
                errors.push("arXiv 캐시 사용".into());
            }
            candidates.extend(page.papers.into_iter().take(5).map(|p| {
                let exact = pdf_id.as_ref().is_some_and(|(id, _)| *id == p.arxiv_id);
                candidate(p, exact, &document)
            }));
        }
        Err(e) if e == "CANCELLED" => return Err(e),
        Err(e) => errors.push(e),
    }
    let query_doi = if query.starts_with("10.") || query.starts_with("https://doi.org/") {
        clean_doi(query)
    } else {
        doi.clone()
    };
    match oa_lookup(
        app,
        if query.trim().is_empty() || direct.is_some() {
            search_title
        } else {
            query
        },
        &query_doi,
        false,
        op,
    ) {
        Ok((papers, _, stale)) => {
            if stale {
                errors.push("OpenAlex 캐시 사용".into());
            }
            candidates.extend(papers.into_iter().map(|p| {
                let exact = (!doi.is_empty() && doi == p.doi)
                    || pdf_id.as_ref().is_some_and(|(id, _)| *id == p.arxiv_id);
                candidate(p, exact, &document)
            }));
        }
        Err(e) if e == "CANCELLED" => return Err(e),
        Err(e) => errors.push(e),
    }
    if candidates.is_empty() && !errors.is_empty() {
        return Err(errors.join(" · "));
    }
    // Title matches remain suggestions. Filename IDs can also link on PDF open.
    candidates.sort_by_key(|c| {
        std::cmp::Reverse(
            u8::from(c.identifier_match) * 16
                + u8::from(c.evidence.contains("제목 일치")) * 4
                + u8::from(c.evidence.contains("저자 겹침")) * 2
                + u8::from(c.evidence.contains("연도 일치")),
        )
    });
    let pause_reason = errors
        .iter()
        .find(|e| e.starts_with("RATE_LIMIT") || e.starts_with("AUTH_OR_LIMIT"))
        .cloned()
        .unwrap_or_default();
    Ok(CandidatePage {
        candidates,
        pause_reason,
        notice: errors.join(" · "),
        local_version: pdf_id.and_then(|(_, v)| v),
    })
}
#[tauri::command]
pub async fn scholarly_candidates(
    app: AppHandle,
    document_id: String,
    query: String,
    text: String,
    request_id: String,
) -> AppResult<CandidatePage> {
    tauri::async_runtime::spawn_blocking(move || {
        let guard = OperationGuard::new(&request_id)?;
        find_candidates(&app, &document_id, &query, &text, &guard.op)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn scholarly_profile(
    app: AppHandle,
    document_id: String,
) -> AppResult<Option<DocumentScholarlyProfile>> {
    profile(&open_db(&app)?, &document_id)
}
#[tauri::command]
pub fn scholarly_identities(app: AppHandle) -> AppResult<Vec<LinkedIdentity>> {
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare("SELECT document_id,arxiv_id,local_version,openalex_id FROM scholarly_profiles")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(LinkedIdentity {
                document_id: r.get(0)?,
                arxiv_id: r.get(1)?,
                local_version: r.get(2)?,
                open_alex_id: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn scholarly_link(
    app: AppHandle,
    document_id: String,
    paper: ScholarlyPaper,
    fields: Vec<String>,
    local_version: Option<u32>,
) -> AppResult<DocumentRecord> {
    link_document(&app, document_id, paper, fields, local_version, None)
}
fn link_document(
    app: &AppHandle,
    document_id: String,
    paper: ScholarlyPaper,
    fields: Vec<String>,
    local_version: Option<u32>,
    automatic_snapshot: Option<(String, Option<String>)>,
) -> AppResult<DocumentRecord> {
    let mut conn = open_db(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut document = tx
        .query_row(
            &format!("{DOC_SELECT} WHERE id=?1"),
            [&document_id],
            row_document,
        )
        .map_err(|e| e.to_string())?;
    let old = profile(&tx, &document_id)?;
    if let Some((hash, snapshot)) = &automatic_snapshot {
        let current = old
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| e.to_string())?;
        if document.hash != *hash
            || &current != snapshot
            || !filename_identity(&document.file_name).is_some_and(|(id, _)| id == paper.arxiv_id)
        {
            return Err("CANCELLED".into());
        }
    }
    let fields = if automatic_snapshot.is_some() {
        automatic_metadata_fields(old.as_ref(), &paper)
    } else {
        fields
    };
    let selected = fields
        .into_iter()
        .filter(|f| matches!(f.as_str(), "title" | "authors" | "year" | "abstractText"))
        .collect::<Vec<_>>();
    for field in &selected {
        match field.as_str() {
            "title" => document.title = paper.title.clone(),
            "authors" => document.authors = paper.authors.clone(),
            "year" => document.year = paper.year.clone(),
            "abstractText" => document.abstract_text = paper.abstract_text.clone(),
            _ => {}
        }
    }
    let same = old.as_ref().is_some_and(|p| {
        (!paper.arxiv_id.is_empty() && p.paper.arxiv_id == paper.arxiv_id)
            || (!paper.open_alex_id.is_empty() && p.paper.open_alex_id == paper.open_alex_id)
    });
    let mut confirmed = old
        .as_ref()
        .map(|p| p.confirmed_fields.clone())
        .unwrap_or_default();
    for f in &selected {
        if !confirmed.contains(f) {
            confirmed.push(f.clone());
        }
    }
    let fetched = now();
    let arxiv_fetched_at = if paper.arxiv_id.is_empty() {
        String::new()
    } else {
        fetched.clone()
    };
    let open_alex_fetched_at = if paper.open_alex_id.is_empty() {
        String::new()
    } else {
        fetched.clone()
    };
    let linked = DocumentScholarlyProfile {
        document_id: document_id.clone(),
        paper,
        local_version: local_version.or_else(|| {
            if same {
                old.and_then(|p| p.local_version)
            } else {
                None
            }
        }),
        fetched_at: fetched.clone(),
        arxiv_fetched_at,
        open_alex_fetched_at,
        confirmed_fields: confirmed,
        enrichment_error: String::new(),
    };
    save_profile(&tx, &linked)?;
    tx.execute("UPDATE documents SET title=?2,authors=?3,year=?4,abstract_text=?5,updated_at=?6 WHERE id=?1",params![document_id,document.title,document.authors,document.year,document.abstract_text,fetched]).map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE scholarly_scan_items SET status='linked' WHERE document_id=?1",
        [&document_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    document.updated_at = fetched;
    obsidian::queue(&app, &conn, &document_id);
    Ok(document)
}
fn automatic_metadata_fields(
    old: Option<&DocumentScholarlyProfile>,
    paper: &ScholarlyPaper,
) -> Vec<String> {
    let confirmed = old
        .filter(|p| p.paper.arxiv_id == paper.arxiv_id)
        .map(|p| p.confirmed_fields.as_slice())
        .unwrap_or(&[]);
    [
        ("title", &paper.title),
        ("authors", &paper.authors),
        ("year", &paper.year),
        ("abstractText", &paper.abstract_text),
    ]
    .into_iter()
    .filter(|(field, value)| !value.trim().is_empty() && !confirmed.iter().any(|f| f == field))
    .map(|(field, _)| field.to_string())
    .collect()
}
#[tauri::command]
pub async fn scholarly_auto_link_filename(
    app: AppHandle,
    document_id: String,
    request_id: String,
) -> AppResult<Option<DocumentRecord>> {
    tauri::async_runtime::spawn_blocking(move || {
        let guard = OperationGuard::new(&request_id)?;
        let conn = open_db(&app)?;
        let document = conn
            .query_row(
                &format!("{DOC_SELECT} WHERE id=?1"),
                [&document_id],
                row_document,
            )
            .map_err(|e| e.to_string())?;
        let Some((id, version)) = filename_identity(&document.file_name) else {
            return Ok(None);
        };
        let old = profile(&conn, &document_id)?;
        let same = old.as_ref().filter(|p| {
            p.paper.arxiv_id == id && (version.is_none() || p.local_version == version)
        });
        if same.is_some_and(|p| p.confirmed_fields.iter().any(|f| f == "title")) {
            return Ok(None);
        }
        let snapshot = old
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| e.to_string())?;
        drop(conn);
        let paper = if let Some(profile) = same {
            profile.paper.clone()
        } else {
            let request = SearchRequest {
                query: format!(
                    "{id}{}",
                    version.map(|v| format!("v{v}")).unwrap_or_default()
                ),
                category: String::new(),
                from: String::new(),
                at: now(),
                sort: "relevance".into(),
                page: 1,
                request_id: request_id.clone(),
                refresh: false,
            };
            search(&app, &request, &guard.op)?
                .papers
                .into_iter()
                .find(|p| p.arxiv_id == id && (version.is_none() || p.version == version))
                .ok_or("파일 이름의 arXiv ID에 해당하는 논문을 찾지 못했습니다.")?
        };
        guard.op.check()?;
        link_document(
            &app,
            document_id,
            paper,
            Vec::new(),
            version,
            Some((document.hash, snapshot)),
        )
        .map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn scholarly_unlink(app: AppHandle, document_id: String) -> AppResult<()> {
    open_db(&app)?
        .execute(
            "DELETE FROM scholarly_profiles WHERE document_id=?1",
            [document_id],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn combine_arxiv_oa(mut arxiv: ScholarlyPaper, oa: ScholarlyPaper) -> ScholarlyPaper {
    arxiv.open_alex_id = oa.open_alex_id;
    arxiv.cited_by_count = oa.cited_by_count;
    arxiv.referenced_works = oa.referenced_works;
    arxiv.related_works = oa.related_works;
    if arxiv.doi.is_empty() {
        arxiv.doi = oa.doi;
    }
    arxiv
}
fn same_work(p: &ScholarlyPaper, other: &ScholarlyPaper) -> bool {
    (!p.doi.is_empty() && p.doi == other.doi)
        || (!p.arxiv_id.is_empty() && p.arxiv_id == other.arxiv_id)
}
fn save_refreshed_profile(
    conn: &Connection,
    profile: &DocumentScholarlyProfile,
    original: &str,
) -> AppResult<()> {
    let changed = conn.execute("UPDATE scholarly_profiles SET arxiv_id=?2,local_version=?3,openalex_id=?4,json=?5 WHERE document_id=?1 AND json=?6",
        params![profile.document_id,profile.paper.arxiv_id,profile.local_version,profile.paper.open_alex_id,serde_json::to_string(profile).map_err(|e|e.to_string())?,original]).map_err(|e|e.to_string())?;
    if changed == 0 {
        return Err("조회 중 온라인 연결이 변경되었습니다. 현재 정보를 다시 확인해 주세요.".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn scholarly_refresh(
    app: AppHandle,
    document_id: String,
    request_id: String,
) -> AppResult<DocumentScholarlyProfile> {
    tauri::async_runtime::spawn_blocking(move || {
        let guard = OperationGuard::new(&request_id)?;
        let conn = open_db(&app)?;
        let original: String = conn.query_row("SELECT json FROM scholarly_profiles WHERE document_id=?1", [&document_id], |r| r.get(0))
            .map_err(|_| "온라인 논문을 먼저 연결해 주세요.".to_string())?;
        let mut p: DocumentScholarlyProfile = serde_json::from_str(&original).map_err(|e| e.to_string())?;
        p.enrichment_error.clear();
        if !p.paper.arxiv_id.is_empty() {
            let req = SearchRequest { query:p.paper.arxiv_id.clone(), category:String::new(), from:String::new(), at:now(), sort:"relevance".into(), page:1, request_id:String::new(), refresh:true };
            match search(&app, &req, &guard.op) {
                Ok(page) => {
                    if let Some(paper) = page.papers.into_iter().next() {
                        p.paper = combine_arxiv_oa(paper, p.paper);
                        p.arxiv_fetched_at = page.fetched_at.clone();
                        p.fetched_at = page.fetched_at;
                    }
                    if page.stale { p.enrichment_error = "arXiv 조회 실패: 저장된 캐시 사용".into(); }
                }
                Err(error) if error == "CANCELLED" => return Err(error),
                Err(error) => p.enrichment_error = format!("arXiv: {error}"),
            }
        }
        let result = if !p.paper.open_alex_id.is_empty() {
            get_body(&app, &oa_url(&format!("works/{}", p.paper.open_alex_id.rsplit('/').next().unwrap_or_default()), &[])?, false, true, &guard.op)
                .and_then(|(body,at,stale)| serde_json::from_str::<Value>(&body).map(|v| (vec![openalex_paper(&v)],at,stale)).map_err(|e|e.to_string()))
        } else { oa_lookup(&app, &p.paper.title, &p.paper.doi, true, &guard.op) };
        match result {
            Ok((works,at,stale)) => {
                if let Some(oa) = works.into_iter().find(|w| (!p.paper.open_alex_id.is_empty() && w.open_alex_id == p.paper.open_alex_id) || same_work(&p.paper, w)) {
                    p.paper = if p.paper.arxiv_id.is_empty() { oa } else { combine_arxiv_oa(p.paper,oa) };
                    p.open_alex_fetched_at = at.clone();
                    if p.paper.arxiv_id.is_empty() { p.fetched_at = at; }
                    if stale { p.enrichment_error.push_str(" · OpenAlex 조회 실패: 저장된 캐시 사용"); }
                } else { p.enrichment_error.push_str(" · OpenAlex에 확인 가능한 동일 논문이 없습니다. 온라인 정보 연결에서 후보를 확인해 주세요."); }
            }
            Err(error) if error == "CANCELLED" => return Err(error),
            Err(error) => p.enrichment_error.push_str(&format!(" · {error}")),
        }
        p.enrichment_error = p.enrichment_error.trim_start_matches(" · ").into();
        guard.op.check()?;
        save_refreshed_profile(&conn, &p, &original)?;
        Ok(p)
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn scholarly_relations(
    app: AppHandle,
    document_id: String,
    kind: String,
    page: usize,
    request_id: String,
    refresh: bool,
) -> AppResult<PaperPage> {
    tauri::async_runtime::spawn_blocking(move || {
        let guard = OperationGuard::new(&request_id)?;
        let p =
            profile(&open_db(&app)?, &document_id)?.ok_or("온라인 정보를 먼저 연결해 주세요.")?;
        if page == 0 {
            return Err("페이지 오류".into());
        }
        if kind == "related" && p.paper.open_alex_id.is_empty() {
            let mut fallback = search(
                &app,
                &SearchRequest {
                    query: p.paper.title.clone(),
                    category: p.paper.categories.first().cloned().unwrap_or_default(),
                    from: String::new(),
                    at: now(),
                    sort: "relevance".into(),
                    page,
                    request_id: String::new(),
                    refresh,
                },
                &guard.op,
            )?;
            fallback.papers.retain(|w| w.arxiv_id != p.paper.arxiv_id);
            fallback.notice = "arXiv 제목·분야 기반 검색 결과".into();
            return Ok(fallback);
        }
        if p.paper.open_alex_id.is_empty() {
            return Err(
                "OpenAlex 정보 없음. 온라인 정보를 새로고침하거나 연결 후보를 확인해 주세요."
                    .into(),
            );
        }
        let id = p.paper.open_alex_id.rsplit('/').next().unwrap_or_default();
        let mut slice_total = None;
        let pairs = match kind.as_str() {
            "citing" => vec![
                ("filter", format!("cites:{id}")),
                ("sort", "publication_date:desc".into()),
                ("per_page", PAGE_SIZE.to_string()),
                ("page", page.to_string()),
            ],
            "references" | "related" => {
                let ids = if kind == "references" {
                    &p.paper.referenced_works
                } else {
                    &p.paper.related_works
                };
                slice_total = Some(ids.len());
                let subset = ids
                    .iter()
                    .skip((page - 1) * PAGE_SIZE)
                    .take(PAGE_SIZE)
                    .map(|id| id.rsplit('/').next().unwrap_or_default())
                    .collect::<Vec<_>>();
                if subset.is_empty() {
                    return Ok(PaperPage {
                        papers: vec![],
                        total: ids.len(),
                        page,
                        fetched_at: p.fetched_at,
                        stale: false,
                        notice: String::new(),
                    });
                }
                vec![
                    ("filter", format!("openalex:{}", subset.join("|"))),
                    ("per_page", PAGE_SIZE.to_string()),
                ]
            }
            _ => return Err("지원하지 않는 관계 유형".into()),
        };
        let (body, at, stale) =
            get_body(&app, &oa_url("works", &pairs)?, false, refresh, &guard.op)?;
        let v: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        let papers = v["results"]
            .as_array()
            .map(|a| a.iter().map(openalex_paper).collect())
            .unwrap_or_default();
        Ok(PaperPage {
            papers,
            total: slice_total.unwrap_or(v["meta"]["count"].as_u64().unwrap_or(0) as usize),
            page,
            fetched_at: at,
            stale,
            notice: if stale {
                "오프라인 캐시".into()
            } else {
                String::new()
            },
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(target_os = "macos")]
fn key_entry() -> AppResult<keyring::Entry> {
    keyring::Entry::new("org.paperpilot.scholarly", "openalex")
        .map_err(|_| "Keychain 초기화 실패".into())
}
#[cfg(target_os = "macos")]
fn read_key() -> AppResult<Option<String>> {
    match key_entry()?.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Keychain 키를 읽을 수 없습니다.".into()),
    }
}
#[cfg(not(target_os = "macos"))]
fn read_key() -> AppResult<Option<String>> {
    Ok(None)
}
#[tauri::command]
pub fn scholarly_key_status() -> AppResult<bool> {
    Ok(read_key()?.is_some())
}
#[tauri::command]
pub fn scholarly_set_key(key: String) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    {
        let entry = key_entry()?;
        if key.trim().is_empty() {
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err("키 삭제 실패".into()),
            }
        } else {
            entry
                .set_password(key.trim())
                .map_err(|_| "Keychain 저장 실패".into())
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = key;
        Err("API 키 저장은 macOS에서 지원합니다.".into())
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub document: Option<DocumentRecord>,
    pub existing: bool,
    pub cancelled: bool,
}
fn existing_document(
    conn: &Connection,
    paper: &ScholarlyPaper,
) -> AppResult<Option<DocumentRecord>> {
    conn.query_row(&format!("{DOC_SELECT} WHERE id IN (SELECT document_id FROM scholarly_profiles WHERE arxiv_id=?1 AND local_version=?2) LIMIT 1"),params![paper.arxiv_id,paper.version],row_document).optional().map_err(|e|e.to_string())
}
fn publish_pdf(temp: &Path, destination: &Path) -> AppResult<()> {
    // Exclusive publication: a save dialog must never cause an existing PDF to be replaced.
    fs::hard_link(temp, destination).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            "같은 이름의 파일이 있습니다. 다른 이름으로 저장해 주세요.".into()
        } else {
            format!("PDF 저장 실패: {e}")
        }
    })
}
fn validate_pdf(bytes: &[u8], expected: Option<u64>) -> AppResult<()> {
    let header = &bytes[..bytes.len().min(1024)];
    let trailer = &bytes[bytes.len().saturating_sub(4096)..];
    if !header.windows(5).any(|s| s == b"%PDF-") {
        return Err("응답이 PDF 파일이 아닙니다.".into());
    }
    if expected.is_some_and(|n| n != bytes.len() as u64)
        || !trailer.windows(5).any(|s| s == b"%%EOF")
        || !trailer.windows(9).any(|s| s == b"startxref")
    {
        return Err("PDF 다운로드가 완료되지 않았거나 파일이 손상되었습니다.".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn scholarly_import(
    app: AppHandle,
    mut paper: ScholarlyPaper,
    request_id: String,
) -> AppResult<ImportResult> {
    tauri::async_runtime::spawn_blocking(move || {
        let guard = OperationGuard::new(&request_id)?;
        let (id, version) =
            arxiv_identity(&versioned_id(&paper)).ok_or("arXiv ID가 올바르지 않습니다.")?;
        paper.arxiv_id = id;
        // Resolve ID-only/OpenAlex results to an actual arXiv version before download.
        let fetched = search(
            &app,
            &SearchRequest {
                query: format!(
                    "{}{}",
                    paper.arxiv_id,
                    version.map(|v| format!("v{v}")).unwrap_or_default()
                ),
                category: String::new(),
                from: String::new(),
                at: now(),
                sort: "relevance".into(),
                page: 1,
                request_id: String::new(),
                refresh: false,
            },
            &guard.op,
        )?;
        let remote = fetched
            .papers
            .into_iter()
            .next()
            .ok_or("arXiv 논문을 찾을 수 없습니다.")?;
        paper = combine_arxiv_oa(remote, paper);
        let mut conn = open_db(&app)?;
        if let Some(document) = existing_document(&conn, &paper)? {
            return Ok(ImportResult {
                document: Some(document),
                existing: true,
                cancelled: false,
            });
        }
        let Some(file) = app
            .dialog()
            .file()
            .add_filter("PDF", &["pdf"])
            .set_file_name(format!("{}.pdf", versioned_id(&paper).replace('/', "-")).as_str())
            .blocking_save_file()
        else {
            return Ok(ImportResult {
                document: None,
                existing: false,
                cancelled: true,
            });
        };
        let destination = file.into_path().map_err(|e| e.to_string())?;
        if destination.exists() {
            return Err("같은 이름의 파일이 있습니다. 다른 이름으로 저장해 주세요.".into());
        }
        let parent = destination.parent().ok_or("저장 폴더 오류")?;
        let temp = parent.join(format!(".paper-pilot-{}.part", Uuid::new_v4()));
        let result = (|| {
            let mut out = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)
                .map_err(|e| e.to_string())?;
            let http = Client::builder()
                .user_agent("PaperPilot/0.1")
                .timeout(Duration::from_secs(180))
                .connect_timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::custom(|attempt| {
                    if attempt.previous().len() >= 5 {
                        return attempt.error("too many redirects");
                    }
                    let url = attempt.url();
                    if url.scheme() == "https"
                        && url
                            .host_str()
                            .is_some_and(|h| h == "arxiv.org" || h.ends_with(".arxiv.org"))
                    {
                        attempt.follow()
                    } else {
                        attempt.error("unexpected PDF host")
                    }
                }))
                .build()
                .map_err(|_| "PDF 클라이언트 초기화 실패".to_string())?;
            let mut response = http
                .get(format!("https://arxiv.org/pdf/{}", versioned_id(&paper)))
                .send()
                .map_err(|_| "PDF 다운로드 연결 실패".to_string())?;
            if !response.status().is_success() {
                return Err(format!("PDF 다운로드 실패: HTTP {}", response.status()));
            }
            let total = response.content_length();
            let mut downloaded = 0u64;
            let mut buf = [0u8; 65536];
            let mut header = Vec::new();
            loop {
                guard.op.check()?;
                let count = response.read(&mut buf).map_err(|_| {
                    "PDF 다운로드가 중단되었습니다. 다시 시도해 주세요.".to_string()
                })?;
                if count == 0 {
                    break;
                }
                if header.len() < 1024 {
                    header.extend_from_slice(&buf[..count.min(1024 - header.len())]);
                }
                out.write_all(&buf[..count]).map_err(|e| e.to_string())?;
                downloaded += count as u64;
                if downloaded > 512 * 1024 * 1024 {
                    return Err("PDF 파일 크기 제한(512MB) 초과".into());
                }
                let _ = app.emit(
                    "paper-pilot:scholarly-download",
                    json!({"requestId":request_id,"downloaded":downloaded,"total":total}),
                );
            }
            guard.op.check()?;
            out.sync_all().map_err(|e| e.to_string())?;
            drop(out);
            if !header.windows(5).any(|s| s == b"%PDF-") {
                return Err("응답이 PDF 파일이 아닙니다.".into());
            }
            if total.is_some_and(|n| n != downloaded) {
                return Err("PDF 다운로드가 완료되지 않았습니다.".into());
            }
            let bytes = fs::read(&temp).map_err(|e| e.to_string())?;
            validate_pdf(&bytes, total)?;
            let hash = sha256_hex(&bytes);
            // Do not call register_linked_pdf for duplicate hashes: it relocates source paths.
            if let Some(document) = conn
                .query_row(
                    &format!("{DOC_SELECT} WHERE hash=?1 LIMIT 1"),
                    [&hash],
                    row_document,
                )
                .optional()
                .map_err(|e| e.to_string())?
            {
                return Ok(ImportResult {
                    document: Some(document),
                    existing: true,
                    cancelled: false,
                });
            }
            guard.op.check()?;
            publish_pdf(&temp, &destination)?;
            let destination = destination.canonicalize().map_err(|e| e.to_string())?;
            let registration = library_fs::register_downloaded_pdf(
                &mut conn,
                &destination,
                &hash,
                &app_dir(&app)?.join("documents"),
            );
            let (document, created) = match registration {
                Ok(record) => record,
                Err(error) => {
                    let _ = fs::remove_file(&destination);
                    return Err(error);
                }
            };
            if !created {
                let _ = fs::remove_file(&destination);
                return Ok(ImportResult {
                    document: Some(document),
                    existing: true,
                    cancelled: false,
                });
            }
            let registered = (|| {
                scholarly_link(
                    app.clone(),
                    document.id,
                    paper.clone(),
                    vec![
                        "title".into(),
                        "authors".into(),
                        "year".into(),
                        "abstractText".into(),
                    ],
                    paper.version,
                )
            })();
            match registered {
                Ok(document) => Ok(ImportResult {
                    document: Some(document),
                    existing: false,
                    cancelled: false,
                }),
                Err(e) => {
                    // Remove only the newly published file and record, never prior library data.
                    if let Ok(Some(doc)) = conn
                        .query_row(
                            &format!("{DOC_SELECT} WHERE source_path=?1"),
                            [destination.to_string_lossy().as_ref()],
                            row_document,
                        )
                        .optional()
                    {
                        let _ = conn.execute("DELETE FROM documents WHERE id=?1", [doc.id]);
                    }
                    let _ = fs::remove_file(&destination);
                    Err(e)
                }
            }
        })();
        let _ = fs::remove_file(temp);
        result
    })
    .await
    .map_err(|e| e.to_string())?
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryLinkScan {
    pub id: String,
    pub status: String,
    pub created_at: String,
    pub total: usize,
    pub completed: usize,
    pub failed: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanItem {
    pub document_id: String,
    pub status: String,
    pub candidates: Vec<PaperMatchCandidate>,
    pub error: String,
    pub ordinal: usize,
}
fn scan_header(conn: &Connection, id: &str) -> AppResult<LibraryLinkScan> {
    conn.query_row("SELECT id,status,created_at,(SELECT COUNT(*) FROM scholarly_scan_items WHERE scan_id=?1),(SELECT COUNT(*) FROM scholarly_scan_items WHERE scan_id=?1 AND status NOT IN ('pending','searching')),(SELECT COUNT(*) FROM scholarly_scan_items WHERE scan_id=?1 AND status='failed') FROM scholarly_scans WHERE id=?1",[id],|r| Ok(LibraryLinkScan {id:r.get(0)?,status:r.get(1)?,created_at:r.get(2)?,total:r.get(3)?,completed:r.get(4)?,failed:r.get(5)?})).map_err(|e|e.to_string())
}
#[tauri::command]
pub fn scholarly_scan_latest(app: AppHandle) -> AppResult<Option<LibraryLinkScan>> {
    let conn = open_db(&app)?;
    let id: Option<String> = conn
        .query_row(
            "SELECT id FROM scholarly_scans ORDER BY created_at DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    id.map(|id| scan_header(&conn, &id)).transpose()
}
#[tauri::command]
pub fn scholarly_scan_start(app: AppHandle) -> AppResult<LibraryLinkScan> {
    let mut conn = open_db(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let active: usize = tx
        .query_row(
            "SELECT COUNT(*) FROM scholarly_scans WHERE status IN ('running','paused')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if active > 0 {
        return Err("기존 검사를 완료하거나 취소한 뒤 새 검사를 시작해 주세요.".into());
    }
    let id = Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO scholarly_scans(id,status,created_at) VALUES (?1,'paused',?2)",
        params![id, now()],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO scholarly_scan_items(scan_id,document_id,ordinal,status) SELECT ?1,id,ROW_NUMBER() OVER (ORDER BY created_at,id),'pending' FROM documents WHERE id NOT IN (SELECT document_id FROM scholarly_profiles)",[&id]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    scan_header(&conn, &id)
}
#[tauri::command]
pub fn scholarly_scan_action(
    app: AppHandle,
    scan_id: String,
    action: String,
) -> AppResult<LibraryLinkScan> {
    let mut conn = open_db(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let current = scan_header(&tx, &scan_id)?;
    let status = match action.as_str() {
        "pause" => "paused",
        "resume" => "running",
        "cancel" => "cancelled",
        "retry" => "paused",
        _ => return Err("검사 동작 오류".into()),
    };
    if current.status == "cancelled" && action != "cancel" {
        return Err("취소된 검사는 다시 시작해 주세요.".into());
    }
    if action == "retry" {
        tx.execute("UPDATE scholarly_scan_items SET status='pending',error='' WHERE scan_id=?1 AND status='failed'",[&scan_id]).map_err(|e|e.to_string())?;
    }
    tx.execute(
        "UPDATE scholarly_scans SET status=?2 WHERE id=?1",
        params![scan_id, status],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    scan_header(&conn, &scan_id)
}
#[tauri::command]
pub fn scholarly_scan_next(app: AppHandle, scan_id: String) -> AppResult<Option<String>> {
    let mut conn = open_db(&app)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    if scan_header(&tx, &scan_id)?.status != "running" {
        return Ok(None);
    }
    let id:Option<String>=tx.query_row("SELECT document_id FROM scholarly_scan_items WHERE scan_id=?1 AND status='pending' ORDER BY ordinal LIMIT 1",[&scan_id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    if let Some(id) = &id {
        tx.execute("UPDATE scholarly_scan_items SET status='searching' WHERE scan_id=?1 AND document_id=?2",params![scan_id,id]).map_err(|e|e.to_string())?;
    } else {
        tx.execute(
            "UPDATE scholarly_scans SET status='complete' WHERE id=?1",
            [&scan_id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}
#[tauri::command]
pub fn scholarly_scan_finish(
    app: AppHandle,
    scan_id: String,
    document_id: String,
    candidates: Vec<PaperMatchCandidate>,
    error: String,
) -> AppResult<LibraryLinkScan> {
    let conn = open_db(&app)?;
    let linked = profile(&conn, &document_id)?.is_some();
    let status = if linked {
        "linked"
    } else if error == "CANCELLED" {
        "pending"
    } else if !error.is_empty() && candidates.is_empty() {
        "failed"
    } else if candidates.is_empty() {
        "notFound"
    } else {
        "review"
    };
    conn.execute("UPDATE scholarly_scan_items SET status=?3,candidates=?4,error=?5 WHERE scan_id=?1 AND document_id=?2",params![scan_id,document_id,status,serde_json::to_string(&candidates).map_err(|e|e.to_string())?,if error=="CANCELLED" {""} else {&error}]).map_err(|e|e.to_string())?;
    scan_header(&conn, &scan_id)
}
#[tauri::command]
pub fn scholarly_scan_items(
    app: AppHandle,
    scan_id: String,
    page: usize,
) -> AppResult<Vec<ScanItem>> {
    let conn = open_db(&app)?;
    let mut stmt=conn.prepare("SELECT document_id,status,candidates,error,ordinal FROM scholarly_scan_items WHERE scan_id=?1 ORDER BY ordinal LIMIT 20 OFFSET ?2").map_err(|e|e.to_string())?;
    let rows = stmt
        .query_map(params![scan_id, page.saturating_sub(1) * PAGE_SIZE], |r| {
            let json: String = r.get(2)?;
            Ok(ScanItem {
                document_id: r.get(0)?,
                status: r.get(1)?,
                candidates: serde_json::from_str(&json).unwrap_or_default(),
                error: r.get(3)?,
                ordinal: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}
pub fn recover_scans(conn: &Connection) -> AppResult<()> {
    conn.execute(
        "UPDATE scholarly_scans SET status='paused' WHERE status='running'",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE scholarly_scan_items SET status='pending' WHERE status='searching'",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn export_scan_items(conn: &Connection, document_id: &str) -> AppResult<Vec<Value>> {
    let mut stmt = conn.prepare("SELECT s.id,s.status,s.created_at,i.status,i.candidates,i.error FROM scholarly_scans s JOIN scholarly_scan_items i ON i.scan_id=s.id WHERE i.document_id=?1 ORDER BY s.created_at")
        .map_err(|e|e.to_string())?;
    let rows = stmt.query_map([document_id], |row| {
        let candidates: String = row.get(4)?;
        Ok(json!({ "scanId":row.get::<_,String>(0)?, "status":row.get::<_,String>(1)?, "createdAt":row.get::<_,String>(2)?, "itemStatus":row.get::<_,String>(3)?, "candidates":serde_json::from_str::<Value>(&candidates).unwrap_or(json!([])), "error":row.get::<_,String>(5)? }))
    }).map_err(|e|e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn scholarly_resolve_citation(
    app: AppHandle,
    card: CitationCardRecord,
    request_id: String,
) -> AppResult<CitationCardRecord> {
    tauri::async_runtime::spawn_blocking(move || {
        let guard = OperationGuard::new(&request_id)?;
        let mut card = card;
        let (papers, _, _) = oa_lookup(
            &app,
            &format!("{} {}", card.title, card.authors),
            &card.doi,
            false,
            &guard.op,
        )?;
        // A title-only search is a suggestion, not permission to link a citation.
        if let Some(p) = papers
            .into_iter()
            .find(|p| !card.doi.is_empty() && clean_doi(&card.doi) == p.doi)
        {
            if card.title.len() < 12 {
                card.title = p.title;
            }
            if card.authors.is_empty() {
                card.authors = p.authors;
            }
            if card.year.is_empty() {
                card.year = p.year;
            }
            card.url = p.url;
            card.doi = p.doi;
        }
        if card.url.is_empty() && !card.doi.is_empty() {
            card.url = format!("https://doi.org/{}", clean_doi(&card.doi));
        }
        Ok(card)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        super::super::migrate(&c).unwrap();
        c
    }
    #[test]
    fn ids_and_pdf_evidence() {
        assert_eq!(
            arxiv_identity("https://arxiv.org/pdf/2401.01234v3.pdf"),
            Some(("2401.01234".into(), Some(3)))
        );
        assert_eq!(
            arxiv_identity("arXiv: hep-th/9901001v2"),
            Some(("hep-th/9901001".into(), Some(2)))
        );
        assert!(arxiv_identity("https://evil.test/2401.01234").is_none());
        assert!(arxiv_identity("2401.01234/traversal").is_none());
        let (id, doi) = pdf_identifiers("arXiv:2401.01234v2 [cs.AI] doi:10.1000/Example.");
        assert_eq!(id.unwrap().1, Some(2));
        assert_eq!(doi, "10.1000/example");
    }
    #[test]
    fn filename_ids_work_without_titles_or_pdf_watermarks() {
        for name in [
            "2609.36048v1.pdf",
            "arxiv-2609.36048v1.pdf",
            "arXiv_2609.36048v1 (2).PDF",
            "arXiv_2609.36048v1__2_.PDF",
        ] {
            assert_eq!(
                filename_identity(name),
                Some(("2609.36048".into(), Some(1)))
            );
        }
        assert_eq!(
            filename_identity("hep-th_9901001v2.pdf"),
            Some(("hep-th/9901001".into(), Some(2)))
        );
        assert_eq!(
            filename_identity("2401.01234.pdf"),
            Some(("2401.01234".into(), None))
        );
        for name in [
            "my notes 2401.01234.pdf",
            "https://evil.test/2401.01234",
            "2401.01234v0.pdf",
            "ordinary-paper.pdf",
        ] {
            assert!(filename_identity(name).is_none());
        }
    }
    #[test]
    fn automatic_filename_metadata_repairs_title_and_preserves_confirmed_fields() {
        let paper = ScholarlyPaper {
            arxiv_id: "2401.01234".into(),
            title: "Correct arXiv title".into(),
            authors: "Online author".into(),
            year: "2024".into(),
            abstract_text: "Abstract".into(),
            ..Default::default()
        };
        assert_eq!(
            automatic_metadata_fields(None, &paper),
            vec!["title", "authors", "year", "abstractText"]
        );
        let mut old = DocumentScholarlyProfile {
            document_id: "old-pdf".into(),
            paper: paper.clone(),
            local_version: Some(1),
            fetched_at: String::new(),
            arxiv_fetched_at: String::new(),
            open_alex_fetched_at: String::new(),
            confirmed_fields: vec!["authors".into()],
            enrichment_error: String::new(),
        };
        assert_eq!(
            automatic_metadata_fields(Some(&old), &paper),
            vec!["title", "year", "abstractText"]
        );
        old.paper.arxiv_id = "9999.99999".into();
        assert_eq!(
            automatic_metadata_fields(Some(&old), &paper),
            vec!["title", "authors", "year", "abstractText"]
        );
    }
    #[test]
    fn atom_namespaces_and_errors() {
        let xml = r#"<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom"><opensearch:totalResults>1</opensearch:totalResults><entry><id>http://arxiv.org/abs/2401.01234v2</id><title>Title &amp; words</title><summary> An abstract </summary><author><name>Alice</name></author><category term="cs.AI"/><published>2024-01-01T00:00:00Z</published><arxiv:doi>10.1000/Test</arxiv:doi></entry></feed>"#;
        let (p, n) = parse_atom(xml).unwrap();
        assert_eq!(n, 1);
        assert_eq!(p[0].title, "Title & words");
        assert_eq!(p[0].categories, vec!["cs.AI"]);
        assert_eq!(p[0].version, Some(2));
        assert_eq!(p[0].doi, "10.1000/test");
        assert!(parse_atom("<feed><entry><id>http://arxiv.org/api/errors</id><summary>bad query</summary></entry></feed>").is_err());
        assert!(parse_atom("not xml").is_err());
        assert!(parse_atom("<html>bad gateway</html>").is_err());
        assert!(parse_atom("<feed></feed>").unwrap().0.is_empty());
        let entries = (1..=25).map(|n| format!("<entry><id>http://arxiv.org/abs/2401.{n:05}v1</id><title>Paper {n}</title></entry>")).collect::<String>();
        let feed = format!("<feed><totalResults>25</totalResults>{entries}</feed>");
        assert_eq!(parse_atom(&feed).unwrap().0.len(), PAGE_SIZE);
    }
    #[test]
    fn query_filters_and_versions() {
        let mut r = SearchRequest {
            query: "au:Alice Smith".into(),
            category: "cs.AI".into(),
            from: "2026-10-01T00:00:00Z".into(),
            at: "2026-10-07T01:00:00Z".into(),
            sort: "relevance".into(),
            page: 2,
            request_id: "test".into(),
            refresh: false,
        };
        let u = reqwest::Url::parse(&search_url(&r).unwrap()).unwrap();
        let pairs: HashMap<_, _> = u.query_pairs().into_owned().collect();
        assert_eq!(pairs["start"], "20");
        assert!(pairs["search_query"].contains("au:\"Alice Smith\""));
        assert!(pairs["search_query"].contains("202610010000 TO 202610070100"));
        r.query = "hep-th/9901001v2".into();
        r.page = 1;
        let u = search_url(&r).unwrap();
        assert!(u.contains("id_list=hep-th%2F9901001v2"));
        r.page = 0;
        assert!(search_url(&r).is_err());
    }
    #[test]
    fn profiles_migration_and_scan_recovery() {
        let c = db();
        migrate(&c).unwrap();
        c.execute("INSERT INTO documents(id,title,file_name,file_path,hash,created_at,updated_at) VALUES ('doc','T','t.pdf','/original.pdf','hash','now','now')",[]).unwrap();
        let p = DocumentScholarlyProfile {
            document_id: "doc".into(),
            paper: ScholarlyPaper {
                arxiv_id: "2401.01234".into(),
                version: Some(3),
                ..Default::default()
            },
            local_version: Some(2),
            fetched_at: now(),
            arxiv_fetched_at: String::new(),
            open_alex_fetched_at: String::new(),
            confirmed_fields: vec!["authors".into()],
            enrichment_error: String::new(),
        };
        save_profile(&c, &p).unwrap();
        assert_eq!(profile(&c, "doc").unwrap().unwrap().local_version, Some(2));
        assert!(existing_document(&c, &p.paper).unwrap().is_none());
        c.execute(
            "INSERT INTO scholarly_scans VALUES ('scan','running','now')",
            [],
        )
        .unwrap();
        c.execute("INSERT INTO scholarly_scan_items(scan_id,document_id,ordinal,status) VALUES ('scan','doc',1,'searching')",[]).unwrap();
        recover_scans(&c).unwrap();
        assert_eq!(scan_header(&c, "scan").unwrap().status, "paused");
        let exported =
            serde_json::to_value(super::super::export_bundle(&c, "doc").unwrap()).unwrap();
        assert_eq!(exported["scholarlyProfile"]["localVersion"], 2);
        assert_eq!(exported["scholarlyScans"][0]["status"], "paused");
        assert_eq!(exported["scholarlyScans"][0]["itemStatus"], "pending");
        c.execute("DELETE FROM documents WHERE id='doc'", [])
            .unwrap();
        assert!(profile(&c, "doc").unwrap().is_none());
        assert_eq!(scan_header(&c, "scan").unwrap().total, 0);
    }
    #[test]
    fn publication_preserves_existing_file() {
        let root = std::env::temp_dir().join(format!("paperpilot-pdf-test-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let temp = root.join("temp");
        let dest = root.join("paper.pdf");
        fs::write(&temp, b"%PDF-new").unwrap();
        fs::write(&dest, b"old").unwrap();
        assert!(publish_pdf(&temp, &dest).is_err());
        assert_eq!(fs::read(&dest).unwrap(), b"old");
        fs::remove_file(&dest).unwrap();
        publish_pdf(&temp, &dest).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"%PDF-new");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_non_pdf_and_truncated_downloads() {
        let valid = b"%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\nstartxref\n12\n%%EOF\n";
        assert!(validate_pdf(valid, Some(valid.len() as u64)).is_ok());
        assert!(validate_pdf(b"<html>not a paper</html>", None).is_err());
        assert!(validate_pdf(b"%PDF-1.7\npartial download", None).is_err());
        assert!(validate_pdf(valid, Some(9000)).is_err());
    }
    #[test]
    fn downloaded_duplicate_preserves_original_document_and_metadata() {
        let root =
            std::env::temp_dir().join(format!("paperpilot-register-test-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let original = root.join("original.pdf");
        let duplicate = root.join("duplicate.pdf");
        fs::write(&original, b"paper").unwrap();
        fs::write(&duplicate, b"paper").unwrap();
        let mut conn = db();
        let (first, created) = library_fs::register_downloaded_pdf(
            &mut conn,
            &original,
            "same-hash",
            &root.join("internal"),
        )
        .unwrap();
        assert!(created);
        conn.execute(
            "UPDATE documents SET title='Confirmed title',authors='User author' WHERE id=?1",
            [&first.id],
        )
        .unwrap();
        let (second, created) = library_fs::register_downloaded_pdf(
            &mut conn,
            &duplicate,
            "same-hash",
            &root.join("internal"),
        )
        .unwrap();
        assert!(!created);
        assert_eq!(first.id, second.id);
        assert_eq!(second.file_path, original.to_string_lossy());
        assert_eq!(second.title, "Confirmed title");
        assert_eq!(second.authors, "User author");
        assert!(library_fs::register_downloaded_pdf(
            &mut conn,
            &original,
            "different-hash",
            &root.join("internal")
        )
        .is_err());
        assert_eq!(
            conn.query_row("SELECT hash FROM documents WHERE id=?1", [&first.id], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "same-hash"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn in_flight_refresh_cannot_restore_an_unlinked_profile() {
        let c = db();
        c.execute("INSERT INTO documents(id,title,file_name,file_path,hash,created_at,updated_at) VALUES ('doc','T','t.pdf','/original.pdf','hash','now','now')", []).unwrap();
        let p = DocumentScholarlyProfile {
            document_id: "doc".into(),
            paper: ScholarlyPaper::default(),
            local_version: None,
            fetched_at: now(),
            arxiv_fetched_at: String::new(),
            open_alex_fetched_at: String::new(),
            confirmed_fields: vec![],
            enrichment_error: String::new(),
        };
        save_profile(&c, &p).unwrap();
        let initial = serde_json::to_string(&p).unwrap();
        let mut changed = p.clone();
        changed.paper.open_alex_id = "W1".into();
        save_refreshed_profile(&c, &changed, &initial).unwrap();
        assert!(
            save_refreshed_profile(&c, &p, &initial).is_err(),
            "another confirmed link must win over an older refresh"
        );
        c.execute("DELETE FROM scholarly_profiles WHERE document_id='doc'", [])
            .unwrap();
        assert!(
            save_refreshed_profile(&c, &changed, &serde_json::to_string(&changed).unwrap())
                .is_err()
        );
        assert!(profile(&c, "doc").unwrap().is_none());
    }
    #[test]
    fn cache_expiry_offline_fallback_and_limits_preserve_provenance() {
        let root = std::env::temp_dir().join(format!("paperpilot-cache-test-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("test.sqlite3");
        let open = || Connection::open(&path).map_err(|e| e.to_string());
        let c = open().unwrap();
        migrate(&c).unwrap();
        let guard = OperationGuard::new("cache-test").unwrap();
        let body = r#"{"results":[],"meta":{"count":0}}"#.to_string();
        let first =
            cached_body(&open, "works", false, false, &guard.op, || Ok(body.clone())).unwrap();
        assert!(!first.2);
        let cached = cached_body(&open, "works", false, false, &guard.op, || {
            panic!("fresh cache must avoid network")
        })
        .unwrap();
        assert_eq!(cached, first);
        c.execute(
            "UPDATE scholarly_cache SET fetched_at='2000-01-01T00:00:00Z' WHERE key='works'",
            [],
        )
        .unwrap();
        let offline = cached_body(&open, "works", false, false, &guard.op, || {
            Err("network unavailable".into())
        })
        .unwrap();
        assert!(offline.2);
        assert_eq!(offline.1, "2000-01-01T00:00:00Z");
        for error in ["RATE_LIMIT: limited", "AUTH_OR_LIMIT: key", "CANCELLED"] {
            assert_eq!(
                cached_body(&open, "works", false, true, &guard.op, || Err(error.into()))
                    .unwrap_err(),
                error
            );
        }
        assert!(
            cached_body(&open, "bad-json", false, false, &guard.op, || Ok(
                "not JSON".into()
            ))
            .is_err()
        );
        assert!(
            cached_body(&open, "bad-schema", false, false, &guard.op, || Ok(
                "{}".into()
            ))
            .is_err()
        );
        assert!(
            cached_body(&open, "bad-atom", true, false, &guard.op, || Ok(
                "<html>blocked</html>".into()
            ))
            .is_err()
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM scholarly_cache", [], |r| r
                .get::<_, usize>(0))
                .unwrap(),
            1
        );
        drop(c);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn openalex_missing_count_is_not_zero() {
        let p = openalex_paper(
            &json!({"display_name":"T","locations":[{"landing_page_url":"https://arxiv.org/abs/2401.01234"}],"abstract_inverted_index":{"world":[1],"hello":[0]}}),
        );
        assert_eq!(p.cited_by_count, None);
        assert_eq!(p.abstract_text, "hello world");
        assert_eq!(p.arxiv_id, "2401.01234");
        assert_eq!(
            openalex_paper(&json!({"cited_by_count":0})).cited_by_count,
            Some(0)
        );
        assert!(!same_work(
            &p,
            &ScholarlyPaper {
                title: "T".into(),
                ..Default::default()
            }
        ));
    }
    #[test]
    fn cancellation_interrupts_wait() {
        let op = Operation::new("test-cancel").unwrap();
        scholarly_cancel("test-cancel".into());
        assert_eq!(op.wait(Duration::from_secs(3)).unwrap_err(), "CANCELLED");
    }
}
