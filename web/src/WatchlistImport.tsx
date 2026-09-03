import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { normalizeWatchlistSymbol } from "../../shared/watchlist-symbols";
import type { WatchlistImportResult } from "./socket";

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

type ImportMode = "merge" | "replace";

type ScreenshotCandidate = {
  symbol: string;
  rawSymbol: string;
  name?: string;
  assetType: "crypto" | "stock" | "etf" | "fund" | "index" | "other";
  confidence?: number;
};

type ImportResponse = {
  candidates?: ScreenshotCandidate[];
  rejected?: number;
  error?: string;
};

type ReviewCandidate = ScreenshotCandidate & {
  id: string;
};

function apiPath(path: string): string {
  const base = import.meta.env.BASE_URL === "/"
    ? ""
    : import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${base}${path}`;
}

function readableAssetType(assetType: ScreenshotCandidate["assetType"]): string {
  return assetType === "other" ? "instrument" : assetType;
}

export function WatchlistImport({
  open,
  onOpenChange,
  onApply,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onApply(mode: ImportMode, symbols: string[]): Promise<WatchlistImportResult>;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const progressStatusRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const uploadAbortRef = useRef<AbortController>();
  const uploadRequestIdRef = useRef(0);
  const loadingRef = useRef(false);
  const applyRequestIdRef = useRef(0);
  const applyingRef = useRef(false);
  const previewUrlRef = useRef<string>();
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string>();
  const [rejected, setRejected] = useState(0);
  const [candidates, setCandidates] = useState<ReviewCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dragActive, setDragActive] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [filter, setFilter] = useState("");
  const step: 1 | 2 = candidates.length > 0 ? 2 : 1;
  const visibleCandidates = candidates.filter((candidate) => {
    const query = filter.trim().toLowerCase();
    return !query
      || candidate.symbol.toLowerCase().includes(query)
      || candidate.rawSymbol.toLowerCase().includes(query)
      || (candidate.name || "").toLowerCase().includes(query);
  });

  const releasePreview = () => {
    if (!previewUrlRef.current) return;
    URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = undefined;
    setPreviewUrl(undefined);
  };

  const cancelUpload = () => {
    uploadRequestIdRef.current++;
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = undefined;
    loadingRef.current = false;
  };

  const cancelApply = () => {
    applyRequestIdRef.current++;
    applyingRef.current = false;
  };

  useEffect(() => {
    if (open) return;
    cancelUpload();
    cancelApply();
    setLoading(false);
    setApplying(false);
    setError(undefined);
    setRejected(0);
    setCandidates([]);
    setSelected(new Set());
    setDragActive(false);
    setFilter("");
    releasePreview();
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [open]);

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusFrame = requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      cancelAnimationFrame(focusFrame);
      previouslyFocusedRef.current?.focus({ preventScroll: true });
      previouslyFocusedRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!applying) return;
    const focusFrame = requestAnimationFrame(() => progressStatusRef.current?.focus());
    return () => cancelAnimationFrame(focusFrame);
  }, [applying]);

  useEffect(() => () => {
    cancelUpload();
    cancelApply();
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  const loadScreenshot = async (file: File) => {
    if (loadingRef.current || applyingRef.current) return;
    if (file.size === 0 || file.size > MAX_IMAGE_BYTES) {
      setError("Choose a PNG, JPEG, or WebP screenshot smaller than 6 MiB.");
      return;
    }
    releasePreview();
    const nextPreviewUrl = URL.createObjectURL(file);
    previewUrlRef.current = nextPreviewUrl;
    setPreviewUrl(nextPreviewUrl);
    setDragActive(false);
    const requestId = ++uploadRequestIdRef.current;
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    loadingRef.current = true;
    setLoading(true);
    setError(undefined);
    setCandidates([]);
    setSelected(new Set());
    try {
      const response = await fetch(apiPath("/api/watchlist/import"), {
        method: "POST",
        headers: { "content-type": file.type || "application/octet-stream" },
        body: file,
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => undefined) as ImportResponse | undefined;
      if (!response.ok) {
        throw new Error(payload?.error || "Screenshot import could not be completed.");
      }
      if (controller.signal.aborted || requestId !== uploadRequestIdRef.current) return;
      const next = (payload?.candidates ?? [])
        .filter((candidate): candidate is ScreenshotCandidate =>
          Boolean(candidate)
          && typeof candidate.symbol === "string"
          && typeof candidate.rawSymbol === "string",
        )
        .map((candidate, index) => ({ ...candidate, id: `${candidate.symbol}-${index}` }));
      setCandidates(next);
      setSelected(new Set(next.map((candidate) => candidate.id)));
      setRejected(typeof payload?.rejected === "number" ? payload.rejected : 0);
      if (next.length === 0) {
        setError("No readable tradeable symbols were found. Try a tighter crop or enter the symbols through Search.");
      }
    } catch (reason) {
      if (controller.signal.aborted || requestId !== uploadRequestIdRef.current) return;
      setError(reason instanceof Error ? reason.message : "Screenshot import could not be completed.");
    } finally {
      if (requestId !== uploadRequestIdRef.current) return;
      uploadAbortRef.current = undefined;
      loadingRef.current = false;
      setLoading(false);
    }
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) void loadScreenshot(file);
  };

  const selectedSymbols = () => {
    const symbols: string[] = [];
    const invalid: string[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (!selected.has(candidate.id)) continue;
      const symbol = normalizeWatchlistSymbol(candidate.symbol);
      if (!symbol) {
        invalid.push(candidate.symbol.trim() || candidate.rawSymbol);
        continue;
      }
      if (!seen.has(symbol)) {
        seen.add(symbol);
        symbols.push(symbol);
      }
    }
    return { symbols, invalid };
  };

  const handleModalKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const modal = modalRef.current;
    if (!modal) return;
    const focusable = [
      ...modal.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ),
    ];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      // During APPLYING every action is disabled. Keep Tab inside the dialog
      // rather than allowing focus to fall through to the app behind it.
      event.preventDefault();
      progressStatusRef.current?.focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const apply = async (mode: ImportMode) => {
    if (loadingRef.current || applyingRef.current) return;
    const { symbols, invalid } = selectedSymbols();
    if (invalid.length > 0) {
      const examples = invalid.slice(0, 3).join(", ");
      setError(`Fix invalid Yahoo Finance symbol${invalid.length === 1 ? "" : "s"}: ${examples}${invalid.length > 3 ? "..." : ""}`);
      return;
    }
    if (symbols.length === 0) {
      setError("Select at least one valid Yahoo Finance symbol.");
      return;
    }
    if (
      mode === "replace"
      && !window.confirm("Replace the current session watchlist with the selected symbols?")
    ) return;
    const requestId = ++applyRequestIdRef.current;
    applyingRef.current = true;
    setApplying(true);
    setError(undefined);
    try {
      const result = await onApply(mode, symbols);
      if (requestId !== applyRequestIdRef.current) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onOpenChange(false);
    } catch (reason) {
      if (requestId !== applyRequestIdRef.current) return;
      setError(reason instanceof Error ? reason.message : "The reviewed watchlist could not be applied.");
    } finally {
      if (requestId !== applyRequestIdRef.current) return;
      applyingRef.current = false;
      setApplying(false);
    }
  };

  const selection = selectedSymbols();
  const canApply = !loading && !applying && selection.symbols.length > 0 && selection.invalid.length === 0;

  return (
    <>
      {open && (
        <div className="watchlist-import-backdrop" role="presentation">
          <section
            ref={modalRef}
            className="watchlist-import-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="watchlist-import-title"
            aria-describedby="watchlist-import-intro"
            aria-busy={loading || applying}
            onKeyDown={handleModalKeyDown}
          >
            <header className="watchlist-import-header">
              <div>
                <div className="watchlist-import-kicker">WATCHLIST INGEST</div>
                <h2 id="watchlist-import-title">Scan a market screenshot</h2>
              </div>
              <button
                type="button"
                className="watchlist-import-close"
                ref={closeButtonRef}
                onClick={() => onOpenChange(false)}
                aria-label="Close screenshot import"
                disabled={applying}
              >
                ×
              </button>
            </header>

            <p id="watchlist-import-intro" className="watchlist-import-intro">
              The scanner extracts visible instruments and maps crypto tickers to Yahoo pairs, such as BTC to BTC-USD. It never imports balances, prices, or transactions.
            </p>

            <div className="watchlist-import-steps" aria-hidden="true">
              <span className={`watchlist-import-step${step >= 1 ? " is-active" : ""}`}>1 · Choose</span>
              <span className="watchlist-import-step-sep">→</span>
              <span className={`watchlist-import-step${step >= 2 ? " is-active" : ""}`}>2 · Review & apply</span>
            </div>
            <div ref={progressStatusRef} className="watchlist-import-live-status" role="status" aria-live="polite" tabIndex={-1}>
              {loading ? "Scanning screenshot…" : applying ? "Applying selected symbols…" : candidates.length > 0 ? `${selection.symbols.length} valid symbol${selection.symbols.length === 1 ? "" : "s"} ready` : ""}
            </div>

            <input
              ref={fileInputRef}
              className="watchlist-import-file-input"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              tabIndex={-1}
              onChange={handleFileChange}
              disabled={loading || applying}
            />
            <div
              className={`watchlist-import-dropzone${dragActive ? " is-dragging" : ""}${loading ? " is-loading" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                if (!loading && !applying) setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragActive(false);
                const file = event.dataTransfer.files?.[0];
                if (file) void loadScreenshot(file);
              }}
            >
              <button
                type="button"
                className="watchlist-import-file-button"
                onClick={() => fileInputRef.current?.click()}
                disabled={loading || applying}
              >
                {loading ? "READING SCREENSHOT…" : applying ? "APPLYING WATCHLIST…" : previewUrl ? "CHOOSE ANOTHER SCREENSHOT" : "CHOOSE OR DROP SCREENSHOT"}
              </button>
              {previewUrl ? (
                <div className="watchlist-import-preview">
                  <img src={previewUrl} alt="Screenshot preview" />
                  <span>{loading ? "Scanning symbols…" : `${candidates.length} symbol${candidates.length === 1 ? "" : "s"} found`}</span>
                </div>
              ) : (
                <p className="watchlist-import-note">
                  PNG, JPEG, or WebP up to 6 MiB · drag & drop or tap to browse. Processed in memory, sent only to your vision provider.
                </p>
              )}
              {loading && <div className="watchlist-import-shimmer" aria-hidden="true" />}
            </div>

            {error && <div className="watchlist-import-error" role="alert">{error}</div>}

            {candidates.length > 0 && (
              <div className="watchlist-import-review">
                <div className="watchlist-import-review-heading">
                  <strong>REVIEW {candidates.length} SYMBOL{candidates.length === 1 ? "" : "S"}</strong>
                  <span>{selected.size}/{candidates.length} selected · Edit Yahoo symbols before applying.</span>
                </div>
                <div className="watchlist-import-toolbar">
                  <button
                    type="button"
                    className="watchlist-import-tool"
                    disabled={applying}
                    onClick={() => setSelected((current) => new Set([...current, ...visibleCandidates.map((candidate) => candidate.id)]))}
                  >
                    {filter.trim() ? "Select visible" : "Select all"}
                  </button>
                  <button
                    type="button"
                    className="watchlist-import-tool"
                    disabled={applying}
                    onClick={() => setSelected((current) => {
                      const next = new Set(current);
                      for (const candidate of visibleCandidates) next.delete(candidate.id);
                      return next;
                    })}
                  >
                    {filter.trim() ? "Clear visible" : "Clear"}
                  </button>
                  <input
                    className="watchlist-import-filter"
                    placeholder="Filter symbols…"
                    aria-label="Filter symbols"
                    value={filter}
                    disabled={applying}
                    onChange={(event) => setFilter(event.target.value)}
                  />
                </div>
                <div className="watchlist-import-candidates">
                  {visibleCandidates.length === 0 ? (
                    <div className="watchlist-import-empty">No symbols match “{filter}”.</div>
                  ) : visibleCandidates.map((candidate) => {
                    const symbolInvalid = !normalizeWatchlistSymbol(candidate.symbol);
                    const confidence = candidate.confidence === undefined ? null : Math.round(candidate.confidence * 100);
                    const assetIcon = candidate.assetType === "crypto" ? "₿" : candidate.assetType === "index" ? "◧" : candidate.assetType === "etf" || candidate.assetType === "fund" ? "▦" : "●";
                    return (
                      <div className={`watchlist-import-candidate${selected.has(candidate.id) ? " is-selected" : ""}${symbolInvalid ? " is-invalid" : ""}`} key={candidate.id}>
                        <input
                          type="checkbox"
                          aria-label={`Include ${candidate.name || candidate.rawSymbol}`}
                          checked={selected.has(candidate.id)}
                          disabled={applying}
                          onChange={() => {
                            setError(undefined);
                            setSelected((current) => {
                              const next = new Set(current);
                              if (next.has(candidate.id)) next.delete(candidate.id);
                              else next.add(candidate.id);
                              return next;
                            });
                          }}
                        />
                        <span className="watchlist-import-candidate-meta">
                          <span className="watchlist-import-candidate-name"><span aria-hidden="true" className="watchlist-import-asset">{assetIcon}</span> {candidate.name || candidate.rawSymbol}</span>
                          <span className="watchlist-import-candidate-sub">
                            {readableAssetType(candidate.assetType)}
                            {confidence !== null && (
                              <span className={`watchlist-import-confidence${confidence >= 80 ? " is-high" : confidence >= 50 ? " is-mid" : " is-low"}`}> · {confidence}%</span>
                            )}
                          </span>
                        </span>
                        <input
                          className="watchlist-import-symbol"
                          aria-label={`Yahoo symbol for ${candidate.name || candidate.rawSymbol}`}
                          aria-invalid={symbolInvalid || undefined}
                          value={candidate.symbol}
                          disabled={applying}
                          onChange={(event) => {
                            const value = event.target.value;
                            setError(undefined);
                            setCandidates((current) => current.map((item) =>
                              item.id === candidate.id ? { ...item, symbol: value } : item,
                            ));
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
                {rejected > 0 && (
                  <p className="watchlist-import-rejected">{rejected} unreadable or duplicate row{rejected === 1 ? " was" : "s were"} left out.</p>
                )}
                <div className="watchlist-import-actions">
                  <button type="button" className="watchlist-import-add" disabled={!canApply} onClick={() => void apply("merge")}>
                    {applying ? "APPLYING..." : "ADD SELECTED"}
                  </button>
                  <button type="button" className="watchlist-import-replace" disabled={!canApply} onClick={() => void apply("replace")}>
                    {applying ? "APPLYING..." : "REPLACE WATCHLIST"}
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
