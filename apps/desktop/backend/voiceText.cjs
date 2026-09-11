// Speech gets prose while the renderer/history retain the original Markdown.
// Protect code and escapes first: stripping every star/underscore would change
// commands, identifiers, glob patterns and multiplication into different text.
function spokenText(value) {
  const literals = [];
  const keep = text => `\u0000${literals.push(text) - 1}\u0000`;
  let text = String(value || '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  text = text.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n([\s\S]*?)(?:\n {0,3}\1[ \t]*(?=\n|$)|(?![\s\S]))/gm, (_all, _fence, code) => keep(code));
  // A code delimiter must match a complete run of the same length. Shorter
  // runs inside it are code content, including literal shell backticks.
  text = text.replace(/(?<!`)(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)/g, (_all, _ticks, code) => keep(code));
  text = text.replace(/\\([\\`*{}\[\]()#+.!_>~-])/g, (_all, literal) => keep(literal));
  // Link labels carry the meaning; destinations and reference definitions are
  // visual navigation metadata. Bare URLs remain available to the listener.
  text = text.replace(/^ {0,3}\[[^\]\n]+\]:[ \t]+\S+[^\n]*$/gm, '');
  text = text.replace(/!?\[([^\]\n]+)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, '$1');
  text = text.replace(/!?\[([^\]\n]+)\]\[[^\]\n]*\]/g, '$1');
  text = text.replace(/<(https?:\/\/[^>\s]+|[^<>\s]+@[^<>\s]+)>/g, '$1');
  text = text.replace(/^ {0,3}(?:[-*_][ \t]*){3,}$/gm, '')
    .replace(/^ {0,3}(?:=+|-+)[ \t]*$/gm, '')
    .replace(/^ {0,3}(?:>[ \t]*)+/gm, '')
    .replace(/^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/gm, '$1')
    .replace(/^[ \t]*[-+*][ \t]+(?:\[[ xX]\][ \t]+)?/gm, '')
    .replace(/^[ \t]*(\d+)[.)][ \t]+/gm, '$1. ');
  // Whitespace on both sides makes these runs operators, not emphasis. Protect
  // them atomically so single-star matching cannot consume part of a ** run.
  // Do this after removing structural Markdown (including *** thematic breaks).
  text = text.replace(/(?<!\S)\*{2,}(?!\S)/g, keep);
  // Only paired delimiters around non-whitespace prose are formatting. Keep
  // intraword underscores (file_names) and spaced operators (2 * 3 * 4).
  for (const marker of ['\\*\\*\\*', '___', '\\*\\*', '__', '~~', '\\*', '_']) {
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])${marker}(?=\\S)([^\\n]*?\\S)${marker}(?![\\p{L}\\p{N}_])`, 'gu');
    text = text.replace(pattern, '$1$2');
  }
  return text.replace(/\u0000(\d+)\u0000/g, (_all, index) => literals[Number(index)])
    .replace(/\s+/g, ' ').trim();
}

module.exports = { spokenText };
