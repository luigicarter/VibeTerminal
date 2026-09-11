import type { CodexWebApi } from './codexWeb';

export function bindTerminalImageDrop(element: HTMLElement, options: { enabled: () => boolean; filePath: (file: File) => string; drop: (paths: string[]) => void }) {
  const dragover = (event: DragEvent) => {
    if (options.enabled() && event.dataTransfer?.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }
  };
  const drop = (event: DragEvent) => {
    if (!options.enabled() || !event.dataTransfer?.files.length) return;
    event.preventDefault(); event.stopPropagation();
    options.drop(Array.from(event.dataTransfer.files).map(options.filePath));
  };
  element.addEventListener('dragover', dragover, true); element.addEventListener('drop', drop, true);
  return () => { element.removeEventListener('dragover', dragover, true); element.removeEventListener('drop', drop, true); };
}

// Feed file paths through Codex's normal bracketed-paste image attachment path.
// No image is submitted to a model until the user sends the native prompt.
export async function attachTerminalImages(options: {
  pane: { id: string; launchToken: number }; paths?: string[]; action: CodexWebApi['action'];
  isCurrent: () => boolean; paste: (text: string) => unknown; onError: (message: string) => void;
}): Promise<boolean> {
  try {
    const result = await options.action({ ...options.pane, action: options.paths ? 'attach-images' : 'clipboard-image', ...(options.paths ? { paths: options.paths } : {}) });
    if (!options.isCurrent()) return true;
    if (!result.ok) { options.onError(result.error?.message || 'Could not attach the image.'); return true; }
    if (!result.attachmentPaths?.length) return false;
    for (const file of result.attachmentPaths) options.paste('"' + file.replace(/"/g, '\\"') + '"');
    return true;
  } catch {
    if (options.isCurrent()) options.onError('Could not attach the image. Retry when the terminal is connected.');
    return true;
  }
}
