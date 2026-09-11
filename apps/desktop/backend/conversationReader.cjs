const fs = require('fs');
const crypto = require('crypto');
const RECORD_LIMIT = 8 * 1024 * 1024;
const SCAN_LIMIT = 2 * 1024 * 1024;
const encodedBytes = text => Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;
function tailStart(text, start, end, bytes) {
  if (encodedBytes(text.slice(start,end)) <= bytes) return start;
  let at=end,cost=0; while(at>start) { let previous=at-1; if(previous>start && /[\uDC00-\uDFFF]/.test(text[previous]) && /[\uD800-\uDBFF]/.test(text[previous-1])) previous--; const next=encodedBytes(text.slice(previous,at)); if(cost+next>bytes)break; cost+=next;at=previous; } return at;
}
const clamp = (n, fallback, max) => Number.isFinite(Number(n)) ? Math.max(1, Math.min(max, Math.floor(Number(n)))) : fallback;
function signature(file) { const s = fs.statSync(file); return JSON.stringify([fs.realpathSync(file), s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs]); }
function parse(text, decode) { try { return decode([JSON.parse(text)]); } catch (e) { if (e instanceof SyntaxError) return []; throw e; } }
// Only line buffers are retained; there is no transcript archive or full-file cache.
function line(fd, position, size, backwards) {
  let chunks = [], bytes = 0, start = backwards ? 0 : position, end = position;
  if (backwards && end > 0) { const b = Buffer.alloc(1); fs.readSync(fd,b,0,1,end-1); if (b[0]===10) end--; }
  let at = backwards ? end : position;
  while (backwards ? at > 0 : at < size) {
    const offset = backwards ? Math.max(0, at-65536) : at;
    const b = Buffer.alloc(Math.min(65536, backwards ? at-offset : size-at));
    const count = fs.readSync(fd,b,0,b.length,offset); if (!count) break;
    const chunk = b.subarray(0,count); const index = backwards ? chunk.lastIndexOf(10) : chunk.indexOf(10);
    const part = index < 0 ? chunk : backwards ? chunk.subarray(index+1) : chunk.subarray(0,index);
    bytes += part.length; if (bytes > RECORD_LIMIT) throw new Error('Transcript record exceeds the supported 8 MB limit.');
    if (backwards) chunks.unshift(part); else chunks.push(part);
    at = backwards ? offset : offset+count;
    if (index >= 0) { if(backwards) start=offset+index+1; else end=offset+index+1; break; }
    if (backwards) start=offset; else end=offset+count;
  }
  return { start, end: backwards ? position : end, text: Buffer.concat(chunks).toString('utf8') };
}
function createConversationReader() {
  const cursors = new Map();
  function token(value) { const key=crypto.randomBytes(24).toString('base64url'); cursors.set(key,value); if(cursors.size>4000)cursors.delete(cursors.keys().next().value); return key; }
  function source({file,messages,decode}) {
    if (!file) { const text=JSON.stringify(messages); if(Buffer.byteLength(text)>RECORD_LIMIT)throw new Error('Transcript exceeds the supported 8 MB export limit.'); return { snapshot:crypto.createHash('sha256').update(text).digest('hex'),size:Buffer.byteLength(text), messages }; }
    const snapshot=signature(file),size=fs.statSync(file).size;
    if(file.endsWith('.json')) { if(size>RECORD_LIMIT)throw new Error('Legacy transcript exceeds the supported 8 MB reader limit.'); return {snapshot,size,messages:decode([JSON.parse(fs.readFileSync(file,'utf8'))]),file}; }
    return {snapshot,size,file,decode};
  }
  function context(input, sourceInput, kind) {
    const s=source(sourceInput); const binding=JSON.stringify([input.reference,sourceInput.binding,s.snapshot]);
    let saved;
    if(input.cursor!==undefined && input.cursor!==null) { saved=cursors.get(input.cursor); if(!saved || saved.binding!==binding || saved.kind!==kind || (kind==='search' && saved.query!==input.query))throw new Error('Invalid or expired conversation cursor; the transcript may have changed. Start again.'); }
    return {s,binding,saved};
  }
  function read(input, sourceInput) {
    const {s,binding,saved}=context(input,sourceInput,'read'); let pos=saved?.pos || {end:s.messages ? s.messages.length : s.size};
    const maxChars=clamp(input.maxChars,16000,64000), limit=clamp(input.limit,200,200); let left=maxChars, byteLeft=clamp(input.maxBytes,262144,262144), scanned=0; const out=[],locations=[]; const began=Date.now();
    const fd=s.messages?null:fs.openSync(s.file,'r');
    try {
      while(pos.end>0 && left>0 && out.length<limit && scanned<SCAN_LIMIT && Date.now()-began<1000) {
        const row=s.messages?{start:pos.end-1,end:pos.end,items:[s.messages[pos.end-1]]}:(()=>{const r=line(fd,pos.end,s.size,true); scanned+=r.end-r.start; return {...r,items:parse(r.text,s.decode)};})();
        let index=pos.index??row.items.length-1, textEnd=pos.textEnd;
        while(index>=0 && left>0 && out.length<limit) {
          const m=row.items[index]; const end=textEnd??m.text.length; let start=Math.max(0,end-left);
          // Never split a UTF-16 surrogate pair. A one-character budget can use
          // an empty continuation page only if the caller requested that size.
          if(start>0 && /[\uDC00-\uDFFF]/.test(m.text[start]) && /[\uD800-\uDBFF]/.test(m.text[start-1])) start++;
          start=tailStart(m.text,start,end,byteLeft);
          if(start===end) { if(!out.length) throw new Error('The page budget cannot fit the next Unicode character. Increase maxChars or maxBytes.'); left=0; break; }
          out.unshift({role:m.role,text:m.text.slice(start,end)}); locations.unshift({messageId:`${row.start}:${index}`,start,end}); left-=end-start; byteLeft-=encodedBytes(m.text.slice(start,end));
          if(start>0) { pos={end:row.end,index,textEnd:start}; index=-2; break; }
          index--; textEnd=undefined; pos=index>=0?{end:row.end,index}:{end:row.start};
        }
        if(index===-2)break;
        if(index<0)pos={end:row.start};
      }
      if(s.file && signature(s.file)!==s.snapshot)throw new Error('Transcript changed during reading. Start again.');
    } finally { if(fd!==null)fs.closeSync(fd); }
    const hasMore=pos.end>0;
    return {sourceVersion:crypto.createHash('sha256').update(s.snapshot).digest('hex').slice(0,24),messages:out,messageRanges:locations,range:{start:locations[0]||null,end:locations.at(-1)||null},nextCursor:hasMore?token({kind:'read',binding,pos}):null,hasMore,direction:'older',truncated:hasMore};
  }
  function search(input,sourceInput) {
    if(typeof input.query!=='string'||!input.query.trim()||input.query.length>500)throw new Error('Search requires a plain-text query of 1–500 characters.');
    const {s,binding,saved}=context(input,sourceInput,'search'); let at=saved?.at||0,index=saved?.index||0; const initial=at,matches=[],limit=clamp(input.limit,10,30),began=Date.now(); const needle=input.query.toLowerCase(); let scanned=0, byteLeft=clamp(input.maxBytes,16384,262144);
    const fd=s.messages?null:fs.openSync(s.file,'r');
    try {
      while(at<(s.messages?s.messages.length:s.size)&&scanned<SCAN_LIMIT&&Date.now()-began<1000&&matches.length<limit) {
        const row=s.messages?{start:at,end:at+1,items:[s.messages[at]]}:(()=>{const r=line(fd,at,s.size,false);return {...r,items:parse(r.text,s.decode)};})();
        scanned+=s.messages?Buffer.byteLength(row.items[0].text):row.end-row.start;
        for(;index<row.items.length;index++) { const m=row.items[index],offset=m.text.toLowerCase().indexOf(needle); if(offset<0)continue;
          let snippetStart=Math.max(0,offset-100),snippetEnd=Math.min(m.text.length,offset+input.query.length+140);
          while(snippetEnd>offset+input.query.length && encodedBytes(m.text.slice(snippetStart,snippetEnd))>byteLeft)snippetEnd--;
          while(snippetStart<offset && encodedBytes(m.text.slice(snippetStart,snippetEnd))>byteLeft)snippetStart++;
          if(encodedBytes(m.text.slice(snippetStart,snippetEnd))>byteLeft) { if(!matches.length)throw new Error('Search byte budget cannot fit the query. Increase maxBytes.'); break; }
          if(snippetStart>0 && /[\uDC00-\uDFFF]/.test(m.text[snippetStart]))snippetStart++;
          if(snippetEnd<m.text.length && /[\uDC00-\uDFFF]/.test(m.text[snippetEnd]))snippetEnd--;
          byteLeft-=encodedBytes(m.text.slice(snippetStart,snippetEnd));
          matches.push({role:m.role,snippet:m.text.slice(snippetStart,snippetEnd),messageId:`${row.start}:${index}`,readCursor:token({kind:'read',binding,pos:{end:row.end,index,textEnd:snippetEnd}})});
          if(matches.length>=limit){index++;break;}
        }
        if(index>=row.items.length){at=row.end;index=0;} else break;
      }
      if(s.file&&signature(s.file)!==s.snapshot)throw new Error('Transcript changed during search. Start again.');
    }finally{if(fd!==null)fs.closeSync(fd);}
    const complete=at>=(s.messages?s.messages.length:s.size);
    return {sourceVersion:crypto.createHash('sha256').update(s.snapshot).digest('hex').slice(0,24),matches,coverage:{complete,scannedBytes:scanned,totalBytes:s.size,scope:'Human user and assistant prose',from:initial},nextCursor:complete?null:token({kind:'search',binding,query:input.query,at,index}),hasMore:!complete,untrustedContent:true};
  }
  return {read,search};
}
module.exports={createConversationReader};
