/**
 * A ZIP archive, written by hand.
 *
 * The bulk letter run has to hand the advisor one file, and the Worker runtime
 * has no archiver of its own. The format needed here is the oldest and smallest
 * part of the specification: a local header and a central-directory entry per
 * file, then the end-of-central-directory record.
 *
 * Every entry is stored, not deflated. A PDF's own content streams are already
 * Flate-compressed, so a second pass over the same bytes buys a percent or two
 * and costs a full compression of every letter; the reader does not care which
 * method was used. Nothing here spills to disk, so the caller is responsible
 * for keeping the set of files to a size that fits in the Worker's memory —
 * one advisor's book of two-page letters, not an archive of everything.
 *
 * Names are written with the UTF-8 flag set, so an accented client name
 * survives the trip into Windows Explorer as well as into unzip(1).
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS packed date and time, the only timestamp the base format carries. */
function dosStamp(when) {
  const d = when instanceof Date && !Number.isNaN(when.getTime()) ? when : new Date();
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/**
 * `files` is `[{ name, data }]`, data being bytes. Returns the whole archive as
 * a Uint8Array, entries in the order given.
 */
export function buildZip(files, { modified = new Date() } = {}) {
  const encoder = new TextEncoder();
  const stamp = dosStamp(modified);
  const local = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    const crc = crc32(data);

    const header = new Uint8Array(30 + name.length);
    const h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true);   // local file header
    h.setUint16(4, 20, true);           // version needed to extract: 2.0
    h.setUint16(6, 0x0800, true);       // general purpose flags: the name is UTF-8
    h.setUint16(8, 0, true);            // method 0: stored
    h.setUint16(10, stamp.time, true);
    h.setUint16(12, stamp.date, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true); // compressed size == uncompressed size
    h.setUint32(22, data.length, true);
    h.setUint16(26, name.length, true);
    h.setUint16(28, 0, true);           // no extra field
    header.set(name, 30);

    const entry = new Uint8Array(46 + name.length);
    const c = new DataView(entry.buffer);
    c.setUint32(0, 0x02014b50, true);   // central directory entry
    c.setUint16(4, 20, true);           // version made by
    c.setUint16(6, 20, true);           // version needed
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, stamp.time, true);
    c.setUint16(14, stamp.date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true);
    // extra length, comment length, disk number, internal attributes: all zero
    c.setUint32(38, 0, true);           // external attributes
    c.setUint32(42, offset, true);      // where this entry's local header sits
    entry.set(name, 46);

    local.push(header, data);
    central.push(entry);
    offset += header.length + data.length;
  }

  const directoryBytes = central.reduce((a, b) => a + b.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);     // end of central directory
  e.setUint16(8, files.length, true);   // entries on this disk
  e.setUint16(10, files.length, true);  // entries in total
  e.setUint32(12, directoryBytes, true);
  e.setUint32(16, offset, true);        // where the central directory starts

  const out = new Uint8Array(offset + directoryBytes + 22);
  let at = 0;
  for (const part of [...local, ...central, end]) { out.set(part, at); at += part.length; }
  return out;
}

/** A file name that survives every filesystem: unaccented, lowercase, hyphenated. */
export function zipSafeName(value, fallback = 'arquivo') {
  const slug = String(value ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}
