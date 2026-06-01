[English README](../README.md) · 한국어

# Paper Pilot

당신의 논문. 당신의 질문. 당신의 여백 메모. 당신의 agent.

Paper Pilot은 학술 PDF를 오래 남는 연구 작업 공간으로 바꾸는 local-first 데스크톱 리더입니다. 설명, 하이라이트, 노트, 번역, 인용 카드, AI 답변이 모두 그 답을 만든 논문에 붙어 있습니다.

![Tauri](https://img.shields.io/badge/Tauri-2-333333?style=flat-square&labelColor=000000)
![React](https://img.shields.io/badge/React-18-333333?style=flat-square&labelColor=000000)
![TypeScript](https://img.shields.io/badge/TypeScript-5-333333?style=flat-square&labelColor=000000)
![Rust](https://img.shields.io/badge/Rust-backend-333333?style=flat-square&labelColor=000000)
![PDF.js](https://img.shields.io/badge/PDF.js-reader-333333?style=flat-square&labelColor=000000)
![SQLite](https://img.shields.io/badge/SQLite-local-333333?style=flat-square&labelColor=000000)
![AI Agent](https://img.shields.io/badge/AI-agent_bridge-333333?style=flat-square&labelColor=000000)

[English README](../README.md)

## 📸 Paper Pilot 미리보기

### 📚 라이브러리 작업 공간

![Paper Pilot library workspace](images/paper-pilot-library.png)

라이브러리는 PDF 폴더를 깔끔한 독해 대기열로 바꿉니다. 선택한 폴더에 논문을 추가하고, `Math` 같은 하위 폴더를 만들고, 제목/저자/연도/초록으로 검색하며, 각 논문을 선택과 북마크가 가능한 카드 형태로 관리합니다. 별도 인용 관리자부터 열지 않아도 수집한 논문을 바로 읽기 흐름으로 넘길 수 있게 설계했습니다.

### 🧠 Reader, 번역, AI 패널

![Paper Pilot reader workspace](images/paper-pilot-reader.png)

Reader는 네 개의 작업 영역을 한 화면에 묶습니다. 왼쪽에는 AI outline, 중앙에는 원문 PDF, 오른쪽에는 페이지 정렬 번역 sidecar, 가장 오른쪽에는 AI panel이 있습니다. 스크린샷처럼 선택 구절을 하이라이트하고, 현재 페이지를 한국어로 번역하고, keyword dictionary와 3-line summary를 만들고, 질문 입력창과 document outline을 같은 공간에 유지합니다.

### 🖼️ 그림과 영역 설명

![Paper Pilot visual explanation](images/paper-pilot-image-explain.png)

이미지 설명은 figure나 잘라낸 페이지 영역을 다룹니다. plot, table, equation, architecture diagram, crop 영역을 선택하면 Paper Pilot이 해당 이미지와 주변 논문 맥락을 agent task로 보냅니다. 결과는 그림이 무엇을 비교하는지, 수식 표기가 어떤 의미인지, 그 figure가 논문 주장과 어떻게 연결되는지를 설명합니다. 캡션만으로 부족한 실험 그래프와 수식 많은 페이지에 특히 유용합니다.

> 개인정보 안내. Paper Pilot은 로컬 파일과 로컬 상태를 중심으로 동작합니다. AI provider에는 사용자가 실행한 작업에 필요한 맥락만 전달됩니다. 예를 들어 선택 텍스트, 페이지 excerpt, 이미지 crop 등이 포함될 수 있습니다. 비공개 논문을 읽을 때는 사용할 agent provider를 신중하게 선택하세요.

대부분의 PDF 리더는 페이지를 보여주는 데서 멈춥니다. 대부분의 AI 채팅은 답변의 출처가 어느 페이지였는지 오래 기억하지 못합니다. Paper Pilot은 둘을 합칩니다. PDF는 계속 원본 근거로 남고, agent의 결과는 논문별 학습 기록으로 축적됩니다.

* * *

## 🧠 Paper Pilot이 의미하는 것

Paper Pilot은 AI 버튼이 붙은 일반 문서 뷰어가 아닙니다. 실제 연구자가 논문을 읽는 흐름에 맞춰 만든 작업 공간입니다.

```text
논문 추가 -> 원문 읽기 -> agent에게 질문 -> 결과 저장 -> 필요할 때 내보내기
```

핵심은 단순합니다. 논문에 대해 던진 질문은 채팅 기록 속으로 사라지면 안 됩니다. 설명, 하이라이트, 노트, 인용 이유, 번역, export 가능한 기록으로 다시 논문에 돌아와야 합니다.

## ⚡ 일반 PDF 리더가 못 하는 것

연구 작업은 보통 너무 많은 앱으로 쪼개집니다.

- PDF 리더는 페이지를 보여주지만 질문을 이해하지 못합니다.
- 채팅 앱은 답하지만 정확한 논문 맥락을 잃기 쉽습니다.
- 인용 관리자는 참고문헌을 저장하지만 왜 인용해야 하는지는 남기지 않습니다.
- 번역 도구는 텍스트를 번역하지만 원문 페이지에서 떼어냅니다.
- 노트 앱은 생각을 저장하지만 PDF와의 연결은 직접 관리해야 합니다.
- 많은 AI-first reader는 직접 model API를 요구하기 때문에, 읽기 workflow를 시작하기 전부터 별도 사용 비용, API key 설정, billing 관리가 생길 수 있습니다.

Paper Pilot은 이 조각들을 한곳에 둡니다.

| 기준 | Paper Pilot | 일반적인 PDF + Chat 흐름 |
| --- | --- | --- |
| 논문 맥락 | 페이지, 선택 영역, 문서 단위 맥락 유지 | 직접 복사해서 채팅에 붙여넣기 |
| AI 결과 | 논문 옆에 저장 | 별도 대화창에 묻힘 |
| 하이라이트 | 수동 + agent-assisted | 대부분 수동 |
| 번역 | PDF 옆 sidecar로 유지 | 분리된 텍스트 결과 |
| 인용 | 이유와 함께 reference card로 저장 | 별도 관리, rationale 없음 |
| 저장 | local SQLite + local files | 여러 앱에 분산 |
| AI 비용 구조 | 선택 가능한 agent provider와 local draft mode로 동작 | 별도 model API key와 사용량 기반 billing이 필요한 경우가 많음 |
| export | JSON/ZIP 학습 번들 | 수동 복사 |

## 🧭 독해 사이클

Paper Pilot은 읽기 흐름을 짧고 눈에 보이게 유지합니다.

| 단계 | 하는 일 | 저장되는 결과 |
| --- | --- | --- |
| 1. 수집 | PDF를 추가하고 폴더로 정리합니다. | Library record |
| 2. 읽기 | 목차, 확대/축소, 검색, 번역, 하이라이트를 PDF 옆에서 사용합니다. | Page-aware reading state |
| 3. 질문 | 선택 텍스트, 페이지 맥락, 이미지 crop을 agent에게 보냅니다. | Explanation, summary, answer |
| 4. 저장 | 유용한 결과를 하이라이트, 노트, 인용 카드, export bundle로 남깁니다. | Persistent paper memory |

## 🔎 논문 Q&A를 위한 Local RAG

Paper Pilot의 논문 채팅은 현재 읽고 있는 PDF를 근거로 삼습니다.

사용자가 질문을 입력하면 앱은 추출된 페이지 텍스트에서 local retrieval context를 만듭니다. 논문을 겹치는 chunk로 나누고, BM25-style lexical scoring으로 관련성이 높은 문단을 고른 뒤, 가장 강한 page excerpt를 agent task에 함께 보냅니다. Agent는 이 retrieved excerpt를 근거로 답하고, 페이지 번호를 함께 인용하도록 지시받습니다.

그래서 논문 Q&A가 원문에서 덜 벗어납니다.

- 답변이 모델 기억에만 기대지 않고 retrieved PDF passage를 기반으로 합니다.
- 검색된 snippet에는 page number와 match score가 함께 남습니다.
- match가 약하면 PDF만으로 근거가 부족하다고 말하도록 처리합니다.
- local retrieval 경로에는 별도의 vector database가 필요하지 않습니다.

## 🤖 Agent Bridge

Paper Pilot은 인터페이스를 특정 모델 provider 하나에 고정하지 않습니다. 앱은 구조화된 작업을 만들고, 선택된 agent가 처리한 뒤, 결과를 다시 로컬 작업 공간에 저장합니다.

```text
논문 맥락 -> bridge task -> Codex CLI / Claude Code -> 저장된 결과 -> Reader 갱신
```

UI는 단순하게 유지하고, agent layer는 교체할 수 있게 둔 구조입니다.

지원 provider mode:

| Provider | 언제 쓰나 |
| --- | --- |
| `codex-cli` | Codex CLI 기반 기본 agent workflow를 사용할 때 |
| `claude-code` | Claude Code로 같은 논문 독해 흐름을 쓰고 싶을 때 |
| `local-draft` | 오프라인 UI 데모 또는 빠른 smoke check가 필요할 때 |

## 🖥️ Workspace Tour

| Surface | 역할 |
| --- | --- |
| Library | PDF 추가, 논문 검색, 폴더 관리, 북마크 |
| Reader | 페이지 이동, 확대/축소, 목차, 링크 미리보기, 텍스트 선택 |
| AI panel | 설명, 요약, 논문 Q&A, 하이라이트, 인용, 노트, 문서 정보 |
| Translation sidecar | 번역된 페이지 문장을 원문 페이지 옆에서 읽기 |
| Citation panel | 참고문헌 추출, 링크 보강, 인용 이유 작성, BibTeX/CSV 복사 |

## 🛠️ 내부 구조

| Layer | Stack |
| --- | --- |
| Desktop shell | Tauri 2 |
| UI | React 18 + TypeScript + Vite |
| PDF rendering | PDF.js |
| Math rendering | KaTeX |
| Local state | Rust command 기반 SQLite |
| Agent I/O | `bridge/` 아래 JSON queue |
| Scholarly lookup | OpenAlex API |

Paper Pilot의 작업 상태는 로컬에 저장됩니다. Tauri backend는 PDF import, SQLite persistence, export bundle, worker startup을 처리합니다. React UI는 reader, selection, panel, translation display, agent task orchestration을 담당합니다.

## 🚀 설치

### 🧩 사전 준비

- Node.js 20+
- npm
- Rust stable toolchain
- 사용 중인 OS에 맞는 Tauri 2 prerequisites
- 선택 사항: 전체 agent 실행을 위한 Codex CLI 또는 Claude Code CLI

### 📥 Clone

```bash
git clone https://github.com/MinseobKimm/paper-pilot.git
cd paper-pilot
```

### 📚 의존성 설치

```bash
npm install
```

### 🖥️ 데스크톱 앱 실행

```bash
npm run tauri:dev
```

### 🌐 브라우저 프리뷰 실행

```bash
npm run dev
```

브라우저에서 `http://127.0.0.1:5174`를 엽니다.

브라우저 프리뷰는 UI 작업에 유용합니다. Native file storage, SQLite persistence, worker execution은 Tauri 데스크톱 앱에서 사용할 수 있습니다.

## 📦 빌드

```bash
npm run build
npm run tauri:build
```

프로덕션 실행 파일은 아래 경로에 생성됩니다.

```text
src-tauri/target/release/
```

## ✅ 체크

```bash
npm test
npm run desktop:check
```

`npm test`는 TypeScript와 Vite build check를 실행합니다. `npm run desktop:check`는 Rust/Tauri backend를 검사합니다.

## ⚙️ Provider 설정

Paper Pilot의 **Settings**에서 provider를 선택합니다.

| Provider | 설정 |
| --- | --- |
| Local draft | 별도 설정이 필요 없습니다. |
| Codex CLI | Codex CLI를 설치하고 `codex`가 `PATH`에 잡히게 하거나 `CODEX_BIN`을 지정합니다. |
| Claude Code | Claude Code를 설치하고 `claude`가 `PATH`에 잡히게 하거나 `CLAUDE_CODE_BIN`을 지정합니다. |

기본 bridge folder:

```text
bridge/
  outbox/     task JSON files
  inbox/      result JSON files
  logs/       worker logs
```

## 📁 Repository Layout

```text
paper-pilot/
  src/                 React UI and reading workflow
  src/lib/             AI bridge, RAG, citations, scholarly lookup
  src-tauri/           Tauri backend, SQLite, worker commands
  docs/                Korean README and product screenshots
```

`bridge/`, `dist/`, release artifacts, QA captures, local PDFs, agent outputs는 실행 중 생기는 로컬 파일입니다. 저장소에는 올리지 않도록 제외했습니다.

## 📄 라이선스

Paper Pilot은 [Apache License 2.0](../LICENSE)으로 공개됩니다.

이 라이선스는 이 저장소의 소스 코드에 적용됩니다. Paper Pilot에서 사용하는 third-party libraries, AI providers, model outputs, 사용자가 여는 논문과 PDF는 각각의 라이선스와 이용약관을 따릅니다.

## 🤝 기여

Pull request를 환영합니다. Reader polish, provider adapter, citation workflow, installer, export format, library ergonomics 개선은 특히 좋은 기여 영역입니다.

PR을 열기 전:

```bash
npm test
npm run desktop:check
```
