import { useEffect, useRef, useState } from "react";
import { TERMINAL_INPUTS, type ResearchActivityStatus, type TerminalFrameState } from "./mobile-controls";
import { contextHudChips, contextHudShowBack, type ContextHudChip } from "./context-hud-chips";

interface ContextHudProps {
  state?: TerminalFrameState;
  researchStatus?: ResearchActivityStatus;
  disabled: boolean;
  onInput: (data: string) => void;
}

const HUD_IDLE_MS = 2500;

/**
 * Touch-only contextual controls, overlaid on the terminal. Two surfaces:
 *
 *  - A persistent ‹ Back button (top-left), shown only in ticker detail where
 *    there is somewhere to return to. It is essential navigation — without it
 *    a ticker is a dead-end on touch — and it replaces a back gesture, which
 *    would collide with the browser/OS edge-back.
 *  - A fading action cluster (top-right) that appears on contact and holds the
 *    actions for the active partition: ticker → Why/Watch/Refresh, market map
 *    → Refresh, plus Cancel whenever research is running. It fades out after a
 *    short idle or once an action fires.
 *
 * Desktop is unaffected (keyboard shortcuts remain primary); both surfaces are
 * revealed only by a coarse-pointer media query in styles.css.
 */
export function ContextHud({ state, researchStatus, disabled, onInput }: ContextHudProps) {
  const [visible, setVisible] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const armHide = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setVisible(false), HUD_IDLE_MS);
  };

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      setVisible(true);
      armHide();
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  const showBack = contextHudShowBack(state);
  const chips = contextHudChips(state, researchStatus);
  // The cache prompt is modal and must stay visible until resolved — it
  // overrides the idle fade so Use/Refresh/Cancel stay on screen.
  const cacheDecision = Boolean(state?.cacheDecision);
  const clusterVisible = visible || cacheDecision;

  const fire = (chip: ContextHudChip) => {
    if (disabled) return;
    onInput(chip.input);
    setVisible(false);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
  };

  const back = () => {
    if (disabled) return;
    onInput(TERMINAL_INPUTS.escape);
  };

  if (!showBack && chips.length === 0) return null;

  return (
    <div className="context-hud-anchor">
      {showBack && (
        <button
          type="button"
          className="context-back"
          aria-label="Back to market map"
          disabled={disabled}
          onClick={back}
        >
          ‹
        </button>
      )}

      {chips.length > 0 && (
        <div
          className={`context-hud${clusterVisible ? " context-hud-visible" : ""}`}
          aria-hidden={!clusterVisible}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {chips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              className={`context-hud-chip context-hud-chip-${chip.tone || "default"}`}
              disabled={disabled}
              tabIndex={clusterVisible ? 0 : -1}
              onClick={() => fire(chip)}
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
