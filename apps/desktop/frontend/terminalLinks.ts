import type { Terminal } from "@xterm/xterm";
import { WebLinksAddon } from "@xterm/addon-web-links";

export function configureTerminalLinks(terminal: Terminal, openGeneratedImage?: (filename: string) => void) {
  const activate = (event: MouseEvent, url: string) => {
    event.preventDefault();
    void window.vibe?.openFusionChat.openExternal(url).catch(() => {});
  };

  // OSC 8 hyperlinks have their own provider; the web-links addon only handles
  // plain URLs. Override both so neither uses xterm's window.open fallback.
  terminal.options.linkHandler = { activate };
  terminal.loadAddon(new WebLinksAddon(activate));
  if (openGeneratedImage) terminal.registerLinkProvider({
    provideLinks(row, callback) {
      const line = terminal.buffer.active.getLine(row - 1), text = line?.translateToString(true) || '';
      const links = [...text.matchAll(/\bimage-[a-f0-9]{20}\.(?:png|jpg|webp)\b/g)].map(match => {
        let column = 0, offset = 0;
        while (line && column < terminal.cols && offset < match.index!) {
          const cell = line.getCell(column++);
          if (cell?.getWidth()) offset += cell.getChars().length || 1;
        }
        return { text: match[0], range: { start: { x: column + 1, y: row }, end: { x: column + match[0].length, y: row } },
          activate(event: MouseEvent) { event.preventDefault(); openGeneratedImage(match[0]); } };
      });
      callback(links);
    }
  });
}
