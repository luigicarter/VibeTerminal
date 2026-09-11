import { mergeConversationFragments, type ConversationFragment } from './conversationPages';

export const CONVERSATION_PAGE_CHARS = 16000;
export interface ConversationPage {
  fragments: ConversationFragment[];
  sourceVersion: string;
  olderCursor: string | null;
  hasMore: boolean;
}
export interface ConversationRefresh extends ConversationPage { bufferedOlder: ConversationFragment[] }

export function conversationPage(result: Record<string, unknown> | undefined): ConversationPage {
  if (!result?.ok) throw new Error(String(result?.error || 'Could not read this saved conversation.'));
  const messages = result.messages, ranges = result.messageRanges;
  if (!Array.isArray(messages) || !Array.isArray(ranges) || messages.length !== ranges.length || typeof result.sourceVersion !== 'string' || !result.sourceVersion) {
    throw new Error('This history response has no usable message ranges or source version.');
  }
  const fragments = messages.map((message, index) => {
    const range = ranges[index];
    if (typeof message?.role !== 'string' || typeof message.text !== 'string' || typeof range?.messageId !== 'string' || !range.messageId || !Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end < range.start || range.end - range.start !== message.text.length) {
      throw new Error('This history response has invalid message ranges.');
    }
    return { role: message.role, text: message.text, messageId: range.messageId, start: range.start, end: range.end };
  });
  return { fragments, sourceVersion: result.sourceVersion, olderCursor: typeof result.nextCursor === 'string' ? result.nextCursor : null, hasMore: result.hasMore === true };
}

// Rebuild from one fresh snapshot. Previously rendered text is only an anchor and
// size budget; it is never merged into pages belonging to a different revision.
export async function rebuildConversation(tail: ConversationPage, retained: ConversationFragment[], readOlder: (cursor: string) => Promise<ConversationPage>, current: () => boolean): Promise<ConversationRefresh | null> {
  let page = tail;
  let fragments = tail.fragments;
  const anchor = retained[0];
  const retainedChars = retained.reduce((sum, fragment) => sum + fragment.text.length, 0);
  const fallbackChars = retainedChars + CONVERSATION_PAGE_CHARS;
  const maxPages = Math.ceil(retainedChars / CONVERSATION_PAGE_CHARS) + 4;
  const seen = new Set<string>();
  for (let count = 1; current(); count++) {
    const anchorIndex = anchor ? fragments.findIndex(fragment => fragment.messageId === anchor.messageId && fragment.role === anchor.role && fragment.start <= anchor.start && fragment.end >= anchor.start) : -1;
    if (anchorIndex >= 0) {
      const first = fragments[anchorIndex];
      let offset = anchor.start - first.start;
      // A rewritten message can put the old offset inside a surrogate pair.
      if (offset > 0 && /[\uDC00-\uDFFF]/.test(first.text[offset] || '') && /[\uD800-\uDBFF]/.test(first.text[offset - 1])) offset--;
      const bufferedOlder = fragments.slice(0, anchorIndex);
      if (offset) bufferedOlder.push({ ...first, text: first.text.slice(0, offset), end: first.start + offset });
      const visible = [{ ...first, text: first.text.slice(offset), start: first.start + offset }, ...fragments.slice(anchorIndex + 1)].filter(fragment => fragment.text.length > 0);
      return { ...page, fragments: visible, bufferedOlder };
    }
    if (!anchor || !page.hasMore || fragments.reduce((sum, fragment) => sum + fragment.text.length, 0) >= fallbackChars) return { ...page, fragments, bufferedOlder: [] };
    if (count >= maxPages || !page.olderCursor || seen.has(page.olderCursor)) return null;
    seen.add(page.olderCursor);
    page = await readOlder(page.olderCursor);
    if (!current() || page.sourceVersion !== tail.sourceVersion) return null;
    fragments = mergeConversationFragments(page.fragments, fragments);
  }
  return null;
}
