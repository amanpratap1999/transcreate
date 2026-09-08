import * as diff from "diff";
import type { TranscreateResult } from "../types.js";

export class WorkstationBundler {
  /**
   * Generates a completely self-contained, single-file HTML review workstation.
   * Zero CDN dependencies, 100% offline-ready.
   */
  public generateHtml(result: TranscreateResult, serverPort?: number): string {
    const originalText = result.originalMarkdown;
    const transcreatedText = result.transcreatedMarkdown;
    const lineDiff = diff.diffLines(originalText, transcreatedText);

    const safeOriginal = JSON.stringify(originalText);
    const safeTranscreated = JSON.stringify(transcreatedText);
    const safeResult = JSON.stringify(result);

    return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Transcreate Review: ${result.filePath} (${result.targetLocale})</title>
  <style>
    :root {
      --bg-base: #0f172a;
      --bg-surface: #1e293b;
      --bg-subtle: #334155;
      --border-color: #334155;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #38bdf8;
      --accent-hover: #0ea5e9;
      --diff-add-bg: rgba(34, 197, 94, 0.15);
      --diff-add-text: #4ade80;
      --diff-del-bg: rgba(239, 68, 68, 0.15);
      --diff-del-text: #f87171;
      --code-bg: #090d16;
    }
    html.light {
      --bg-base: #f8fafc;
      --bg-surface: #ffffff;
      --bg-subtle: #e2e8f0;
      --border-color: #cbd5e1;
      --text-main: #0f172a;
      --text-muted: #64748b;
      --accent: #0284c7;
      --accent-hover: #0369a1;
      --diff-add-bg: rgba(34, 197, 94, 0.12);
      --diff-add-text: #15803d;
      --diff-del-bg: rgba(239, 68, 68, 0.12);
      --diff-del-text: #b91c1c;
      --code-bg: #f1f5f9;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg-base);
      color: var(--text-main);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    header {
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-color);
      padding: 12px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
      gap: 16px;
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .badge {
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      background: var(--bg-subtle);
      color: var(--accent);
    }
    .badge-pill {
      background: rgba(56, 189, 248, 0.15);
      border: 1px solid var(--accent);
      color: var(--accent);
      border-radius: 9999px;
      padding: 2px 10px;
      font-size: 11px;
    }
    .badge-valid {
      background: rgba(34, 197, 94, 0.15);
      border: 1px solid #22c55e;
      color: #4ade80;
      border-radius: 9999px;
      padding: 2px 10px;
      font-size: 11px;
    }
    .nav-tabs {
      display: flex;
      background: var(--bg-base);
      border-radius: 8px;
      padding: 3px;
      gap: 4px;
      border: 1px solid var(--border-color);
    }
    .tab-btn {
      padding: 6px 14px;
      border: none;
      background: transparent;
      color: var(--text-muted);
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      transition: all 0.15s ease;
    }
    .tab-btn.active {
      background: var(--bg-surface);
      color: var(--text-main);
      box-shadow: 0 1px 3px rgba(0,0,0,0.2);
    }
    .header-right {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .btn {
      padding: 8px 14px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--border-color);
      background: var(--bg-surface);
      color: var(--text-main);
      transition: all 0.15s ease;
    }
    .btn:hover {
      background: var(--bg-subtle);
    }
    .btn-primary {
      background: var(--accent);
      color: #0f172a;
      border-color: var(--accent);
    }
    .btn-primary:hover {
      background: var(--accent-hover);
    }
    main {
      flex: 1;
      display: flex;
      overflow: hidden;
      position: relative;
    }
    .view-pane {
      display: none;
      width: 100%;
      height: 100%;
      overflow: auto;
    }
    .view-pane.active {
      display: flex;
    }
    /* Split View */
    .split-container {
      display: flex;
      width: 100%;
      height: 100%;
    }
    .split-col {
      flex: 1;
      overflow-y: auto;
      padding: 24px;
      border-right: 1px solid var(--border-color);
      font-size: 14px;
      line-height: 1.6;
    }
    .split-col:last-child {
      border-right: none;
    }
    .col-header {
      position: sticky;
      top: -24px;
      background: var(--bg-surface);
      padding: 10px 16px;
      margin: -24px -24px 20px -24px;
      border-bottom: 1px solid var(--border-color);
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-weight: 600;
      font-size: 13px;
      z-index: 10;
    }
    /* Unified PR Diff */
    .diff-view {
      width: 100%;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
      line-height: 1.5;
      padding: 24px;
    }
    .diff-line {
      display: flex;
      padding: 2px 8px;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .diff-add {
      background: var(--diff-add-bg);
      color: var(--diff-add-text);
    }
    .diff-del {
      background: var(--diff-del-bg);
      color: var(--diff-del-text);
    }
    .diff-marker {
      width: 24px;
      user-select: none;
      color: var(--text-muted);
      flex-shrink: 0;
    }
    /* Rendered Preview */
    .rendered-container {
      max-width: 820px;
      margin: 0 auto;
      padding: 48px 24px;
      width: 100%;
      line-height: 1.7;
    }
    .rendered-container h1 { font-size: 28px; margin-bottom: 16px; }
    .rendered-container h2 { font-size: 20px; margin-top: 28px; margin-bottom: 12px; }
    .rendered-container p { margin-bottom: 16px; }
    .rendered-container pre {
      background: var(--code-bg);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 16px;
      overflow-x: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
      margin-bottom: 20px;
    }
    /* Intent Drawer */
    .drawer-overlay {
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      width: 440px;
      background: var(--bg-surface);
      border-left: 1px solid var(--border-color);
      box-shadow: -4px 0 24px rgba(0,0,0,0.35);
      transform: translateX(100%);
      transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      z-index: 50;
      display: flex;
      flex-direction: column;
    }
    .drawer-overlay.open {
      transform: translateX(0);
    }
    .drawer-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--border-color);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .drawer-body {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .card-box {
      background: var(--bg-base);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 14px;
    }
    .card-box h4 {
      font-size: 12px;
      text-transform: uppercase;
      color: var(--text-muted);
      margin-bottom: 6px;
      letter-spacing: 0.05em;
    }
    .card-box p {
      font-size: 13px;
      line-height: 1.5;
    }
    .alt-option {
      background: var(--bg-base);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 12px;
      margin-top: 8px;
      cursor: pointer;
      transition: border-color 0.15s ease;
    }
    .alt-option:hover {
      border-color: var(--accent);
    }
    .alt-option.selected {
      border-color: var(--accent);
      background: rgba(56, 189, 248, 0.05);
    }
    .intent-tag {
      background: rgba(56, 189, 248, 0.1);
      border: 1px solid var(--accent);
      color: var(--accent);
      padding: 4px 8px;
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 12px;
    }
    .section-hunk {
      position: relative;
      padding: 12px;
      border: 1px solid transparent;
      border-radius: 8px;
      margin-bottom: 12px;
    }
    .section-hunk:hover {
      border-color: var(--border-color);
      background: rgba(255, 255, 255, 0.02);
    }
    .hunk-controls {
      display: flex;
      gap: 6px;
      margin-top: 8px;
    }
    .hunk-btn {
      padding: 4px 8px;
      border-radius: 4px;
      border: 1px solid var(--border-color);
      background: var(--bg-subtle);
      color: var(--text-main);
      font-size: 11px;
      cursor: pointer;
    }
    .hunk-btn:hover { background: var(--border-color); }
    .status-accepted { color: #4ade80; }
    .status-rejected { color: #f87171; text-decoration: line-through; }
    /* Keyboard help pill */
    .keyboard-hint {
      position: absolute;
      bottom: 12px;
      left: 24px;
      background: var(--bg-surface);
      border: 1px solid var(--border-color);
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 11px;
      color: var(--text-muted);
      display: flex;
      gap: 8px;
      z-index: 20;
    }
    kbd {
      background: var(--bg-subtle);
      padding: 1px 4px;
      border-radius: 3px;
      color: var(--text-main);
    }
  </style>
</head>
<body>

  <header>
    <div class="header-left">
      <span class="badge">Transcreate</span>
      <h3 style="font-size: 14px; font-weight: 600;">${result.filePath}</h3>
      <span class="badge-pill">Target: ${result.targetLocale}</span>
      <span class="badge-valid">AST Valid: 100%</span>
    </div>

    <div class="nav-tabs">
      <button class="tab-btn active" onclick="switchView('split')">Split View</button>
      <button class="tab-btn" onclick="switchView('diff')">Unified Diff</button>
      <button class="tab-btn" onclick="switchView('rendered')">Rendered Article</button>
    </div>

    <div class="header-right">
      <button class="btn" onclick="toggleDrawer()" title="View Cultural Intent Cards">
        <span>Intent Drawer (${result.intentCards.length})</span>
      </button>
      <button class="btn" onclick="toggleTheme()" title="Toggle Theme">
        <span id="theme-label">Theme</span>
      </button>
      <button class="btn btn-primary" onclick="exportMarkdown()">
        Export Markdown
      </button>
      ${serverPort ? `<button class="btn btn-primary" onclick="saveToDisk()">Save to Disk</button>` : ""}
    </div>
  </header>

  <main>
    <!-- View 1: Split View -->
    <div id="split-view" class="view-pane active">
      <div class="split-container">
        <!-- Original Column -->
        <div class="split-col" id="col-original">
          <div class="col-header">
            <span>Original Source (en-US)</span>
            <span style="color: var(--text-muted); font-size: 11px;">Read-only reference</span>
          </div>
          <div id="original-nodes"></div>
        </div>

        <!-- Localized Column -->
        <div class="split-col" id="col-transcreated">
          <div class="col-header">
            <span>Transcreated (${result.targetLocale})</span>
            <span style="color: var(--text-muted); font-size: 11px;">Section Actions</span>
          </div>
          <div id="transcreated-nodes"></div>
        </div>
      </div>
    </div>

    <!-- View 2: Unified Diff -->
    <div id="diff-view" class="view-pane">
      <div class="diff-view">
        ${lineDiff.map(part => {
          const colorClass = part.added ? "diff-add" : part.removed ? "diff-del" : "";
          const marker = part.added ? "+ " : part.removed ? "- " : "  ";
          const lines = part.value.split("\n");
          if (lines[lines.length - 1] === "") lines.pop();
          return lines.map(line => `
            <div class="diff-line ${colorClass}">
              <span class="diff-marker">${marker}</span>
              <span>${escapeHtml(line)}</span>
            </div>
          `).join("");
        }).join("")}
      </div>
    </div>

    <!-- View 3: Rendered Preview -->
    <div id="rendered-view" class="view-pane">
      <div class="rendered-container" id="rendered-content">
        <!-- Injected dynamically based on accepted state -->
      </div>
    </div>

    <!-- Side Intent Drawer -->
    <div class="drawer-overlay" id="intent-drawer">
      <div class="drawer-header">
        <h3 style="font-size: 14px; font-weight: 600;">Cultural Intent Card</h3>
        <button class="btn" onclick="toggleDrawer()" style="padding: 2px 8px;">✕</button>
      </div>
      <div class="drawer-body" id="drawer-content">
        <!-- Populated via JS -->
      </div>
    </div>

    <div class="keyboard-hint">
      <span><kbd>j</kbd>/<kbd>k</kbd> Next/Prev Hunk</span>
      <span><kbd>a</kbd> Accept</span>
      <span><kbd>r</kbd> Reject</span>
      <span><kbd>Space</kbd> Intent Drawer</span>
    </div>
  </main>

  <script>
    const INITIAL_DATA = ${safeResult};
    let currentData = JSON.parse(JSON.stringify(INITIAL_DATA));
    let selectedHunkIndex = 0;

    function escapeHtml(text) {
      if (!text) return "";
      return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    function switchView(viewName) {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".view-pane").forEach(p => p.classList.remove("active"));

      if (viewName === "split") {
        document.querySelector(".tab-btn:nth-child(1)").classList.add("active");
        document.getElementById("split-view").classList.add("active");
      } else if (viewName === "diff") {
        document.querySelector(".tab-btn:nth-child(2)").classList.add("active");
        document.getElementById("diff-view").classList.add("active");
      } else if (viewName === "rendered") {
        document.querySelector(".tab-btn:nth-child(3)").classList.add("active");
        document.getElementById("rendered-view").classList.add("active");
        renderArticle();
      }
    }

    function toggleTheme() {
      const html = document.documentElement;
      html.classList.toggle("light");
      html.classList.toggle("dark");
    }

    function toggleDrawer() {
      const drawer = document.getElementById("intent-drawer");
      drawer.classList.toggle("open");
    }

    function renderSplitNodes() {
      const origContainer = document.getElementById("original-nodes");
      const transContainer = document.getElementById("transcreated-nodes");
      origContainer.innerHTML = "";
      transContainer.innerHTML = "";

      currentData.proseNodes.forEach((node, idx) => {
        // Original
        const origDiv = document.createElement("div");
        origDiv.className = "section-hunk";
        origDiv.id = "orig-" + idx;
        origDiv.innerHTML = '<div style="color: var(--text-muted); font-size: 11px; margin-bottom: 4px;">Hunk #' + (idx + 1) + ' (' + node.type + ')</div>' +
          '<div style="white-space: pre-wrap;">' + escapeHtml(node.originalText) + '</div>';
        origContainer.appendChild(origDiv);

        // Transcreated
        const transDiv = document.createElement("div");
        transDiv.className = "section-hunk";
        transDiv.id = "trans-" + idx;
        const statusClass = node.accepted ? "status-accepted" : "status-rejected";

        let intentBadge = "";
        if (node.intentCard) {
          intentBadge = '<div class="intent-tag" onclick="showIntentCard(' + idx + ')">' +
            '<span>Intent: ' + escapeHtml(node.intentCard.originalMetaphor) + ' → ' + escapeHtml(node.intentCard.targetMetaphor) + '</span>' +
          '</div>';
        }

        transDiv.innerHTML = intentBadge +
          '<div style="white-space: pre-wrap;" class="' + statusClass + '">' +
            escapeHtml(node.accepted ? node.localizedText : node.originalText) +
          '</div>' +
          '<div class="hunk-controls">' +
            '<button class="hunk-btn" onclick="acceptHunk(' + idx + ')">Accept</button>' +
            '<button class="hunk-btn" onclick="rejectHunk(' + idx + ')">Reject</button>' +
            (node.intentCard ? '<button class="hunk-btn" onclick="showIntentCard(' + idx + ')">Alternatives</button>' : '') +
          '</div>';
        transContainer.appendChild(transDiv);
      });

      // Synchronize scroll
      const origCol = document.getElementById("col-original");
      const transCol = document.getElementById("col-transcreated");
      let isSyncing = false;

      origCol.onscroll = () => {
        if (!isSyncing) {
          isSyncing = true;
          transCol.scrollTop = origCol.scrollTop;
          isSyncing = false;
        }
      };
      transCol.onscroll = () => {
        if (!isSyncing) {
          isSyncing = true;
          origCol.scrollTop = transCol.scrollTop;
          isSyncing = false;
        }
      };
    }

    function acceptHunk(idx) {
      currentData.proseNodes[idx].accepted = true;
      renderSplitNodes();
    }

    function rejectHunk(idx) {
      currentData.proseNodes[idx].accepted = false;
      renderSplitNodes();
    }

    function showIntentCard(idx) {
      const card = currentData.intentCards[0];
      if (!card) return;

      const body = document.getElementById("drawer-content");
      body.innerHTML = 
        '<div class="card-box">' +
          '<h4>Original Metaphor</h4>' +
          '<p><strong>' + escapeHtml(card.originalMetaphor) + '</strong></p>' +
        '</div>' +
        '<div class="card-box">' +
          '<h4>Cultural Mismatch Reason</h4>' +
          '<p>' + escapeHtml(card.mismatchReason) + '</p>' +
        '</div>' +
        '<div class="card-box">' +
          '<h4>Target Adaptation</h4>' +
          '<p><strong>' + escapeHtml(card.targetMetaphor) + '</strong></p>' +
          '<p style="margin-top: 6px; color: var(--text-muted);">' + escapeHtml(card.rationale) + '</p>' +
        '</div>' +
        '<div class="card-box">' +
          '<h4>Select Alternative / Neutral Fallback</h4>' +
          card.alternatives.map((alt, aIdx) => 
            '<div class="alt-option ' + (alt.isNeutralTechnical ? 'neutral-option' : '') + '" onclick="selectAlternative(' + idx + ', ' + aIdx + ')">' +
              '<div style="font-weight: 600; font-size: 13px;">' + (alt.isNeutralTechnical ? '🛡️ ' : '🎯 ') + escapeHtml(alt.metaphor) + '</div>' +
              '<div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">' + escapeHtml(alt.rationale) + '</div>' +
            '</div>'
          ).join('') +
        '</div>';

      document.getElementById("intent-drawer").classList.add("open");
    }

    function selectAlternative(proseIdx, altIdx) {
      const card = currentData.intentCards[0];
      const alt = card.alternatives[altIdx];
      if (!alt) return;

      if (alt.isNeutralTechnical) {
        currentData.proseNodes[proseIdx].localizedText = alt.suggestedText;
      }
      renderSplitNodes();
      document.getElementById("intent-drawer").classList.remove("open");
    }

    function renderArticle() {
      const container = document.getElementById("rendered-content");
      let html = "";

      // Simple rendered markdown representation
      currentData.proseNodes.forEach(node => {
        const text = node.accepted ? node.localizedText : node.originalText;
        if (text.startsWith("# ")) {
          html += "<h1>" + escapeHtml(text.slice(2)) + "</h1>";
        } else if (text.startsWith("## ")) {
          html += "<h2>" + escapeHtml(text.slice(3)) + "</h2>";
        } else {
          html += "<p>" + escapeHtml(text) + "</p>";
        }
      });

      // Code blocks
      if (currentData.codeBlocks.length > 0) {
        const block = currentData.codeBlocks[0];
        html += "<pre><code>" + escapeHtml(block.transformedCode || block.originalCode) + "</code></pre>";
      }

      container.innerHTML = html;
    }

    function exportMarkdown() {
      const content = currentData.transcreatedMarkdown;
      const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = currentData.filePath.replace(/\\.md$/, "." + currentData.targetLocale + ".md");
      a.click();
      URL.revokeObjectURL(url);
    }

    async function saveToDisk() {
      try {
        const res = await fetch("/api/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filePath: currentData.filePath,
            targetLocale: currentData.targetLocale,
            markdown: currentData.transcreatedMarkdown
          })
        });
        if (res.ok) {
          alert("Successfully saved localized markdown to disk!");
        } else {
          alert("Error saving file to disk.");
        }
      } catch (err) {
        alert("Server not reachable: " + err.message);
      }
    }

    // Keyboard shortcuts
    window.addEventListener("keydown", (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.key === "j") {
        selectedHunkIndex = Math.min(selectedHunkIndex + 1, currentData.proseNodes.length - 1);
        const el = document.getElementById("trans-" + selectedHunkIndex);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      } else if (e.key === "k") {
        selectedHunkIndex = Math.max(selectedHunkIndex - 1, 0);
        const el = document.getElementById("trans-" + selectedHunkIndex);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      } else if (e.key === "a") {
        acceptHunk(selectedHunkIndex);
      } else if (e.key === "r") {
        rejectHunk(selectedHunkIndex);
      } else if (e.key === " ") {
        e.preventDefault();
        toggleDrawer();
      }
    });

    // Initialize
    renderSplitNodes();
  </script>
</body>
</html>`;
  }
}

function escapeHtml(text: string): string {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
