/**
 * XP Asset Management — design tokens.
 * Extracted from the XP Advisory brand system (brand-guidelines.html): §02 marks,
 * §03 colour, §04 typography, §05 layout, §06 components, §08 tables, §09 charts,
 * §10 CSS tokens. This file is the single machine-readable source of truth for
 * every surface: advisor portal, client portal, HTML email, PDF letter and charts.
 *
 * Rules encoded here that the renderers must respect:
 *  §03  the palette is near-monochrome: warm greys, slate #2A3B43 as the structural
 *       colour and copper as the only accent; green and red appear only with meaning
 *  §03  positive #548235 / negative #A62900 in tables — and always with the sign,
 *       never colour alone
 *  §04  Roboto Light is the body weight; Bold only on short labels; tracked capitals
 *       (.3em) for headers, footers and kickers; sentence-case display titles in a
 *       thin grotesque, never tracked
 *  §08  no black borders in tables — structure comes from background bands and
 *       hairlines in white or grey
 *  §09  series 1 is slate, series 2 sage, series 3 grey, comparisons dashed;
 *       bars are slate, negative bars #A62900; never more than three solid lines
 *  §11  copper is an accent: a footer, a short title, one chart line — never a
 *       large area, except the triangle on a cover
 */

export const color = {
  paper: '#FFFFFF', paper2: '#FFFFFF', paper3: '#F2F2F2',
  /** the warm grey axis, darkest first (§03 núcleo and neutros) */
  ink: {
    50: '#E9E9E9', 100: '#D9D9D9', 150: '#C8C8C8', 200: '#BFBFBF',
    300: '#A6A6A6', 400: '#989898', 500: '#7F7F7F', 600: '#595959',
    700: '#45484A', 800: '#3B3838', 900: '#242424', 950: '#222222',
  },
  /** slate — panels, data titles, the main chart series (§03) */
  slate: {
    50: '#EEF1F2', 100: '#D4DBDE', 200: '#B9C6CC', 300: '#93A5AD', 400: '#6E8590',
    500: '#4C6470', 600: '#2A3B43', 700: '#223038', 800: '#1A262C', 900: '#121A1F',
  },
  /** copper — the accent (§03) */
  copper: {
    50: '#FBF3EF', 100: '#F3E0D6', 200: '#E8C6B5', 300: '#D9A68D', 400: '#C57D5C',
    500: '#BB795E', 600: '#A0644B', 700: '#654339',
    hairline: '#B9795E', saturated: '#C55A11', gradientLight: '#CF7A5B', gradientDark: '#654339',
  },
  olive: '#828D6F', sage: '#A1A894', charcoal: '#45484A',
  headerText: '#DDDDDD', coverBlack: '#1F1F1F', bar: '#242424',
  /** positive (§03 semânticas): #548235 in tables, #3C7D22 emphasised, #385723 overweight */
  yield: {
    25: '#F6F9F3', 50: '#EDF3E6', 100: '#DCE8CF', 150: '#C9DCB6',
    200: '#B3CE9B', 300: '#8FB46F', 400: '#6E9A4B', 500: '#548235',
    600: '#3C7D22', 700: '#385723', 800: '#2C4519', 900: '#213412', 950: '#14200B',
  },
  /** negative (§03 semânticas): #A62900 in tables */
  drawdown: {
    25: '#FBF4F1', 50: '#F7E8E2', 100: '#EFD2C7', 150: '#E7BCAA',
    200: '#DDA48D', 300: '#D46A46', 400: '#BE4A1E', 500: '#A62900',
    600: '#8E2300', 700: '#741C00', 800: '#5A1600', 900: '#421000', 950: '#2A0A00',
  },
  /** the allocation view's own semantics (§07) */
  position: {
    underweight: '#B50303', underweightSub: '#C63636',
    overweight: '#385723', overweightSub: '#607750',
    neutral: '#7F7F7F', neutralSub: '#9F9F9F',
    up: '#385723', down: '#C00000', unchanged: '#7F7F7F',
  },
  /** §09 chart series, in order */
  series: ['#2A3B43', '#A1A894', '#7F7F7F', '#595959'],
  /**
   * §08 the pie: cash charcoal, fixed income copper, equity grey, alternatives pale.
   * Extended to eight classes with the remaining brand colours; the order is
   * fixed so the reader learns it across documents.
   */
  categorical: ['#45484A', '#C57D5C', '#2A3B43', '#A1A894', '#654339', '#BFBFBF', '#828D6F', '#7F7F7F'],
  cvdSafe: { gain: '#2A3B43', loss: '#A62900' },
  rule: '#D9D9D9', rule2: '#E9E9E9', rule3: '#C8C8C8',
  grid: '#D9D9D9', axis: '#BFBFBF', band: '#F2F2F2',
};

