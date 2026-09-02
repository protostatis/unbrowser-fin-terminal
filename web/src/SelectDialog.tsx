import { useEffect, useId, useRef, type KeyboardEvent } from "react";

interface SelectDialogProps {
  title: string;
  options: string[];
  onSelect: (value: string) => void;
  onCancel: () => void;
}

/** Shared select prompt with a contained, predictable keyboard focus loop. */
export function SelectDialog({ title, options, onSelect, onCancel }: SelectDialogProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const first = modalRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    first?.focus();
  }, [options.length]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const modal = modalRef.current;
    if (!modal) return;
    const focusable = Array.from(
      modal.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
    );
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    const activeInside = document.activeElement instanceof Node && modal.contains(document.activeElement);
    if (event.shiftKey && (!activeInside || document.activeElement === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (!activeInside || document.activeElement === last)) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="select-overlay" onClick={onCancel}>
      <div
        ref={modalRef}
        className="select-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div id={titleId} className="select-title">{title}</div>
        <div className="select-options">
          {options.map((option, index) => (
            <button
              type="button"
              key={`${title}-${index}`}
              className="select-option"
              onClick={() => onSelect(option)}
            >
              {option}
            </button>
          ))}
        </div>
        <button type="button" className="select-cancel" onClick={onCancel}>
          Cancel (Esc)
        </button>
      </div>
    </div>
  );
}
