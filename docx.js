// Pulls plain text out of a Word (.docx) file. A .docx is a zip archive;
// the text lives in word/document.xml.

export async function readDocx(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const xml = new TextDecoder().decode(await unzipEntry(buf, "word/document.xml"));
  return xml
    .split(/<\/w:p>/)
    .map((p) =>
      [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)]
        .map((m) => (m[0] === "<w:tab/>" ? "\t" : m[0] === "<w:br/>" ? "\n" : m[1]))
        .join(""))
    .map(decodeEntities)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(s) {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e) => {
    const named = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[e.toLowerCase()];
    if (named) return named;
    return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}

async function unzipEntry(buf, name) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // The end-of-central-directory record sits within the last 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a valid Word file");

  const entries = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  for (let n = 0; n < entries; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const entryName = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    if (entryName === name) {
      const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
      const data = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) return data;
      if (method !== 8) throw new Error("unsupported compression");
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error("no document text found");
}