/** Reference these, never the raw scale steps. */
export const semantic = {
  light: {
    gainText: color.yield[500], gainGraphic: color.slate[600],
    gainFill: color.yield[100], gainWash: color.yield[25],
    lossText: color.drawdown[500], lossGraphic: color.drawdown[500],
    lossFill: color.drawdown[100], lossWash: color.drawdown[25],
    flat: color.ink[500], benchmark: color.copper[500],
    caution: color.copper.saturated, cautionWash: '#FBF1EA',
    structure: color.slate[600], accent: color.copper[500], accent2: color.copper[400],
  },
  dark: {
    gainText: color.yield[300], gainGraphic: color.slate[200],
    gainFill: color.yield[900], gainWash: color.yield[950],
    lossText: color.drawdown[300], lossGraphic: color.drawdown[400],
    lossFill: color.drawdown[900], lossWash: color.drawdown[950],
    flat: color.ink[500], benchmark: color.copper[300],
    caution: '#E28A54', cautionWash: 'rgba(197,90,17,.16)',
    structure: color.slate[200], accent: '#C98A6E', accent2: color.copper[300],
  },
};

export const type = {
  sans: "'Roboto','Helvetica Neue',Arial,sans-serif",
  display: "'Hanken Grotesk','Neue Haas Grotesk Display','Roboto','Helvetica Neue',Arial,sans-serif",
  mono: "'Roboto Mono',ui-monospace,'SF Mono',Menlo,monospace",
  /** §04 — body weight is Light, not Regular */
  bodyWeight: 300,
  /** tracked capitals for headers, footers, kickers (§04 regras de composição) */
  track: '.3em',
  /** size / line-height */
  scale: {
    display: [56, 1.05], title: [38, 1.08], section: [24, 1.15], heading: [20, 1.2],
    subhead: [14.5, 1.3], body: [14, 1.55], reading: [15.5, 1.8],
    data: [13, 1.4], caption: [12, 1.4], disclosure: [11.5, 1.5],
  },
};

/** 4pt base, 8pt rhythm. */
export const space = [4, 8, 12, 16, 24, 32, 48, 64, 96, 128];
/** §05 — data flat; controls 3px; pills full; photos and panels one rounded corner */
export const radius = { data: 0, control: 3, pill: 999, photo: 48, panel: 62.7 };
export const motion = { state: 120, reveal: 200, page: 320, ease: 'cubic-bezier(.2,0,0,1)' };

export const brandRules = {
  copperIsAccentOnly: true,
  trackedCapsFor: ['header', 'footer', 'kicker', 'disclaimer-title'],
  displayNeverTracked: true,
  noBlackTableBorders: true,
  colourNeverSoleSignal: true,
  photosMonochromeOnOpenings: true,
  oneRoundedCornerOnPhotos: true,
  maxSolidLinesPerChart: 3,
  localeInvertsDirection: ['zh-CN', 'zh-TW', 'ja-JP', 'ko-KR'],
  minusSign: '−',
  disclosureMinPt: 7,
};

