[English README](../README.md) · 한국어

# Paper Pilot

당신의 논문. 당신의 질문. 당신의 여백 메모. 당신의 agent.

Paper Pilot은 학술 PDF를 위한 local-first 데스크톱 리더입니다. 원문 PDF, 페이지별 읽기 상태, 번역, 하이라이트, 노트, 인용 카드, AI 답변을 하나의 오래 남는 연구 작업 공간에 묶어 둡니다.

![Tauri](https://img.shields.io/badge/Tauri-2-333333?style=flat-square&labelColor=000000)
![React](https://img.shields.io/badge/React-18-333333?style=flat-square&labelColor=000000)
![TypeScript](https://img.shields.io/badge/TypeScript-5-333333?style=flat-square&labelColor=000000)
![Rust](https://img.shields.io/badge/Rust-backend-333333?style=flat-square&labelColor=000000)
![PDF.js](https://img.shields.io/badge/PDF.js-reader-333333?style=flat-square&labelColor=000000)
![SQLite](https://img.shields.io/badge/SQLite-local-333333?style=flat-square&labelColor=000000)

[English README](../README.md)

## 무엇을 하는 앱인가

대부분의 PDF 리더는 페이지를 보여주는 데서 멈춥니다. 대부분의 채팅 도구는 답변을 논문 밖에서 처리합니다. Paper Pilot은 둘을 합칩니다. PDF는 계속 원본 근거로 남고, 유용한 결과는 다시 논문 옆의 학습 기록으로 돌아옵니다.

```text
논문 가져오기 -> 원문 읽기 -> agent에게 질문 -> 결과 저장 -> 필요할 때 내보내기
```

## 제품 둘러보기

### 라이브러리

![Paper Pilot library workspace](images/paper-pilot-library.png)

PDF 폴더를 검색 가능한 독해 대기열로 바꿉니다. 논문을 추가하고, 폴더를 만들고, 중요한 논문을 북마크하고, 제목, 저자, 연도, 초록, 폴더 정보를 앱 안에서 수정할 수 있습니다.

### Reader

![Paper Pilot reader workspace](images/paper-pilot-reader.png)

원문 PDF를 보면서 목차 이동, 페이지 검색, 확대/축소, 하이라이트, 링크 미리보기, 선택 도구, AI 패널을 함께 사용합니다. 추출된 페이지 텍스트, 레이아웃 판단, 번역, 단어 목록, 확대 비율, 읽던 위치는 로컬에 저장되어 다시 열 때 빠르게 돌아올 수 있습니다.

### 시각 자료 설명

![Paper Pilot visual explanation](images/paper-pilot-image-explain.png)

선택한 페이지 영역, 그림, 표, 수식에 대해 질문할 수 있습니다. Paper Pilot은 선택된 agent에 필요한 작업 맥락만 전달하고, 답변을 다시 논문 기록으로 저장합니다.

## 기본 사용법

### 상단바

![Paper Pilot top bar controls](images/usage-top-bar.png)

- Library 버튼은 앱 어디에서든 논문 라이브러리로 돌아갑니다.
- Settings 버튼은 언어, provider, 번역, 화면 표시 설정을 엽니다.
- Reader에서는 Outline 버튼으로 왼쪽 목차 패널을 열고 닫고, Translation 버튼으로 문장 번역 패널을 열고 닫습니다.
- 확대 비율 선택, 확대/축소 버튼, 페이지 번호 입력, 검색창으로 PDF 안에서 이동합니다.
- Share 버튼은 열린 논문의 페이지 이미지나 주석 렌더링이 준비되어 있을 때 읽기용 사본을 내보냅니다.
- Panel 버튼은 AI, 하이라이트, 노트, 인용을 다루는 오른쪽 작업 패널을 열고 닫습니다.

### 라이브러리 사이드바

![Paper Pilot library sidebar](images/usage-library-sidebar.png)

- Add PDF로 선택한 폴더에 논문을 가져옵니다.
- 폴더 영역에서 폴더를 만들고, 폴더를 선택해 라이브러리를 필터링합니다.
- 검색창은 제목, 저자, 연도, 초록, 폴더 맥락으로 논문을 찾습니다.
- 논문 카드를 열어 Reader로 들어가고, 중요한 논문은 북마크하며, 라이브러리 inspector에서 논문 정보를 수정합니다.
- 여러 논문을 한 번에 옮기거나 삭제할 때는 다중 선택을 사용합니다.

### Reader 패널

![Paper Pilot reader panels](images/usage-reader-panels.png)

- 왼쪽 목차 패널은 감지된 섹션이나 페이지로 이동합니다. 제목을 보고 싶으면 list view, 페이지를 촘촘히 보고 싶으면 grid view를 사용합니다.
- 번역 패널은 현재 페이지의 문장 단위 한국어 번역을 원문 옆에 보여줍니다. 새 번역이 필요하면 refresh를 누르고, 번역 문장을 클릭하면 PDF의 해당 문장과 동기화됩니다.
- 오른쪽 패널에는 Study tools, Highlights, Quote cards, Notes, Citations 탭이 있습니다. Study는 논문 Q&A, Highlights는 저장한 표시, Notes는 Markdown 노트, Citations는 참고문헌 추출과 내보내기에 사용합니다.

### PDF 도구

![Paper Pilot floating PDF tools](images/usage-pdf-tools.png)

- 텍스트를 선택하면 빠른 툴바가 열립니다. Explain, Highlight, Translate, Comment, Copy를 바로 실행할 수 있습니다.
- 떠 있는 Reader 도구로 하이라이트 색 선택, 하이라이트 지우기, 영역 설명, 현재 위치 북마크, 자동 번역, 단어 뜻 조회, 누락 단어 뜻 생성을 사용할 수 있습니다.
- AI 답변 안의 페이지 인용을 클릭하면 해당 PDF 페이지로 이동합니다.

## 핵심 기능

- SQLite와 로컬 파일을 사용하는 local-first 논문 작업 공간.
- single-column, two-column 논문을 고려한 페이지별 텍스트 선택.
- 원문 PDF 페이지 옆에 붙는 문장 단위 한국어 번역.
- 논문 맥락을 반영한 한국어 단어 뜻과 전문 용어 팝업.
- 선택 텍스트, 페이지 영역, 그림, 수식, 논문 전체 질문에 대한 AI 설명.
- 참고문헌 추출, 링크 보강, 인용 이유 메모, BibTeX/CSV 내보내기를 지원하는 인용 카드.
- JSON/ZIP 형태의 로컬 학습 번들 export.

## Ask AI 논문 Q&A

Paper Pilot의 논문 채팅은 세 가지 모드로 동작합니다.

| 모드 | 적합한 질문 | 동작 방식 |
| --- | --- | --- |
| `Auto` | agent가 경로를 고르게 하고 싶을 때 | agent가 질문을 영어로 옮기고 Fast 또는 Deep을 선택합니다. |
| `Fast` | 빠르게 텍스트 근거 기반 답변을 보고 싶을 때 | PaperQA2 기반 근거 검색으로 Reader가 인덱싱한 페이지 텍스트에서 근거를 찾고, 그 근거와 페이지 인용을 바탕으로 답합니다. |
| `Deep` | 수식, 그림, 표, 알고리즘, 레이아웃, 복잡한 교차 페이지 추론이 필요할 때 | 선택된 agent에 원본 PDF 경로와 compact document context pack을 전달해 논문 전체를 더 깊게 읽습니다. |

Fast 모드는 [PaperQA2](https://github.com/Future-House/paper-qa)를 사용합니다. PaperQA2는 `requirements.txt`의 `paper-qa>=5` Python 패키지로 설치됩니다. Fast 답변은 Paper Pilot이 이미 인덱싱한 페이지 텍스트에 연결되어 페이지 인용을 유지합니다. 근거가 얕다고 판단되면 답변에 그 한계를 표시하고, 더 완전한 독해가 필요할 때 Deep으로 이어갈 수 있습니다.

## 개인정보와 로컬 상태

Paper Pilot은 로컬 파일과 로컬 상태를 중심으로 동작합니다. AI provider에는 사용자가 실행한 작업에 필요한 맥락만 전달됩니다. 예를 들어 선택 텍스트, 페이지 excerpt, 이미지 crop, Deep 모드의 원본 PDF 경로가 포함될 수 있습니다. 비공개 또는 미공개 논문을 읽을 때는 사용할 provider를 신중하게 선택하세요.

## 언어 지원

- 인터페이스: 영어와 한국어.
- 번역 대상 언어: 한국어.

## 설치

### 사전 준비

- Node.js 20+
- npm
- Rust stable toolchain
- 사용 중인 OS에 맞는 Tauri 2 system prerequisites
- Python 3.11+
- 전체 agent 실행을 위한 Codex CLI 또는 Claude Code CLI

### Clone

```bash
git clone https://github.com/MinseobKimm/paper-pilot.git
cd paper-pilot
```

### 앱과 retrieval 의존성 설치

```bash
npm install
npm run setup:python
```

`npm run setup:python`은 `python -m pip install -r requirements.txt`를 실행합니다. 이 단계에서 Fast Q&A가 기대하는 PaperQA2가 `paper-qa>=5`로 설치됩니다. Windows에서 Python launcher를 쓰고 있고 Python 3.11 이상으로 연결되어 있다면 `py -3 -m pip install -r requirements.txt`를 사용해도 됩니다.

## 실행

### 데스크톱 앱

```bash
npm run tauri:dev
```

### 브라우저 프리뷰

```bash
npm run dev
```

브라우저에서 `http://127.0.0.1:5174`를 엽니다. 브라우저 프리뷰는 UI 작업에 유용합니다. Native file storage, SQLite persistence, worker execution은 Tauri 데스크톱 앱에서 사용할 수 있습니다.

## 빌드

```bash
npm run build
npm run tauri:build
```

프로덕션 실행 파일은 아래 경로에 생성됩니다.

```text
src-tauri/target/release/
```

## 체크

```bash
npm test
npm run desktop:check
```

`npm test`는 TypeScript와 Vite build check를 실행합니다. `npm run desktop:check`는 Rust/Tauri backend를 검사합니다.

## Provider 설정

Paper Pilot의 Settings에서 provider를 선택합니다.

| Provider | 설정 |
| --- | --- |
| Local draft | 외부 설정이 필요 없으며 UI smoke check에 유용합니다. |
| Codex CLI | Codex CLI를 설치하고 `codex`가 `PATH`에 잡히게 하거나 `CODEX_BIN`을 지정합니다. |
| Claude Code | Claude Code를 설치하고 `claude`가 `PATH`에 잡히게 하거나 `CLAUDE_CODE_BIN`을 지정합니다. |

## Third-party Attribution

Paper Pilot은 third-party 프로젝트를 의존성으로 통합하며, 각 프로젝트의 라이선스는 이 저장소의 소스 라이선스와 별도로 유지됩니다.

- PaperQA2 / `paper-qa`: Fast Q&A의 evidence retrieval에 사용합니다. Source: [Future-House/paper-qa](https://github.com/Future-House/paper-qa). Package: [paper-qa on PyPI](https://pypi.org/project/paper-qa/). License: Apache License 2.0, copyright FutureHouse.
- PaperQA2 연구 인용: Skarlinski et al., "Language agents achieve superhuman synthesis of scientific knowledge", arXiv:2409.13740. PaperQA2 결과에 의존한 작업을 출판하거나 공개할 때는 upstream [CITATION.cff](https://github.com/Future-House/paper-qa/blob/main/CITATION.cff)를 따르세요.

Paper Pilot은 PaperQA2 소스 코드를 vendoring하지 않습니다. 로컬 retrieval adapter를 통해 설치된 Python 패키지를 호출합니다.

## 라이선스

Paper Pilot은 [Apache License 2.0](../LICENSE)으로 공개됩니다.

이 라이선스는 이 저장소의 소스 코드에 적용됩니다. Paper Pilot에서 사용하는 third-party libraries, AI providers, model outputs, 사용자가 여는 논문과 PDF는 각각의 라이선스와 이용약관을 따릅니다.
