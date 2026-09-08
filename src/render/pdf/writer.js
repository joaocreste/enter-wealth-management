/**
 * A small PDF writer.
 *
 * Why hand-rolled: the letter has a hard two-page limit, brand-specified
 * typefaces and vector charts that must match the HTML exactly. A headless
 * browser gives none of those guarantees cheaply, and it cannot run inside a
 * Cloudflare Worker. This produces a deterministic, byte-stable PDF from the
 * same canonical report object the HTML uses, in pure JavaScript, with no
 * runtime dependency.
 *
 * Fonts are embedded as CIDFontType2 with Identity-H encoding, so Portuguese
 * accents and the true minus sign U+2212 render correctly.
 */
import { TrueTypeFont } from './ttf.js';

const MM = 72 / 25.4;
export const A4 = { width: 595.28, height: 841.89 };
export { MM };

const encoder = new TextEncoder();

/**
 * A PDF text string. ASCII goes out as a literal; anything else becomes a
 * UTF-16BE hex string with a byte-order mark, which is the only encoding a
 * reader is required to understand for document metadata. Without this, an
 * accented client name shows as mojibake in the title bar.
 */
function pdfString(str) {
  const s = String(str ?? '');
  if (/^[\x20-\x7E]*$/.test(s)) return `(${s.replace(/([\\()])/g, '\\$1')})`;
  let hex = 'FEFF';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp > 0xFFFF) {
      const v = cp - 0x10000;
      hex += (0xD800 + (v >> 10)).toString(16).padStart(4, '0');
      hex += (0xDC00 + (v & 0x3FF)).toString(16).padStart(4, '0');
    } else {
      hex += cp.toString(16).padStart(4, '0');
    }
  }
  return `<${hex.toUpperCase()}>`;
}

/** PDF hex string of 2-byte glyph ids, for Identity-H. */
function hexGlyphs(glyphs) {
  return glyphs.map((g) => g.toString(16).padStart(4, '0')).join('');
}

export class PdfDocument {
  constructor({ title = '', author = '', subject = '', keywords = '' } = {}) {
    this.objects = [null]; // 1-indexed
    this.pages = [];
    this.fonts = new Map();
    this.meta = { title, author, subject, keywords };
    this.current = null;
  }

  #alloc(content) { this.objects.push(content); return this.objects.length - 1; }

  /** @param {Uint8Array} bytes raw ttf @returns {{key:string, font:TrueTypeFont}} */
  registerFont(key, bytes) {
    if (this.fonts.has(key)) return this.fonts.get(key);
    const font = new TrueTypeFont(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    const entry = { key, font, bytes, resourceName: `F${this.fonts.size + 1}` };
    this.fonts.set(key, entry);
    return entry;
  }

  font(key) {
    const e = this.fonts.get(key);
    if (!e) throw new Error(`font ${key} is not registered`);
    return e;
  }

  measure(key, text, size) { return this.font(key).font.measure(text, size); }

  addPage({ width = A4.width, height = A4.height } = {}) {
    const page = { width, height, ops: [] };
    this.pages.push(page);
    this.current = page;
    return page;
  }

  // ── content operators ────────────────────────────────────────────────────
  #op(s) { this.current.ops.push(s); }

  text(str, x, y, { font = 'sans', size = 10, color = '#0B0D0E', charSpacing = 0, wordSpacing = 0 } = {}) {
    if (str == null || str === '') return 0;
    const e = this.font(font);
    const { glyphs, width } = e.font.encode(String(str));
    const [r, g, b] = hexToRgb(color);
    this.#op(`BT /${e.resourceName} ${size} Tf ${r} ${g} ${b} rg ${charSpacing ? `${charSpacing} Tc ` : ''}${wordSpacing ? `${wordSpacing} Tw ` : ''}1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm <${hexGlyphs(glyphs)}> Tj ET`);
    return (width / 1000) * size;
  }

  textRight(str, xRight, y, opts = {}) {
    const w = this.measure(opts.font || 'sans', str, opts.size || 10);
    return this.text(str, xRight - w, y, opts);
  }

  textCenter(str, xCenter, y, opts = {}) {
    const w = this.measure(opts.font || 'sans', str, opts.size || 10);
    return this.text(str, xCenter - w / 2, y, opts);
  }

  /** Wrap to a measure and return the lines without drawing them. */
  wrap(str, { font = 'sans', size = 10, maxWidth = 400 }) {
    const words = String(str ?? '').split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (this.measure(font, test, size) <= maxWidth || !line) line = test;
      else { lines.push(line); line = w; }
    }
    if (line) lines.push(line);
    return lines;
  }