/** Text colour that reads on a given fill — dark ink on the pale brand fills, paper on the rest. */
export function inkOn(hex) {
  const v = String(hex || '').replace('#', '');
  if (v.length < 6) return '#FFFFFF';
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.36 ? color.ink[950] : '#FFFFFF';
}

/**
 * §02 the XP symbol — a rounded square with the letters x and p knocked out,
 * the stem of the p cutting the lower-right corner. Vectorised from the cover
 * mask (icons/xp-logo-square.svg); never redrawn, always this path, filled with
 * the even-odd rule so the letters stay open. Monochrome only: white on dark,
 * black on white.
 */
export const LOGO_SYMBOL_VIEWBOX = '6 0 266.33 238.67';
/** width over height of the symbol's box */
export const LOGO_SYMBOL_ASPECT = 266.33 / 238.67;
export const LOGO_SYMBOL_PATH = 'M31.33 0.19c-0.12 0.34 -0.91 0.58 -2.76 0.81c-1.20 0.16 -1.98 0.33 -2.31 0.50c-0.29 0.15 -0.93 0.35 -1.43 0.45c-0.49 0.10 -1.20 0.34 -1.58 0.54c-0.38 0.19 -1.00 0.44 -1.39 0.55c-0.38 0.11 -0.80 0.31 -0.91 0.45c-0.12 0.14 -0.50 0.35 -0.84 0.45c-0.35 0.11 -0.79 0.35 -1.00 0.53c-0.20 0.18 -0.59 0.44 -0.85 0.59c-0.28 0.14 -0.73 0.43 -1.01 0.64c-0.68 0.49 -2.88 2.38 -3.16 2.73c-0.43 0.51 -1.15 1.35 -1.43 1.66c-0.16 0.18 -0.48 0.61 -0.71 0.98c-0.24 0.38 -0.50 0.71 -0.58 0.76c-0.08 0.05 -0.25 0.35 -0.39 0.65c-0.14 0.31 -0.38 0.74 -0.55 0.94c-0.16 0.20 -0.36 0.56 -0.43 0.80c-0.06 0.24 -0.29 0.70 -0.49 1.03c-0.20 0.33 -0.44 0.86 -0.51 1.21c-0.09 0.34 -0.30 0.89 -0.48 1.20c-0.16 0.31 -0.44 1.16 -0.60 1.88c-0.15 0.71 -0.40 1.61 -0.54 1.99c-0.14 0.38 -0.31 1.34 -0.40 2.12c-0.08 0.79 -0.26 2.27 -0.41 3.31l-0.28 1.88l0.00 90.25l0.00 90.25l0.28 1.88c0.15 1.03 0.34 2.53 0.41 3.31c0.09 0.79 0.26 1.75 0.40 2.12c0.14 0.38 0.38 1.28 0.54 1.99c0.16 0.71 0.43 1.56 0.60 1.88c0.18 0.31 0.38 0.88 0.46 1.23c0.08 0.36 0.31 0.90 0.51 1.19c0.20 0.30 0.43 0.76 0.50 1.04c0.08 0.28 0.26 0.64 0.43 0.81c0.16 0.18 0.40 0.56 0.54 0.88c0.14 0.31 0.38 0.74 0.55 0.94c0.18 0.21 0.41 0.56 0.53 0.78c0.11 0.23 0.34 0.50 0.51 0.61c0.16 0.11 0.34 0.29 0.38 0.40c0.10 0.35 2.99 3.19 3.64 3.60c0.20 0.11 0.54 0.38 0.74 0.56c0.21 0.20 0.58 0.44 0.83 0.54c0.24 0.10 0.53 0.29 0.62 0.40c0.10 0.11 0.46 0.34 0.81 0.50c0.35 0.15 0.85 0.43 1.11 0.60c0.26 0.18 0.70 0.39 0.99 0.46c0.28 0.08 0.80 0.29 1.14 0.49c0.35 0.19 1.05 0.44 1.58 0.55c0.51 0.11 1.05 0.29 1.19 0.38c0.39 0.26 1.04 0.44 2.24 0.58c1.45 0.18 2.02 0.35 2.31 0.71l0.23 0.29l71.76 -0.00l71.76 -0.00l0.00 -3.48c0.01 -1.90 0.06 -4.70 0.12 -6.21c0.10 -2.34 0.16 -2.94 0.44 -4.00c0.19 -0.69 0.44 -1.74 0.56 -2.35c0.12 -0.60 0.34 -1.28 0.48 -1.50c0.14 -0.21 0.35 -0.73 0.46 -1.11c0.11 -0.39 0.34 -0.91 0.51 -1.16c0.16 -0.25 0.44 -0.73 0.60 -1.05c0.18 -0.33 0.40 -0.66 0.51 -0.76c0.11 -0.09 0.31 -0.38 0.44 -0.61c0.31 -0.62 2.88 -3.19 3.70 -3.71c0.20 -0.12 0.60 -0.41 0.89 -0.64c0.30 -0.21 0.66 -0.44 0.81 -0.48c0.16 -0.05 0.49 -0.24 0.73 -0.41c0.24 -0.18 0.69 -0.41 1.00 -0.53c0.66 -0.23 2.09 -1.11 2.19 -1.36c0.21 -0.54 0.78 -0.53 -19.89 -0.55c-21.11 -0.03 -19.88 0.01 -20.78 -0.69c-0.69 -0.54 -6.44 -6.34 -7.91 -7.99c-0.12 -0.12 -0.35 -0.35 -0.50 -0.50c-0.16 -0.15 -1.20 -1.20 -2.30 -2.34c-1.10 -1.15 -2.91 -3.01 -4.03 -4.15c-1.12 -1.14 -2.04 -2.10 -2.04 -2.16c0.00 -0.05 -0.15 -0.18 -0.33 -0.26c-0.18 -0.10 -0.40 -0.33 -0.49 -0.50c-0.09 -0.18 -0.31 -0.40 -0.49 -0.50c-0.19 -0.09 -0.44 -0.35 -0.58 -0.56c-0.14 -0.21 -0.39 -0.46 -0.55 -0.56c-0.18 -0.09 -0.35 -0.26 -0.39 -0.39c-0.08 -0.20 -1.38 -1.36 -1.55 -1.36c-0.09 -0.00 -0.26 0.18 -5.89 5.88c-7.94 8.04 -15.08 15.19 -15.55 15.55c-0.41 0.33 -0.61 0.38 -1.75 0.48c-0.71 0.06 -8.18 0.09 -16.59 0.08c-12.19 -0.03 -15.36 -0.08 -15.58 -0.20c-0.20 -0.11 -0.29 -0.28 -0.29 -0.54c0.00 -0.40 0.34 -1.24 0.49 -1.24c0.05 -0.00 1.00 -0.89 2.11 -1.96c1.11 -1.09 2.15 -2.10 2.30 -2.24c0.16 -0.15 0.40 -0.39 0.54 -0.54c0.59 -0.61 7.21 -7.04 8.06 -7.83c0.75 -0.68 6.00 -5.76 9.39 -9.06c0.33 -0.31 2.20 -2.14 4.17 -4.06c4.05 -3.94 6.60 -6.43 9.85 -9.60c1.48 -1.44 2.21 -2.25 2.21 -2.43c0.00 -0.28 -0.89 -1.21 -3.84 -4.04c-0.90 -0.86 -2.54 -2.44 -3.65 -3.50c-1.11 -1.06 -2.71 -2.61 -3.56 -3.44c-0.85 -0.83 -2.45 -2.38 -3.56 -3.44c-1.11 -1.06 -2.71 -2.61 -3.55 -3.44c-0.85 -0.83 -2.49 -2.40 -3.65 -3.51c-6.11 -5.79 -8.72 -8.31 -13.96 -13.40c-0.16 -0.15 -0.34 -0.33 -0.41 -0.40c-1.79 -1.69 -3.69 -3.66 -3.69 -3.83c0.00 -0.33 0.83 -1.03 1.38 -1.18c0.35 -0.09 5.36 -0.12 16.09 -0.10l15.60 0.04l1.03 0.50c1.00 0.49 1.15 0.64 11.83 11.24c5.95 5.90 10.90 10.79 11.03 10.85c0.30 0.18 0.74 0.03 0.93 -0.31c0.09 -0.16 0.33 -0.39 0.53 -0.51c0.20 -0.11 0.36 -0.28 0.36 -0.34c0.00 -0.08 0.48 -0.62 1.05 -1.21c0.59 -0.60 1.21 -1.26 1.41 -1.46c0.19 -0.21 0.99 -1.07 1.78 -1.94c1.51 -1.65 4.58 -4.91 5.51 -5.88c0.31 -0.31 1.19 -1.24 1.94 -2.06c0.76 -0.81 1.83 -1.95 2.38 -2.51c0.55 -0.58 1.65 -1.73 2.44 -2.56c2.45 -2.61 2.69 -2.84 3.25 -3.11c0.31 -0.14 0.74 -0.36 0.94 -0.48c0.35 -0.20 2.94 -0.21 40.38 -0.25c40.75 -0.05 43.15 -0.03 46.53 0.43c0.76 0.10 2.43 0.26 3.69 0.38c2.30 0.19 2.70 0.25 3.98 0.68c0.38 0.12 1.19 0.29 1.81 0.38c0.69 0.09 1.44 0.29 1.94 0.50c0.45 0.19 1.15 0.41 1.55 0.49c0.41 0.08 1.09 0.30 1.50 0.50c0.43 0.20 1.01 0.44 1.33 0.51c0.31 0.09 0.88 0.31 1.25 0.51c0.38 0.20 1.00 0.50 1.38 0.68c1.04 0.49 2.25 1.15 2.49 1.35c0.11 0.10 0.49 0.33 0.84 0.50c0.34 0.18 0.70 0.40 0.79 0.51c0.09 0.10 0.41 0.34 0.71 0.51c0.30 0.18 0.55 0.36 0.55 0.41c0.00 0.05 0.18 0.20 0.39 0.33c0.75 0.44 3.62 3.11 4.39 4.08c0.20 0.24 0.61 0.75 0.91 1.12c0.31 0.38 0.76 0.98 1.00 1.34c0.24 0.35 0.49 0.69 0.56 0.73c0.08 0.05 0.30 0.41 0.50 0.81c0.20 0.40 0.43 0.78 0.51 0.81c0.08 0.05 0.31 0.50 0.55 1.00c0.23 0.50 0.46 0.94 0.54 0.99c0.08 0.04 0.23 0.38 0.35 0.74c0.11 0.35 0.34 0.85 0.50 1.09c0.16 0.24 0.40 0.85 0.53 1.35c0.14 0.50 0.34 1.01 0.46 1.15c0.28 0.30 0.79 0.43 1.01 0.24c0.15 -0.12 0.18 -8.81 0.12 -61.41c-0.03 -33.69 -0.08 -61.51 -0.10 -61.83c-0.50 -5.04 -0.71 -6.59 -0.99 -7.38c-0.14 -0.38 -0.36 -1.24 -0.49 -1.90c-0.12 -0.68 -0.38 -1.46 -0.54 -1.75c-0.18 -0.30 -0.38 -0.80 -0.45 -1.14c-0.08 -0.33 -0.34 -0.96 -0.58 -1.41c-0.24 -0.45 -0.44 -0.89 -0.44 -0.98c0.00 -0.09 -0.15 -0.39 -0.34 -0.65c-0.18 -0.26 -0.49 -0.81 -0.69 -1.21c-0.19 -0.39 -0.40 -0.71 -0.45 -0.71c-0.06 -0.00 -0.24 -0.24 -0.40 -0.54c-0.28 -0.50 -0.49 -0.76 -1.66 -2.14c-1.23 -1.45 -3.40 -3.31 -4.89 -4.20c-0.29 -0.18 -0.69 -0.44 -0.88 -0.59c-0.19 -0.15 -0.61 -0.36 -0.94 -0.48c-0.34 -0.11 -0.71 -0.31 -0.84 -0.45c-0.11 -0.14 -0.54 -0.34 -0.91 -0.44c-0.39 -0.11 -0.98 -0.36 -1.33 -0.55c-0.34 -0.19 -1.07 -0.44 -1.62 -0.55c-0.54 -0.11 -1.11 -0.29 -1.25 -0.38c-0.40 -0.26 -1.11 -0.43 -2.50 -0.58c-1.59 -0.18 -2.66 -0.46 -2.83 -0.76c-0.11 -0.23 -3.01 -0.24 -107.60 -0.24c-96.83 -0.00 -107.49 0.03 -107.56 0.19ZM172.90 139.60c-0.23 0.19 -1.10 1.01 -1.95 1.84c-2.09 2.02 -5.39 5.20 -7.50 7.21c-0.96 0.91 -2.65 2.54 -3.76 3.60c-1.10 1.06 -2.93 2.81 -4.05 3.88c-1.11 1.06 -2.73 2.61 -3.56 3.44c-0.85 0.83 -2.45 2.38 -3.56 3.44c-3.86 3.69 -5.39 5.25 -5.39 5.50c0.00 0.12 0.12 0.33 0.29 0.43c0.28 0.19 2.76 2.58 5.78 5.51c0.84 0.83 2.48 2.40 3.64 3.50c4.24 4.01 9.38 8.96 15.16 14.56c0.81 0.79 2.01 1.95 2.68 2.58c0.65 0.64 1.29 1.29 1.40 1.46c0.11 0.19 0.34 0.36 0.48 0.41c0.15 0.05 0.44 0.20 0.62 0.34c0.28 0.19 0.39 0.21 0.50 0.10c0.11 -0.11 0.16 -7.10 0.19 -28.86c0.01 -15.79 0.00 -28.84 -0.04 -29.00c-0.09 -0.36 -0.41 -0.35 -0.91 0.08ZM199.88 152.95c-0.24 0.10 -0.48 0.25 -0.53 0.34c-0.12 0.19 -0.12 30.10 0.00 30.29c0.29 0.44 0.38 0.44 17.06 0.43c9.98 -0.00 16.84 -0.05 17.51 -0.12c0.60 -0.08 1.41 -0.24 1.80 -0.38c0.39 -0.12 1.23 -0.35 1.84 -0.49c0.62 -0.12 1.45 -0.41 1.86 -0.62c0.40 -0.21 0.83 -0.39 0.95 -0.39c0.12 -0.00 0.50 -0.19 0.83 -0.41c0.34 -0.23 0.78 -0.48 0.99 -0.58c0.50 -0.21 1.10 -0.73 2.51 -2.12c0.65 -0.65 1.29 -1.38 1.43 -1.64c0.12 -0.25 0.31 -0.53 0.43 -0.61c0.10 -0.09 0.31 -0.48 0.45 -0.86c0.15 -0.38 0.38 -0.85 0.51 -1.05c0.14 -0.19 0.34 -0.79 0.44 -1.31c0.10 -0.54 0.29 -1.40 0.43 -1.93c0.33 -1.23 0.36 -4.94 0.06 -5.91c-0.10 -0.34 -0.28 -1.12 -0.39 -1.75c-0.12 -0.73 -0.33 -1.36 -0.55 -1.76c-0.19 -0.35 -0.41 -0.84 -0.50 -1.09c-0.08 -0.26 -0.34 -0.70 -0.58 -0.99c-0.24 -0.28 -0.43 -0.56 -0.43 -0.62c0.00 -0.05 -0.38 -0.54 -0.83 -1.05c-0.79 -0.90 -1.69 -1.69 -2.60 -2.25c-0.23 -0.14 -0.56 -0.38 -0.75 -0.53c-0.19 -0.15 -0.66 -0.40 -1.04 -0.54c-0.39 -0.15 -0.86 -0.38 -1.05 -0.51c-0.19 -0.14 -0.73 -0.33 -1.20 -0.44c-0.46 -0.10 -1.19 -0.33 -1.60 -0.49c-1.90 -0.73 -4.19 -0.81 -21.62 -0.81c-13.06 0.01 -15.05 0.04 -15.44 0.20ZM270.68 184.61c-0.39 0.24 -0.56 0.59 -0.74 1.51c-0.05 0.24 -0.23 0.68 -0.40 0.98c-0.16 0.30 -0.41 0.84 -0.54 1.21c-0.12 0.38 -0.38 0.88 -0.54 1.09c-0.16 0.23 -0.38 0.61 -0.46 0.85c-0.09 0.24 -0.29 0.58 -0.44 0.75c-0.16 0.18 -0.44 0.64 -0.62 1.03c-0.18 0.40 -0.38 0.73 -0.44 0.73c-0.05 -0.00 -0.28 0.26 -0.49 0.59c-1.41 2.16 -3.38 4.29 -5.76 6.23c-0.38 0.30 -0.89 0.71 -1.12 0.91c-0.24 0.20 -0.68 0.49 -0.96 0.64c-0.29 0.14 -0.56 0.31 -0.60 0.39c-0.05 0.08 -0.40 0.29 -0.80 0.49c-0.39 0.20 -0.79 0.45 -0.88 0.56c-0.09 0.10 -0.48 0.31 -0.85 0.45c-0.39 0.14 -0.84 0.36 -1.00 0.50c-0.16 0.12 -0.60 0.33 -0.95 0.45c-0.36 0.11 -0.93 0.36 -1.28 0.55c-0.34 0.19 -1.01 0.44 -1.50 0.55c-0.48 0.12 -1.05 0.33 -1.26 0.46c-0.21 0.12 -1.03 0.38 -1.81 0.54c-0.79 0.16 -1.74 0.41 -2.11 0.55c-0.38 0.15 -1.31 0.33 -2.06 0.40c-0.76 0.08 -1.83 0.25 -2.38 0.38c-2.86 0.66 -5.94 0.75 -24.99 0.75c-14.08 -0.01 -15.50 0.01 -15.79 0.19c-0.69 0.45 -0.66 -0.12 -0.66 15.38l0.00 14.31l24.18 -0.00c23.61 -0.00 24.19 -0.00 24.26 -0.24c0.10 -0.35 0.59 -0.50 2.33 -0.75c1.00 -0.15 1.80 -0.34 2.24 -0.54c0.39 -0.18 1.03 -0.39 1.44 -0.48c0.41 -0.09 1.04 -0.31 1.38 -0.50c0.35 -0.20 0.88 -0.43 1.19 -0.50c0.31 -0.09 0.74 -0.28 0.95 -0.45c0.23 -0.16 0.70 -0.44 1.06 -0.61c0.38 -0.18 0.88 -0.45 1.11 -0.61c0.24 -0.18 0.80 -0.55 1.24 -0.85c0.44 -0.30 1.01 -0.74 1.29 -0.98c1.00 -0.89 2.76 -2.70 3.12 -3.23c0.20 -0.29 0.40 -0.53 0.45 -0.53c0.05 -0.00 0.31 -0.35 0.56 -0.79c0.26 -0.43 0.60 -0.95 0.75 -1.18c0.61 -0.90 1.00 -1.59 1.23 -2.18c0.14 -0.34 0.38 -0.83 0.55 -1.09c0.16 -0.25 0.36 -0.75 0.44 -1.09c0.08 -0.35 0.30 -0.96 0.50 -1.38c0.20 -0.41 0.43 -1.18 0.51 -1.69c0.08 -0.51 0.25 -1.20 0.38 -1.53c0.29 -0.73 0.58 -2.33 0.68 -3.79c0.05 -0.62 0.18 -1.75 0.29 -2.50c0.16 -1.15 0.20 -3.35 0.24 -13.60c0.04 -9.26 0.01 -12.28 -0.10 -12.41c-0.19 -0.24 -0.35 -0.23 -0.81 0.06Z';

