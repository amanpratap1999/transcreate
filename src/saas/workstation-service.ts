import type {
  TranscreationJob,
  Document,
  DocumentVersion,
  IntentCardRecord,
  HunkDecision,
  TenantContext
} from "./models.js";
import { WorkstationBundler } from "../viewer/bundler.js";
import type { TranscreateResult, ProseNodeSlice, CodeBlockSlice } from "../types.js";

export interface WorkstationViewData {
  job: TranscreationJob;
  document: Document;
  sourceVersion: DocumentVersion;
  localizedVersion?: DocumentVersion;
  intentCards: IntentCardRecord[];
  decisions: HunkDecision[];
  tenantContext: TenantContext;
}

export class SaasWorkstationService {
  private bundler = new WorkstationBundler();

  /**
   * Generates the complete SaaS web review workstation for a transcreation job.
   * Conforms to the Transcreate review UI with live cloud sync and tenant isolation.
   */
  public renderHtml(data: WorkstationViewData, apiUrl = ""): string {
    const originalMarkdown = data.sourceVersion.content;
    const transcreatedMarkdown = data.localizedVersion?.content || originalMarkdown;

    // Synthesize ProseNodeSlice for viewer
    const proseNodes: ProseNodeSlice[] = data.intentCards.map((card, i) => ({
      index: card.sectionIndex,
      type: "paragraph",
      originalText: card.originalMetaphor,
      maskedText: card.originalMetaphor,
      localizedText: card.targetMetaphor,
      startOffset: 0,
      endOffset: 0,
      accepted: true,
      inlineCodeTokens: [],
      urlMap: {},
      intentCard: {
        id: card.id,
        sectionIndex: card.sectionIndex,
        codeBlockIndex: card.codeBlockIndex,
        associatedSymbols: [],
        originalMetaphor: card.originalMetaphor,
        targetMetaphor: card.targetMetaphor,
        mismatchReason: card.mismatchReason,
        rationale: card.rationale,
        culturalContext: card.culturalContext,
        confidence: card.confidence,
        alternatives: card.alternatives
      }
    }));

    const dummyResult: TranscreateResult = {
      filePath: data.document.filePath,
      targetLocale: data.job.targetLocale,
      originalMarkdown,
      transcreatedMarkdown,
      intentCards: proseNodes.map(p => p.intentCard!).filter(Boolean),
      symbolTable: {},
      codeBlocks: [],
      proseNodes,
      htmlViewerPath: "",
      stats: {
        metaphorsTranscreated: data.intentCards.length,
        codeIdentifiersAdapted: 0,
        codeBlocksValidated: 0,
        proseNodesTranscreated: proseNodes.length
      }
    };

    // Render using proven WorkstationBundler
    let html = this.bundler.generateHtml(dummyResult);

    // Inject SaaS Cloud Context and Live API Synchronization Script
    const saasScript = `
    <script>
      (function() {
        const tenantContext = ${JSON.stringify(data.tenantContext)};
        const jobId = ${JSON.stringify(data.job.id)};
        const apiUrl = ${JSON.stringify(apiUrl)};

        console.log("Transcreate SaaS Cloud Session Initialized for Org:", tenantContext.orgId, "Job:", jobId);

        // Add SaaS Header Indicator
        const header = document.querySelector(".header-title");
        if (header) {
          const saasBadge = document.createElement("span");
          saasBadge.className = "badge";
          saasBadge.style.background = "rgba(168, 85, 247, 0.15)";
          saasBadge.style.color = "#c084fc";
          saasBadge.style.borderColor = "rgba(168, 85, 247, 0.3)";
          saasBadge.textContent = "SaaS Tenant: " + tenantContext.orgId;
          header.appendChild(saasBadge);
        }

        // Intercept save to sync with SaaS REST API
        window.saveToSaaSCloud = async function() {
          const activeMd = typeof getActiveMarkdown === "function" ? getActiveMarkdown() : currentData.transcreatedMarkdown;
          try {
            const res = await fetch((apiUrl || "") + "/api/v1/jobs/" + jobId + "/decisions", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-org-id": tenantContext.orgId,
                "x-user-id": tenantContext.userId,
                "x-role": tenantContext.role || "editor"
              },
              body: JSON.stringify({
                hunkIndex: 0,
                hunkType: "prose",
                decision: "accepted",
                originalText: currentData.originalMarkdown,
                suggestedText: activeMd,
                finalText: activeMd
              })
            });

            if (res.ok) {
              alert("Successfully synced decisions to Transcreate Cloud!");
            } else {
              const err = await res.json();
              alert("Cloud sync error: " + (err.error || res.statusText));
            }
          } catch (e) {
            alert("Network error communicating with SaaS API: " + e.message);
          }
        };

        // Attach to Save button
        const saveBtn = document.querySelector(".btn-primary");
        if (saveBtn) {
          saveBtn.textContent = "Cloud Sync & Save";
          saveBtn.onclick = window.saveToSaaSCloud;
        }
      })();
    </script>
    `;

    return html.replace("</body>", saasScript + "</body>");
  }
}
