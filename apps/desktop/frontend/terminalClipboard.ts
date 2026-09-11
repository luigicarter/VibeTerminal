type KeyboardShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
>;

function usesPrimaryClipboardModifier(
  event: KeyboardShortcutEvent,
  platform?: string
) {
  return platform === "darwin" ? event.metaKey : event.ctrlKey;
}

export function isTerminalCopyShortcut(
  event: KeyboardShortcutEvent,
  platform?: string
) {
  return (
    !event.altKey &&
    event.key.toLowerCase() === "c" &&
    usesPrimaryClipboardModifier(event, platform)
  );
}

export function isTerminalPasteShortcut(
  event: KeyboardShortcutEvent,
  platform?: string
) {
  if (event.altKey) {
    return false;
  }

  const key = event.key.toLowerCase();
  if (key === "v" && usesPrimaryClipboardModifier(event, platform)) {
    return true;
  }

  return (
    key === "insert" &&
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey
  );
}
