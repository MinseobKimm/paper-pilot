# Paper Pilot

Your papers. Your questions. Your margins. Your agent.

Paper Pilot is a local-first desktop reader for academic PDFs. It keeps the original paper, page-aware reading state, translations, highlights, notes, citation cards, and AI answers in one persistent workspace.

![Tauri](https://img.shields.io/badge/Tauri-2-333333?style=flat-square&labelColor=000000)
![React](https://img.shields.io/badge/React-18-333333?style=flat-square&labelColor=000000)
![TypeScript](https://img.shields.io/badge/TypeScript-5-333333?style=flat-square&labelColor=000000)
![Rust](https://img.shields.io/badge/Rust-backend-333333?style=flat-square&labelColor=000000)
![PDF.js](https://img.shields.io/badge/PDF.js-reader-333333?style=flat-square&labelColor=000000)
![SQLite](https://img.shields.io/badge/SQLite-local-333333?style=flat-square&labelColor=000000)

[Korean README](docs/README.ko.md)

## What It Does

Most PDF readers show pages. Most chat tools answer questions away from the paper. Paper Pilot joins the two: the PDF remains the source of truth, and every useful result can return to the paper as a saved study record.

```text
Import papers -> Read in context -> Ask an agent -> Save the result -> Export when needed
```

## Product Tour

### Library

![Paper Pilot library workspace](docs/images/paper-pilot-library.png)

Turn a folder of PDFs into a searchable reading queue. Add papers, create folders, bookmark important work, and edit title, authors, year, abstract, and folder metadata without leaving the app.

### Reader

![Paper Pilot reader workspace](docs/images/paper-pilot-reader.png)

Read the original PDF with outline navigation, page search, zoom, highlights, link previews, selection tools, and a persistent AI panel. Extracted page text, layout decisions, translations, word lists, zoom, and reading position are stored locally for faster return visits.

### Visual Explanation

![Paper Pilot visual explanation](docs/images/paper-pilot-image-explain.png)

Ask about a selected page region, figure, table, or equation. Paper Pilot sends only the task context needed by the selected agent and saves the answer back to the paper.

## Core Features

- Local-first paper workspace with SQLite state and local files.
- Page-aware text selection for single-column and two-column papers.
- Sentence-level Korean translation beside the original PDF page.
- Korean word meanings and technical-term popups built from paper context.
- AI explanations for selected text, page regions, figures, equations, and paper-level questions.
- Citation cards with reference extraction, link enrichment, rationale notes, and BibTeX/CSV export.
- Study export as local JSON/ZIP bundles.

## Ask AI Paper Q&A

Paper Pilot offers three paper chat modes:

| Mode | Best for | How it works |
| --- | --- | --- |
| `Auto` | Letting the selected agent choose the path | The agent rewrites the question in English and chooses Fast or Deep. |
| `Fast` | Quick, text-grounded questions | Uses PaperQA2-powered evidence search over Reader-indexed page text, then answers from retrieved evidence with page citations. |
| `Deep` | Equations, figures, tables, algorithms, layout-sensitive details, and complex cross-page reasoning | Gives the selected agent the original PDF path plus a compact document context pack for a full-paper pass. |

Fast mode is powered by [PaperQA2](https://github.com/Future-House/paper-qa), installed through the Python package `paper-qa>=5` in `requirements.txt`. It keeps answers tied to the page text that Paper Pilot has already indexed. When Fast evidence is thin, the answer is marked as evidence-limited and the reader can continue with Deep for a more complete pass.

## Privacy Model

Paper Pilot is built around local files and local state. AI providers receive only the context needed for the task you run, such as selected text, page excerpts, an image crop, or the original PDF path for Deep mode. For private or unpublished papers, choose the provider deliberately.

## Language Support

- Interface: English and Korean.
- Translation target: Korean.

## Install

### Prerequisites

- Node.js 20+
- npm
- Rust stable toolchain
- Tauri 2 system prerequisites for your OS
- Python 3.11+
- Codex CLI or Claude Code CLI for full agent execution

### Clone

```bash
git clone https://github.com/MinseobKimm/paper-pilot.git
cd paper-pilot
```

### Install App And Retrieval Dependencies

```bash
npm install
npm run setup:python
```

`npm run setup:python` runs `python -m pip install -r requirements.txt`. That installs PaperQA2 through `paper-qa>=5`, which Fast Q&A expects. On Windows, `py -3 -m pip install -r requirements.txt` is also fine when the Python launcher is configured for Python 3.11 or newer.

## Run

### Desktop App

```bash
npm run tauri:dev
```

### Browser Preview

```bash
npm run dev
```

Open `http://127.0.0.1:5174`. The browser preview is useful for interface work; native file storage, SQLite persistence, and worker execution are available in the Tauri desktop app.

## Build

```bash
npm run build
npm run tauri:build
```

The production executable is generated under:

```text
src-tauri/target/release/
```

## Check

```bash
npm test
npm run desktop:check
```

`npm test` runs the TypeScript and Vite build check. `npm run desktop:check` checks the Rust/Tauri backend.

## Provider Setup

Open Settings in Paper Pilot and choose a provider.

| Provider | Setup |
| --- | --- |
| Local draft | No external setup; useful for UI smoke checks. |
| Codex CLI | Install Codex CLI and make sure `codex` is on `PATH`, or set `CODEX_BIN`. |
| Claude Code | Install Claude Code and make sure `claude` is on `PATH`, or set `CLAUDE_CODE_BIN`. |

The bridge folder defaults to:

```text
bridge/
  outbox/     task JSON files
  inbox/      result JSON files
  logs/       worker logs
```

## Repository Layout

```text
paper-pilot/
  src/                 React UI and reading workflow
  src/lib/             AI bridge, translation, citations, scholarly lookup
  src-tauri/           Tauri backend, SQLite, worker commands
  retrieval-adapter/   Fast Q&A retrieval bridge
  docs/                Korean README and product screenshots
```

`bridge/`, `dist/`, release artifacts, QA captures, local PDFs, and agent outputs are runtime files. They are created locally and kept out of the repository.

## Third-party Attribution

Paper Pilot integrates third-party projects as dependencies and keeps their licenses separate from this repository's source license.

- PaperQA2 / `paper-qa`: used by Fast Q&A for evidence retrieval. Source: [Future-House/paper-qa](https://github.com/Future-House/paper-qa). Package: [paper-qa on PyPI](https://pypi.org/project/paper-qa/). License: Apache License 2.0, copyright FutureHouse.
- PaperQA2 research citation: Skarlinski et al., "Language agents achieve superhuman synthesis of scientific knowledge", arXiv:2409.13740. Use the upstream [CITATION.cff](https://github.com/Future-House/paper-qa/blob/main/CITATION.cff) when publishing work that relies on PaperQA2 results.

Paper Pilot does not vendor PaperQA2 source code. It calls the installed Python package through the local retrieval adapter.

## License

Paper Pilot is released under the [Apache License 2.0](LICENSE).

This license applies to the source code in this repository. Third-party libraries, AI providers, model outputs, and papers opened with Paper Pilot remain governed by their own licenses and terms.

## Contributing

Pull requests are welcome. Useful areas include reader polish, provider adapters, citation workflows, installers, export formats, and library ergonomics.

Before opening a PR:

```bash
npm test
npm run desktop:check
```