/**
 * Inline SVG of the lockup: the symbol and the words set in the display
 * grotesque, Regular, lowercase, aligned on the symbol's base — the way the
 * brand composes "xp advisory" (§02 lockups). `variant`: 'ink' | 'paper'.
 */
export function logoSvg({ variant = 'ink', height = 28, withWord = true } = {}) {
  const fg = variant === 'ink' ? '#000000' : '#FFFFFF';
  const h = height;
  const w = h * LOGO_SYMBOL_ASPECT;
  const wordSize = h * 0.78;
  return `<span class="lockup" style="display:inline-flex;align-items:flex-end;gap:${(h * 0.22).toFixed(1)}px;line-height:1">
<svg viewBox="${LOGO_SYMBOL_VIEWBOX}" width="${w.toFixed(1)}" height="${h}" role="img" aria-label="XP Asset Management" fill="${fg}" fill-rule="evenodd"><path d="${LOGO_SYMBOL_PATH}"/></svg>
${withWord ? `<span style="font-family:${type.display};font-weight:400;font-size:${wordSize.toFixed(1)}px;letter-spacing:-.005em;color:${fg};padding-bottom:${(h * 0.06).toFixed(1)}px;white-space:nowrap">asset management</span>` : ''}
</span>`;
}

/** Full CSS custom-property block, emitted into every HTML surface. */
export function cssVariables() {
  const lines = [];
  lines.push(`--paper:${color.paper};--paper-2:${color.paper2};--paper-3:${color.paper3};`);
  for (const [k, v] of Object.entries(color.ink)) lines.push(`--ink-${k}:${v};`);
  for (const [k, v] of Object.entries(color.slate)) lines.push(`--b-${k}:${v};`);
  for (const [k, v] of Object.entries(color.yield)) lines.push(`--g-${k}:${v};`);
  for (const [k, v] of Object.entries(color.drawdown)) lines.push(`--r-${k}:${v};`);
  for (const [k, v] of Object.entries(color.copper)) if (/^\d+$/.test(k)) lines.push(`--copper-${k}:${v};`);
  lines.push(`--olive:${color.olive};--sage:${color.sage};--charcoal:${color.charcoal};--header-text:${color.headerText};`);
  color.categorical.forEach((c, i) => lines.push(`--cat-${i + 1}:${c};`));
  const L = semantic.light;
  lines.push(
    `--gain-text:${L.gainText};--gain-graphic:${L.gainGraphic};--gain-fill:${L.gainFill};--gain-wash:${L.gainWash};`,
    `--loss-text:${L.lossText};--loss-graphic:${L.lossGraphic};--loss-fill:${L.lossFill};--loss-wash:${L.lossWash};`,
    `--flat:${L.flat};--benchmark:${L.benchmark};--caution:${L.caution};--caution-wash:${L.cautionWash};--structure:${L.structure};--accent:${L.accent};--accent-2:${L.accent2};`,
    `--rule:${color.rule};--rule-2:${color.rule2};--rule-3:${color.rule3};`,
    `--sans:${type.sans};--display:${type.display};--mono:${type.mono};--track:${type.track};`,
    `--s-1:4px;--s-2:8px;--s-3:12px;--s-4:16px;--s-5:24px;--s-6:32px;--s-7:48px;--s-8:64px;--s-9:96px;--s-10:128px;`,
    `--radius-data:0;--radius-control:3px;--radius-pill:999px;--radius-photo:48px;--ease:${motion.ease};`
  );
  return lines.join('');
}
