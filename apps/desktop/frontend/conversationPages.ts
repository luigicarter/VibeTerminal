export interface ConversationFragment {
  role: string;
  text: string;
  messageId: string;
  start: number;
  end: number;
}

// Pages arrive in chronological order, with the older page before the current
// page. Offsets are UTF-16 positions within the original message, not its page.
export function mergeConversationFragments(older: ConversationFragment[], current: ConversationFragment[]): ConversationFragment[] {
  const merged: ConversationFragment[] = [];
  for (const fragment of [...older, ...current]) {
    const previous = merged.at(-1);
    if (previous && previous.messageId === fragment.messageId && previous.role === fragment.role && fragment.start >= previous.start && fragment.start <= previous.end) {
      if (fragment.end > previous.end) {
        previous.text += fragment.text.slice(previous.end - fragment.start);
        previous.end = fragment.end;
      }
    } else merged.push({ ...fragment });
  }
  return merged;
}
