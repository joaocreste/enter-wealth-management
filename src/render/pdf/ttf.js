/**
 * Minimal TrueType reader.
 *
 * Enough of the format to embed Archivo and Newsreader as CIDFontType2 fonts
 * with Identity-H encoding: the unicode-to-glyph map, the advance widths and
 * the metrics the PDF font descriptor requires.
 *
 * Whole-file embedding rather than subsetting. A subsetter is a week of work
 * and the two families together add roughly 220 KB to a PDF that is already
 * allowed 16 MB — the trade is obvious for an MVP, and the note is here so the
 * next person does not have to rediscover the reasoning.
 */

export class TrueTypeFont {
  /** @param {Uint8Array} data raw .ttf bytes */
  constructor(data) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.tables = {};
    this.#readDirectory();
    this.#readHead();
    this.#readHhea();
    this.#readMaxp();
    this.#readHmtx();
    this.#readCmap();
    this.#readOs2();
    this.#readPost();
    this.#readName();
  }

  u8(o) { return this.view.getUint8(o); }
  u16(o) { return this.view.getUint16(o); }
  i16(o) { return this.view.getInt16(o); }
  u32(o) { return this.view.getUint32(o); }

  #readDirectory() {
    const numTables = this.u16(4);
    for (let i = 0; i < numTables; i += 1) {
      const p = 12 + i * 16;
      const tag = String.fromCharCode(this.u8(p), this.u8(p + 1), this.u8(p + 2), this.u8(p + 3));
      this.tables[tag] = { offset: this.u32(p + 8), length: this.u32(p + 12) };
    }
  }

  #readHead() {
    const t = this.tables.head;
    if (!t) throw new Error('font has no head table');
    this.unitsPerEm = this.u16(t.offset + 18);
    this.xMin = this.i16(t.offset + 36);
    this.yMin = this.i16(t.offset + 38);
    this.xMax = this.i16(t.offset + 40);
    this.yMax = this.i16(t.offset + 42);
    this.indexToLocFormat = this.i16(t.offset + 50);
  }

  #readHhea() {
    const t = this.tables.hhea;
    this.ascender = this.i16(t.offset + 4);
    this.descender = this.i16(t.offset + 6);
    this.lineGap = this.i16(t.offset + 8);
    this.numberOfHMetrics = this.u16(t.offset + 34);
  }

  #readMaxp() { this.numGlyphs = this.u16(this.tables.maxp.offset + 4); }

  #readHmtx() {
    const t = this.tables.hmtx;
    this.advanceWidths = new Uint16Array(this.numGlyphs);
    let last = 0;
    for (let i = 0; i < this.numGlyphs; i += 1) {
      if (i < this.numberOfHMetrics) {
        last = this.u16(t.offset + i * 4);
        this.advanceWidths[i] = last;
      } else {
        this.advanceWidths[i] = last;
      }
    }
  }

  #readOs2() {
    const t = this.tables['OS/2'];
    if (!t) { this.sCapHeight = Math.round(this.unitsPerEm * 0.7); this.usWeightClass = 400; this.sxHeight = Math.round(this.unitsPerEm * 0.5); return; }
    this.usWeightClass = this.u16(t.offset + 4);
    this.fsType = this.u16(t.offset + 8);
    const version = this.u16(t.offset);
    this.sxHeight = version >= 2 ? this.i16(t.offset + 86) : Math.round(this.unitsPerEm * 0.5);
    this.sCapHeight = version >= 2 ? this.i16(t.offset + 88) : Math.round(this.unitsPerEm * 0.7);
    if (!this.sCapHeight) this.sCapHeight = Math.round(this.unitsPerEm * 0.7);
  }

  #readPost() {
    const t = this.tables.post;
    this.italicAngle = t ? this.view.getInt32(t.offset + 4) / 65536 : 0;
    this.isFixedPitch = t ? this.u32(t.offset + 12) !== 0 : false;
  }

  #readName() {
    const t = this.tables.name;
    this.postScriptName = 'EmbeddedFont';
    if (!t) return;
    const count = this.u16(t.offset + 2);
    const stringOffset = this.u16(t.offset + 4);
    for (let i = 0; i < count; i += 1) {
      const p = t.offset + 6 + i * 12;
      const nameId = this.u16(p + 6);
      if (nameId !== 6) continue;
      const platformId = this.u16(p);
      const length = this.u16(p + 8);
      const offset = this.u16(p + 10);
      const base = t.offset + stringOffset + offset;
      let s = '';
      if (platformId === 3) {
        for (let k = 0; k < length; k += 2) s += String.fromCharCode(this.u16(base + k));
      } else {
        for (let k = 0; k < length; k += 1) s += String.fromCharCode(this.u8(base + k));
      }
      if (s) { this.postScriptName = s.replace(/[^\x21-\x7E]/g, '').replace(/[()<>[\]{}/%]/g, ''); break; }
    }
  }

  #readCmap() {
    const t = this.tables.cmap;
    this.cmap = new Map();
    if (!t) return;
    const n = this.u16(t.offset + 2);
    let best = null;
    for (let i = 0; i < n; i += 1) {
      const p = t.offset + 4 + i * 8;
      const platformId = this.u16(p);
      const encodingId = this.u16(p + 2);
      const offset = this.u32(p + 4);
      const score =
        platformId === 3 && encodingId === 10 ? 5 :
        platformId === 3 && encodingId === 1 ? 4 :
        platformId === 0 ? 3 : 1;
      if (!best || score > best.score) best = { score, offset: t.offset + offset };
    }
    if (!best) return;

    const sub = best.offset;
    const format = this.u16(sub);
    if (format === 4) {
      const segCountX2 = this.u16(sub + 6);
      const segCount = segCountX2 / 2;
      const endBase = sub + 14;
      const startBase = endBase + segCountX2 + 2;
      const deltaBase = startBase + segCountX2;
      const rangeBase = deltaBase + segCountX2;
      for (let s = 0; s < segCount; s += 1) {
        const end = this.u16(endBase + s * 2);
        const start = this.u16(startBase + s * 2);
        const delta = this.i16(deltaBase + s * 2);
        const rangeOffset = this.u16(rangeBase + s * 2);
        if (start === 0xFFFF) continue;
        for (let c = start; c <= end && c !== 0x10000; c += 1) {
          let g;
          if (rangeOffset === 0) g = (c + delta) & 0xFFFF;
          else {
            const gi = rangeBase + s * 2 + rangeOffset + (c - start) * 2;
            if (gi + 1 >= this.data.byteLength) continue;
            g = this.u16(gi);
            if (g !== 0) g = (g + delta) & 0xFFFF;
          }
          if (g) this.cmap.set(c, g);
        }
      }
    } else if (format === 12) {
      const nGroups = this.u32(sub + 12);
      for (let i = 0; i < nGroups; i += 1) {
        const p = sub + 16 + i * 12;
        const startChar = this.u32(p);
        const endChar = this.u32(p + 4);
        const startGlyph = this.u32(p + 8);
        for (let c = startChar; c <= endChar; c += 1) this.cmap.set(c, startGlyph + (c - startChar));
      }
    }
  }

  glyphFor(codePoint) { return this.cmap.get(codePoint) ?? 0; }

  /** Advance width in 1/1000 em, the unit a PDF font expects. */
  widthOf(glyphId) {
    return Math.round((this.advanceWidths[glyphId] || 0) * 1000 / this.unitsPerEm);
  }

  /** Map a string to glyph ids and the total advance in 1/1000 em. */
  encode(text) {
    const glyphs = [];
    let width = 0;
    for (const ch of String(text)) {
      const g = this.glyphFor(ch.codePointAt(0));
      glyphs.push(g);
      width += this.widthOf(g);
    }
    return { glyphs, width };
  }

  /** Text width in points at a given size. */
  measure(text, size) {
    return (this.encode(text).width / 1000) * size;
  }

  descriptor() {
    const s = 1000 / this.unitsPerEm;
    return {
      fontName: this.postScriptName,
      flags: 4 | (this.italicAngle ? 64 : 32),
      bbox: [Math.round(this.xMin * s), Math.round(this.yMin * s), Math.round(this.xMax * s), Math.round(this.yMax * s)],
      italicAngle: this.italicAngle,
      ascent: Math.round(this.ascender * s),
      descent: Math.round(this.descender * s),
      capHeight: Math.round(this.sCapHeight * s),
      stemV: Math.max(50, Math.round((this.usWeightClass || 400) / 8)),
    };
  }
}
