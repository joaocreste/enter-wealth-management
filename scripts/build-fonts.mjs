/**
 * Regenerates src/render/fonts/index.js from the .ttf files beside it.
 *
 * The brand typeface is Roboto (XP Advisory brand system §04): Light for the
 * body, Regular for labels, Medium for definitions and Bold for short titles.
 * The files are Latin subsets of Google Fonts' static instances, cut with
 * pyftsubset so the four weights add about 110 KB to the Worker rather than
 * half a megabyte. Run after replacing a typeface.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'render', 'fonts');
const files = {
  sans300: 'Roboto-300-normal.ttf', sans400: 'Roboto-400-normal.ttf',
  sans500: 'Roboto-500-normal.ttf', sans700: 'Roboto-700-normal.ttf',
};

let out = `/**
 * Brand typeface, embedded as base64 so the PDF renderer works identically in
 * Node and inside a Cloudflare Worker, where there is no filesystem.
 *
 * Roboto is the family named in the XP Advisory brand system (§04): Light 300
 * for the body, Regular 400 for labels, Medium 500 for definitions, Bold 700
 * for short titles. Apache License 2.0, so redistribution inside a generated
 * PDF is permitted. Regenerate with: node scripts/build-fonts.mjs
 */
`;
out += 'const B64 = {\n';
for (const [k, f] of Object.entries(files)) {
  const b = await readFile(path.join(dir, f));
  out += `  ${k}: ${JSON.stringify(b.toString('base64'))},\n`;
}
out += '};\n\n';
out += `function decode(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

let cache = null;

/** @returns {{sans300,sans400,sans500,sans700}} Uint8Array per weight */
export function brandFonts() {
  if (cache) return cache;
  cache = Object.fromEntries(Object.entries(B64).map(([k, v]) => [k, decode(v)]));
  return cache;
}

export const FONT_LICENCE = 'Roboto — Apache License 2.0';
`;
await writeFile(path.join(dir, 'index.js'), out);
console.log(`wrote ${path.join(dir, 'index.js')} (${out.length} bytes)`);
