# [PROPOSAL] Strengthening the Semantic Contract: Agent-to-TUI Alignment

## Status: DRAFT (Documentation-Only PR)
**Target Audience:** Agent Engineers, Prompt Designers, TUI Developers

---

## 1. Executive Summary
The Market Terminal architecture relies on a **"Semantic Bridge"** where the Research Agent acts as a producer of structured data and the TUI acts as a consumer. Currently, the system uses a "Contract-Based" approach via the `market_canvas` tool. 

However, analysis of recent research runs has identified four critical "Contract Violations" where the agent's reasoning or instruction-following fails to meet the requirements of the TUI. This document proposes a formalized set of alignment strategies to be implemented through enhanced documentation and prompt engineering.

---

## 2. Identified Failure Modes (The "Contract Violations")

### A. The Source-Linkage Gap (Broken Traceability)
*   **Symptom:** Agent provides a high-quality `read` block (the "answer") but fails to include the `sourceIds` array in the JSON payload.
*   **TUI Impact:** The user sees the conclusion but cannot verify it. The "traceability" feature of the terminal is neutralized.
*   **Root Cause:** LLMs often treat `sourceIds` as secondary metadata rather than a primary structural requirement for the `read` block.

### B. Intent Drift (Speculative Pollution)
*   **Symptom:** In `BRIEF` mode (factual updates), the agent includes "Scenarios" or "Interpretations" (e.g., *"If X happens, then Y might follow..."*).
*   **TUI Impact:** High-density "Signals" views become cluttered with speculative noise, undermining the "Brief" intent.
*   **Root Cause:** The inherent "creative" bias of LLMs conflicts with the "factual-only" constraint of the `BRIEF` mode.

### C. Technical Indicator Hallucination (Data Desynchronization)
*   **Symptom:** The agent provides specific numeric values for RSI, MACD, or SMA in its prose that do not match the deterministic `ta-*` blocks provided by the `market_technicals` tool.
*   **TUI Impact:** A "split-brain" UI where the text and the charts disagree, destroying user trust.
*   **Root Cause:** The agent attempts to "re-summarize" numeric data instead of treating the `ta-*` blocks as immutable, single-source-of-truth entities.

### D. Namespace Collision (Paired-Run Fragmentation)
*   **Symptom:** In `PAIRED_BRIEF_WHY` mode, the agent fails to use the required ID prefixes (`brief-*`, `why-*`, `shared-*`).
*   **TUI Impact:** The terminal cannot correctly partition the single `market_canvas` call into the split-view layout.
*   **Root Cause:** Complexity overhead in managing multiple namespaces within a single multi-intent reasoning task.

---

## 3. Proposed Mitigation Strategies

### Strategy I: The "Anti-Pattern" Registry (Negative Constraints)
Instead of only telling the agent what *to do*, we must explicitly list what *not to do*. We propose adding a "Prohibited Behaviors" section to the `Hard Output Contract` in the system prompt.

**Example Prompt Injection:**
> `PROHIBITED BEHAVIORS:`
> `- DO NOT include 'scenarios' or 'interpretations' in BRIEF mode.`
> `- DO NOT quote RSI/MACD/SMA values; refer only to the trends shown in the ta-* blocks.`
> `- DO NOT omit sourceIds from 'read' or 'evidence' blocks.`

### Strategy II: Few-Shot "Golden Payload" Examples
We should provide the agent with "Golden Examples" of perfect JSON payloads for each mode. 

**Implementation:** The prompt should include a minimized, valid `market_canvas` JSON object for a `BRIEF` run and a `PAIRED` run to serve as a structural template.

### Strategy III: The "Mandatory Checklist" Protocol
Before the final `market_canvas` call, the agent should be instructed to perform a self-correction step.

**Proposed Prompt Instruction:**
> `FINAL VALIDATION CHECKLIST (Before publishing):`
> `1. Did I use the correct ID prefixes for this mode (e.g., brief-* vs why-*)?`
> `2. Does every claim in my 'read' block have a corresponding sourceId?`
> `3. In BRIEF mode, have I stripped all speculative scenarios?`
> `4. Have I avoided re-stating exact TA values in my prose?`

### Strategy IV: Namespace Enforcement for Paired Runs
For `PAIRED` mode, the prompt should define a "Strict Partitioning Rule," treating the two questions as two separate logical tasks that must be merged into one physical payload via a specific ID-based naming convention.

---

## 4. Next Steps
1.  **Update `market-terminal.ts`:** Integrate the "Anti-Pattern Registry" into the `buildResearchPromptCompact` and `buildResearchPromptLegacy` functions.
2.  **Prompt A/B Testing:** Measure the rate of `EVIDENCE_BLOCKED` vs. `Contract Violation` errors to ensure the new constraints do not increase agent refusal rates.
3.  **Schema Validation:** (Long-term) Implement server-side JSON schema validation for `market_canvas` to catch and reject non-conforming payloads before they reach the TUI.
