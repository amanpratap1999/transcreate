# transcreate 🌐

> **Cultural Transcreation & Intent Diff Engine for Technical Documentation**  
> Adapting developer tutorials, blogs, and documentation guides across both explanatory narrative prose and companion code blocks while generating an auditable, interactive HTML Intent Diff.

[![Test Status](https://img.shields.io/badge/tests-15%20passing-brightgreen.svg)](#testing)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Zero Config](https://img.shields.io/badge/CLI-Zero--Config-orange.svg)](#quickstart)

---

## The Problem

Global technical writing suffers from a fundamental dilemma:
1. **Traditional Translation Tools (Crowdin, DeepL, Weblate):** Perform literal word replacement. They translate American sporting metaphors (*"batter at home plate"*, *"strikes"*, *"innings"*) directly into foreign words that make zero sense to local developers.
2. **Blind LLM Rewrites:** When prompted to rewrite Markdown, frontier models frequently break indentation, hallucinate invalid code syntax, alter frontmatter schemas, or mangle documentation URLs and image links.

## The Solution: `transcreate`

`transcreate` provides an AST-safe cultural transcreation pipeline:
* **AST Separation:** Parses technical Markdown / MDX via `unified` and `remark-parse`/`remark-mdx`. Isolates frontmatter, URLs, image destinations, and custom React documentation tags (`<Callout>`, `<Tabs>`) as immutable tokens.
* **Code AST Co-Adaptation (`recast` + `@babel/parser`):** Discovers and adapts domain variable names and mock data string literals in JavaScript/TypeScript code blocks while preserving comments, formatting, and protecting imported libraries.
* **Reverse Bottom-Up Splicing (`magic-string`):** Patches documents from bottom to top based on descending character offsets, guaranteeing zero multibyte drift when inserting CJK (Japanese/Chinese) or Devanagari (Hindi) text.
* **Inline Backtick Synchronization:** Automatically keeps prose backtick references (e.g., `` `passengerQueue` `` and `` `cancelTicket()` ``) in sync with AST code modifications.
* **Comprehensive Review Workstation (`.diff.html`):** A single-file, self-contained interactive review workstation with zero CDN dependencies that runs completely offline.

---

## Quickstart

### 1. Run via CLI

```bash
# Transcreate a Markdown or MDX tutorial for Japanese
npx transcreate fixtures/baseball-tutorial.md --to ja-JP

# Transcreate for Hindi with Tatkal railway queuing mental model
npx transcreate fixtures/baseball-tutorial.md --to hi-IN

# Dry run: generate the review workstation without touching markdown on disk
npx transcreate docs/guide.md --to de-DE --dry-run
```

### 2. Launch Local Review Server with Live Sync

```bash
# Start review workstation with bidirectional live disk sync
npx transcreate fixtures/baseball-tutorial.md --to ja-JP --port 3000
```

---

## Review Workstation Modes

The generated `{filename}.{locale}.diff.html` requires no local server and zero internet access. Open it in any browser to access:

1. **Split View:** Side-by-side synchronized scrolling between original English text and localized transcreation with section-level Accept/Reject controls.
2. **Unified PR Diff:** GitHub-style line and word diff showing additions and deletions.
3. **Rendered Article Preview:** Full publication preview with Dark Mode and Light Mode theme toggle.
4. **Interactive Intent Drawer:**
   - Displays the detected source metaphor and regional target adaptation.
   - Explains the cultural mismatch reason and technical rationale.
   - **Neutral Technical Fallback:** 1-click option to switch to a zero-metaphor, direct technical explanation for engineers who prefer factual clarity.
5. **1-Click Export:** Download the approved localized Markdown with custom reviewer selections applied.

---

## Configuration & Project Memory

Initialize project configuration and analogy memory:

```bash
npx transcreate init
```

Generates `transcreate.config.json` and `.transcreate/glossary.json`:

```json
{
  "defaultTargetLocale": "ja-JP",
  "glossaryPath": ".transcreate/glossary.json",
  "locales": {
    "ja-JP": {
      "preferredDomains": ["train-dispatching", "sushi-conveyor", "convenience-store"],
      "avoidedMetaphors": ["american-football", "baseball-dugout"]
    },
    "hi-IN": {
      "preferredDomains": ["railway-reservation", "cricket", "chai-stall-supply-chain"],
      "avoidedMetaphors": ["ice-hockey"]
    }
  }
}
```

---

## Architecture

```
                                  ┌────────────────────────┐
                                  │   Input Markdown/MDX   │
                                  └───────────┬────────────┘
                                              │
                              [unified + remark-parse/mdx/gfm]
                                              │
                      ┌───────────────────────┴────────────────────────┐
                      ▼                                                ▼
           ┌──────────────────────┐                         ┌──────────────────────┐
           │ Prose AST Nodes      │                         │ Code Fence AST Nodes │
           │ - URL/Image Masking  │                         │ - Abstract CodeAdapter│
           │ - Headings, Paras,   │                         │ - JS/TS Recast visitor│
           │   Tables, Callouts   │                         │ - Non-JS Fences Frozen│
           └──────────┬───────────┘                         └──────────┬───────────┘
                      │                                                │
                      │               ┌─────────────────┐              │
                      └──────────────►│  LLM Pipeline   │◄─────────────┘
                                      │  (Zod Schema)   │
                                      └────────┬────────┘
                                               │
                                      [Transcreation Result]
                                      - Localized Prose Text
                                      - Symbol Table & Mock Substitutions
                                      - Intent Cards + Neutral Fallback
                                      - Project Glossary Cache Update
                                               │
                                               ▼
                                  ┌────────────────────────┐
                                  │ Programmatic AST Swap  │
                                  │ (recast.visit AST swap)│
                                  └───────────┬────────────┘
                                              │
                                              ▼
                                  ┌────────────────────────┐
                                  │ Static AST Validator   │
                                  │ (Babel re-parse check, │
                                  │  1-shot LLM repair)    │
                                  └───────────┬────────────┘
                                              │
                                              ▼
                                  ┌────────────────────────┐
                                  │ Bottom-Up Splicer      │
                                  │ (magic-string sorted   │
                                  │  descending by offset) │
                                  └───────────┬────────────┘
                                              │
                      ┌───────────────────────┴────────────────────────┐
                      ▼                                                ▼
           ┌──────────────────────┐                         ┌──────────────────────┐
           │ Output Localized MD  │                         │ Comprehensive Review │
           │ ({name}.{lang}.md)   │                         │ Workstation (HTML)   │
           └──────────────────────┘                         └──────────────────────┘
```

---

## Testing

Run the full automated test suite:

```bash
npm test
```

### Test Coverage
* `test/code-adapter.test.ts`: AST symbol extraction, programmatic renaming with comments preserved, imported symbol boundary protection, syntax validation.
* `test/markdown-parser.test.ts`: YAML frontmatter immutability, MDX element preservation, URL/image masking, bottom-up reverse offset multibyte splicing.
* `test/validator.test.ts`: Static AST syntax validation, 1-shot repair loop, and correlated rollback.
* `test/bundler.test.ts`: Offline single-file HTML generation with zero CDN links and keyboard navigation.
* `test/integration.test.ts`: End-to-end transcreation pipeline for `ja-JP` and `hi-IN`.

---

## License

MIT
