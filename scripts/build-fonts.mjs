/**
 * Regenerates src/render/fonts/index.js from the .ttf files beside it.
 * Run after replacing a typeface (for example if the group licenses a
 * commercial grotesque and Archivo becomes the fallback — brand §8.1).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'render', 'fonts');
const files = {
  sans400: 'Archivo-400-normal.ttf', sans500: 'Archivo-500-normal.ttf',
  sans600: 'Archivo-600-normal.ttf', sans700: 'Archivo-700-normal.ttf',
  serif300: 'Newsreader-300-normal.ttf', serif400: 'Newsreader-400-normal.ttf',
};

let out = `/**
 * Brand typefaces, embedded as base64 so the PDF renderer works identically in
 * Node and inside a Cloudflare Worker, where there is no filesystem.
 *
 * Archivo and Newsreader are the two families named in brand-guidelines.html §8.1.
 * Both are SIL Open Font License 1.1, so redistribution inside a generated PDF
 * is permitted. Regenerate with: node scripts/build-fonts.mjs
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

/** @returns {{sans400,sans500,sans600,sans700,serif300,serif400}} Uint8Array per weight */
export function brandFonts() {
  if (cache) return cache;
  cache = Object.fromEntries(Object.entries(B64).map(([k, v]) => [k, decode(v)]));
  return cache;
}

export const FONT_LICENCE = 'Archivo and Newsreader — SIL Open Font License 1.1';
`;
await writeFile(path.join(dir, 'index.js'), out);
console.log(`wrote ${path.join(dir, 'index.js')} (${out.length} bytes)`);
