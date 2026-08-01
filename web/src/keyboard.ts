/**
 * Map a DOM KeyboardEvent to the exact data string the extension's handleInput
 * expects. Returns null for keys that should not be forwarded (modifier-only,
 * F-keys, unmapped keys, or when focus is inside an input element).
 *
 * Verified against @earendil-works/pi-tui@0.83.0 matchesKey() legacy sequences.
 */

/** Options controlling which keys the terminal may capture. */
export interface KeyToDataOptions {
  /**
   * Capture Tab while focus sits on a button/link terminal control, so the
   * terminal owns Tab instead of letting it escape into browser focus
   * traversal. Editable content (input, textarea, select, contenteditable)
   * is never captured regardless of this option, and every other key on a
   * button/link stays uncaptured. Defaults to false, keeping the original
   * behavior for buttons/links.
   */
  captureTabOnControl?: boolean;
}

function closestMatch(target: unknown, selector: string): boolean {
  if (typeof target !== "object" || target === null) return false;
  const closest = (target as { closest?: (selectors: string) => Element | null })
    .closest;
  return typeof closest === "function" && closest.call(target, selector) !== null;
}

/**
 * True when the event target is (or is inside) an editable element
 * (`input`, `textarea`, `select`, or `[contenteditable="true"]`). These always
 * keep native browser keyboard behavior and are never captured by the
 * terminal, regardless of options.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  return closestMatch(target, 'input, textarea, select, [contenteditable="true"]');
}

/**
 * True when the event target is (or is inside) a button or link — a terminal
 * control the browser may focus. By default the terminal never captures keys
 * from these; callers may opt in to capture only Tab (see KeyToDataOptions).
 */
export function isTerminalControl(target: EventTarget | null): boolean {
  return closestMatch(target, "button, a[href]");
}

export function keyToData(
  e: KeyboardEvent,
  options: KeyToDataOptions = {},
): string | null {
  // Ignore keys when the user is typing in an editable element so that native
  // text entry and modal inputs (search, select prompt) keep full browser
  // keyboard behavior, including Tab for focus traversal.
  if (isEditableTarget(e.target)) return null;

  // Preserve browser and OS shortcuts (Cmd/Ctrl+R, Cmd/Ctrl+L, Alt+Left,
  // copy/paste, etc.) instead of turning them into terminal commands. Shift is
  // intentionally allowed because it determines printable character casing.
  if (e.metaKey || e.ctrlKey || e.altKey) return null;

  const onTerminalControl = isTerminalControl(e.target);

  // Tab is owned by the terminal: it is forwarded everywhere except while a
  // button/link terminal control holds focus, where the original behavior
  // (browser focus traversal) is kept unless the caller opts in.
  if (e.key === "Tab") {
    return onTerminalControl && !options.captureTabOnControl ? null : "\t";
  }

  // While a button/link terminal control holds focus, nothing else is
  // forwarded (unchanged default behavior).
  if (onTerminalControl) return null;

  const key = e.key;

  switch (key) {
    case "Enter":
      return "\r";
    case "Tab":
      return "\t";
    case "Escape":
      return "\x1b";
    case "Backspace":
      return "\x7f";
    case " ":
      return " ";
    case "ArrowUp":
      return "\x1b[A";
    case "ArrowDown":
      return "\x1b[B";
    case "ArrowRight":
      return "\x1b[C";
    case "ArrowLeft":
      return "\x1b[D";
    case "PageUp":
      return "\x1b[5~";
    case "PageDown":
      return "\x1b[6~";
    case "Home":
      return "\x1b[H";
    case "End":
      return "\x1b[F";
  }

  // Printable single characters (letters, digits, punctuation).
  // e.key is the typed character: "a", "A", "3", "?", "/", "[", "]", etc.
  // Case is preserved — the extension reads both upper and lower.
  if (key.length === 1) {
    const code = key.charCodeAt(0);
    if (code >= 0x20 && code <= 0x7e) return key;
  }

  // Modifier-only keys (Shift, Control, Alt, Meta), F-keys, and anything
  // else we don't recognise are intentionally not forwarded.
  return null;
}
