/**
 * Map a DOM KeyboardEvent to the exact data string the extension's handleInput
 * expects. Returns null for keys that should not be forwarded (modifier-only,
 * F-keys, unmapped keys, or when focus is inside an input element).
 *
 * Verified against @earendil-works/pi-tui@0.83.0 matchesKey() legacy sequences.
 */
export function keyToData(e: KeyboardEvent): string | null {
  // Ignore keys when the user is typing in an interactive element so that
  // browser-native inputs (search, select prompt) work without interference.
  const target = e.target;
  if (
    target instanceof Element &&
    target.closest(
      'input, textarea, select, button, a[href], [contenteditable="true"]',
    )
  )
    return null;

  // Preserve browser and OS shortcuts (Cmd/Ctrl+R, Cmd/Ctrl+L, Alt+Left,
  // copy/paste, etc.) instead of turning them into terminal commands. Shift is
  // intentionally allowed because it determines printable character casing.
  if (e.metaKey || e.ctrlKey || e.altKey) return null;

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