  /** Draw wrapped text; returns the y coordinate after the last line. */
  paragraph(str, x, y, { font = 'sans', size = 10, leading = null, maxWidth = 400, color = '#2E3439', align = 'left' } = {}) {
    const lh = leading ?? size * 1.45;
    const lines = this.wrap(str, { font, size, maxWidth });
    let cy = y;
    for (const line of lines) {
      if (align === 'right') this.textRight(line, x + maxWidth, cy, { font, size, color });
      else if (align === 'center') this.textCenter(line, x + maxWidth / 2, cy, { font, size, color });
      else this.text(line, x, cy, { font, size, color });
      cy -= lh;
    }
    return cy;
  }

  /** Height a paragraph will occupy, for layout decisions before drawing. */
  paragraphHeight(str, { font = 'sans', size = 10, leading = null, maxWidth = 400 }) {
    const lh = leading ?? size * 1.45;
    return this.wrap(str, { font, size, maxWidth }).length * lh;
  }

  rect(x, y, w, h, { fill = null, stroke = null, lineWidth = 0.6 } = {}) {
    let s = '';
    if (fill) { const [r, g, b] = hexToRgb(fill); s += `${r} ${g} ${b} rg `; }
    if (stroke) { const [r, g, b] = hexToRgb(stroke); s += `${r} ${g} ${b} RG ${lineWidth} w `; }
    s += `${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re `;
    s += fill && stroke ? 'B' : fill ? 'f' : 'S';
    this.#op(s);
  }

  line(x1, y1, x2, y2, { color = '#D3D8DA', width = 0.6, dash = null } = {}) {
    const [r, g, b] = hexToRgb(color);
    this.#op(`${dash ? `[${dash.join(' ')}] 0 d ` : '[] 0 d '}${r} ${g} ${b} RG ${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
  }

  path(d, { stroke = '#0B0D0E', fill = null, width = 1, cap = 2, join = 0 } = {}) {
    let s = '';
    if (fill) { const [r, g, b] = hexToRgb(fill); s += `${r} ${g} ${b} rg `; }
    if (stroke) { const [r, g, b] = hexToRgb(stroke); s += `${r} ${g} ${b} RG ${width} w ${cap} J ${join} j `; }
    s += `${d} `;
    s += fill && stroke ? 'B' : fill ? 'f' : 'S';
    this.#op(s);
  }

  // ── serialisation ────────────────────────────────────────────────────────
  #fontObjects() {
    const map = {};
    for (const [key, e] of this.fonts) {
      const { font, bytes } = e;
      const d = font.descriptor();

      const fileId = this.#alloc({
        stream: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
        dict: `<< /Length ${bytes.length} /Length1 ${bytes.length} >>`,
      });

      const descId = this.#alloc(`<< /Type /FontDescriptor /FontName /${d.fontName} /Flags ${d.flags} /FontBBox [${d.bbox.join(' ')}] /ItalicAngle ${d.italicAngle} /Ascent ${d.ascent} /Descent ${d.descent} /CapHeight ${d.capHeight} /StemV ${d.stemV} /FontFile2 ${fileId} 0 R >>`);

      // W array: only glyphs whose width differs from the default
      const defaultWidth = font.widthOf(font.glyphFor(0x20)) || 500;
      const runs = [];
      let run = null;
      for (let g = 0; g < font.numGlyphs; g += 1) {
        const w = font.widthOf(g);
        if (w === defaultWidth) { run = null; continue; }
        if (run && run.start + run.widths.length === g) run.widths.push(w);
        else { run = { start: g, widths: [w] }; runs.push(run); }
      }
      const wArray = runs.map((r) => `${r.start} [${r.widths.join(' ')}]`).join(' ');

      const cidId = this.#alloc(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${d.fontName} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descId} 0 R /DW ${defaultWidth} /W [${wArray}] /CIDToGIDMap /Identity >>`);

      // ToUnicode keeps the text selectable and searchable in a reader
      const cmapStream = buildToUnicode(font);
      const cmapId = this.#alloc({ stream: encoder.encode(cmapStream), dict: `<< /Length ${encoder.encode(cmapStream).length} >>` });

      const fontId = this.#alloc(`<< /Type /Font /Subtype /Type0 /BaseFont /${d.fontName} /Encoding /Identity-H /DescendantFonts [${cidId} 0 R] /ToUnicode ${cmapId} 0 R >>`);
      map[e.resourceName] = fontId;
    }
    return map;
  }

  build() {
    const fontMap = this.#fontObjects();
    const fontRes = Object.entries(fontMap).map(([name, oid]) => `/${name} ${oid} 0 R`).join(' ');

    const pagesId = this.#alloc('PLACEHOLDER');
    const pageIds = [];
    for (const page of this.pages) {
      const content = page.ops.join('\n');
      const bytes = encoder.encode(content);
      const contentId = this.#alloc({ stream: bytes, dict: `<< /Length ${bytes.length} >>` });
      const pageId = this.#alloc(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${page.width.toFixed(2)} ${page.height.toFixed(2)}] /Resources << /Font << ${fontRes} >> /ProcSet [/PDF /Text] >> /Contents ${contentId} 0 R >>`);
      pageIds.push(pageId);
    }
    this.objects[pagesId] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] >>`;

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const dateStr = `D:${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
    const infoId = this.#alloc(`<< /Title ${pdfString(this.meta.title)} /Author ${pdfString(this.meta.author)} /Subject ${pdfString(this.meta.subject)} /Keywords ${pdfString(this.meta.keywords)} /Producer (Enter Asset Management reporting engine) /Creator (Enter Asset Management reporting engine) /CreationDate (${dateStr}) /ModDate (${dateStr}) >>`);
    const catalogId = this.#alloc(`<< /Type /Catalog /Pages ${pagesId} 0 R /Lang (pt-BR) >>`);

    // ── assemble ──
    const chunks = [];
    let length = 0;
    const push = (bytes) => { chunks.push(bytes); length += bytes.length; };
    const pushStr = (s) => push(encoder.encode(s));

    pushStr('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
    const offsets = new Array(this.objects.length).fill(0);

    for (let i = 1; i < this.objects.length; i += 1) {
      offsets[i] = length;
      const obj = this.objects[i];
      if (obj && typeof obj === 'object' && obj.stream) {
        pushStr(`${i} 0 obj\n${obj.dict}\nstream\n`);
        push(obj.stream);
        pushStr('\nendstream\nendobj\n');
      } else {
        pushStr(`${i} 0 obj\n${obj}\nendobj\n`);
      }
    }

    const xrefStart = length;
    let xref = `xref\n0 ${this.objects.length}\n0000000000 65535 f \n`;
    for (let i = 1; i < this.objects.length; i += 1) {
      xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    }
    pushStr(xref);
    pushStr(`trailer\n<< /Size ${this.objects.length} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

    const out = new Uint8Array(length);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  get pageCount() { return this.pages.length; }
}

function buildToUnicode(font) {
  const entries = [];
  for (const [cp, gid] of font.cmap) {
    if (cp > 0xFFFF) continue;
    entries.push([gid, cp]);
  }
  entries.sort((a, b) => a[0] - b[0]);
  const lines = [];
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    lines.push(`${chunk.length} beginbfchar`);
    for (const [gid, cp] of chunk) {
      lines.push(`<${gid.toString(16).padStart(4, '0')}> <${cp.toString(16).padStart(4, '0')}>`);
    }
    lines.push('endbfchar');
  }
  return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${lines.join('\n')}
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
}

export function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map((v) => v.toFixed(4));
}
