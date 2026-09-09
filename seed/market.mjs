/**
 * World Overview configuration (§6, §7, §8).
 *
 * Indicators and thresholds are DATA. A desk adds "Bund 10Y above 3.20%" by
 * inserting a row, never by editing business logic. Everything here is loaded
 * into D1 at seed time and read back by the pipeline.
 */

/** The monitored indicator set. Each row names its provider chain.
 * `investable: false` marks a level that is not an asset — the VIX and a yield can be
 * watched but not held — so return-and-risk views leave it out with a reason. */
export const INDICATORS = [
  { key: 'sp500', label: 'S&P 500', group: 'Equities', yahoo_symbol: '^GSPC', unit: 'index', asset_classes: ['Equities Global'] },
  { key: 'nasdaq', label: 'Nasdaq Composite', group: 'Equities', yahoo_symbol: '^IXIC', unit: 'index', asset_classes: ['Equities Global'] },
  { key: 'ibovespa', label: 'Ibovespa', group: 'Equities', yahoo_symbol: '^BVSP', unit: 'index', asset_classes: ['Equities BR'] },
  { key: 'vix', label: 'VIX', group: 'Equities', yahoo_symbol: '^VIX', unit: 'index', investable: false, asset_classes: ['Equities Global', 'Equities BR'] },
  { key: 'us10y', label: 'US 10-year Treasury', group: 'Rates & Credit', yahoo_symbol: '^TNX', unit: '%', investable: false, asset_classes: ['Fixed Income', 'Equities Global'] },
  { key: 'hy_etf', label: 'US high yield (HYG)', group: 'Rates & Credit', yahoo_symbol: 'HYG', unit: 'price', asset_classes: ['Fixed Income'] },
  { key: 'ig_etf', label: 'US investment grade (LQD)', group: 'Rates & Credit', yahoo_symbol: 'LQD', unit: 'price', asset_classes: ['Fixed Income'] },
  { key: 'selic', label: 'Selic — Copom target', group: 'Rates & Credit', bcb_series: 'SELIC_TARGET', unit: '% a.a.', asset_classes: ['Fixed Income', 'Cash'] },
  { key: 'ipca', label: 'IPCA — monthly', group: 'Rates & Credit', bcb_series: 'IPCA_MONTHLY', unit: '% a.m.', asset_classes: ['Fixed Income'] },
  { key: 'usdbrl', label: 'USD / BRL', group: 'FX & Commodities', yahoo_symbol: 'USDBRL=X', unit: 'BRL', asset_classes: ['FX', 'Equities Global'] },
  { key: 'eurusd', label: 'EUR / USD', group: 'FX & Commodities', yahoo_symbol: 'EURUSD=X', unit: 'USD', asset_classes: ['FX'] },
  { key: 'dxy', label: 'Dollar index (DXY)', group: 'FX & Commodities', yahoo_symbol: 'DX-Y.NYB', unit: 'index', asset_classes: ['FX', 'Equities Global'] },
  { key: 'gold', label: 'Gold', group: 'FX & Commodities', yahoo_symbol: 'GC=F', unit: 'USD/oz', asset_classes: ['Commodities'] },
  { key: 'brent', label: 'Brent crude', group: 'FX & Commodities', yahoo_symbol: 'BZ=F', unit: 'USD/bbl', asset_classes: ['Commodities', 'Equities BR'] },
  { key: 'wti', label: 'WTI crude', group: 'FX & Commodities', yahoo_symbol: 'CL=F', unit: 'USD/bbl', asset_classes: ['Commodities', 'Equities BR'] },
  { key: 'copper', label: 'Copper', group: 'FX & Commodities', yahoo_symbol: 'HG=F', unit: 'USD/lb', asset_classes: ['Commodities', 'Equities BR'] },
  { key: 'btc', label: 'Bitcoin', group: 'Digital Assets', yahoo_symbol: 'BTC-USD', coingecko_id: 'bitcoin', unit: 'USD', asset_classes: ['Digital Assets'] },
  { key: 'eth', label: 'Ether', group: 'Digital Assets', yahoo_symbol: 'ETH-USD', coingecko_id: 'ethereum', unit: 'USD', asset_classes: ['Digital Assets'] },
];

/**
 * Configurable triggers (§7). `comparator` and `threshold` are stored values;
 * `persistence_days` distinguishes "VIX touched 30" from "VIX above 30 for a week".
 */
export const TRIGGERS = [
  { id: 'trg_brent_120', label: 'Brent above US$ 120/bbl', indicator_key: 'brent', comparator: 'gt', threshold: 120, unit: 'USD/bbl', asset_classes: ['Commodities', 'Equities BR', 'Fixed Income'], action: 'Review energy-sensitive holdings and the inflation path assumed in the fixed-income sleeve.' , action_pt: 'Revisar as posições sensíveis a energia e a premissa de inflação da renda fixa.' },
  { id: 'trg_brent_90', label: 'Brent above US$ 90/bbl', indicator_key: 'brent', comparator: 'gt', threshold: 90, unit: 'USD/bbl', asset_classes: ['Commodities', 'Equities BR'], action: 'Discuss the inflation pass-through to Brazilian consumer names and the effect on the local rates curve.' , action_pt: 'Discutir o repasse do petróleo à inflação, o efeito nas empresas de consumo e na curva de juros local.' },
  { id: 'trg_us10y_500', label: 'US 10-year above 5.00%', indicator_key: 'us10y', comparator: 'gt', threshold: 5.0, unit: '%', asset_classes: ['Fixed Income', 'Equities Global'], action: 'Reassess duration and the discount rate applied to long-duration global equity.' , action_pt: 'Reavaliar a duration da carteira e a taxa de desconto aplicada à renda variável global de duração longa.' },
  { id: 'trg_us10y_450', label: 'US 10-year above 4.50%', indicator_key: 'us10y', comparator: 'gt', threshold: 4.5, unit: '%', asset_classes: ['Fixed Income', 'Equities Global'], action: 'Confirm the portfolio duration is still inside the approved range.' , action_pt: 'Confirmar que a duration da carteira segue dentro da faixa aprovada.' },
  { id: 'trg_vix_30', label: 'VIX above 30 for five sessions', indicator_key: 'vix', comparator: 'gt', threshold: 30, unit: 'index', persistence_days: 5, asset_classes: ['Equities Global', 'Equities BR'], action: 'Sustained stress: review equity sizing before adding risk.' , action_pt: 'Estresse sustentado: revisar o tamanho da posição em renda variável antes de adicionar risco.' },
  { id: 'trg_dxy_105', label: 'Dollar index above 105', indicator_key: 'dxy', comparator: 'gt', threshold: 105, unit: 'index', asset_classes: ['FX', 'Equities Global'], action: 'A strong dollar is a headwind for emerging assets; review unhedged exposure.' , action_pt: 'Dólar forte é vento contrário para ativos emergentes; revisar a exposição sem hedge.' },
  { id: 'trg_dxy_92', label: 'Dollar index below 92', indicator_key: 'dxy', comparator: 'lt', threshold: 92, unit: 'index', asset_classes: ['FX', 'Equities Global'], action: 'A weak dollar supports emerging assets; review whether unhedged USD exposure is still earning its place.' , action_pt: 'Dólar fraco favorece ativos emergentes; avaliar se a exposição em dólar sem hedge segue justificada.' },
  { id: 'trg_usdbrl_600', label: 'USD/BRL above 6.00', indicator_key: 'usdbrl', comparator: 'gt', threshold: 6.0, unit: 'BRL', asset_classes: ['FX', 'Equities Global'], action: 'Translate the currency move into the client result before the meeting; unhedged offshore positions gain in reais.' , action_pt: 'Traduzir o movimento cambial para o resultado do cliente antes da reunião; posições no exterior sem hedge ganham em reais.' },
  { id: 'trg_usdbrl_500', label: 'USD/BRL above 5.00', indicator_key: 'usdbrl', comparator: 'gt', threshold: 5.0, unit: 'BRL', asset_classes: ['FX', 'Equities Global'], action: 'Explain the currency contribution explicitly in the monthly letter.' , action_pt: 'Explicar a contribuição do câmbio de forma explícita na carta mensal.' },
  { id: 'trg_gold_4000', label: 'Gold above US$ 4,000/oz', indicator_key: 'gold', comparator: 'gt', threshold: 4000, unit: 'USD/oz', asset_classes: ['Commodities'], action: 'Discuss whether the gold allocation remains inside the permitted range after the move.' , action_pt: 'Avaliar se a alocação em ouro segue dentro da faixa permitida após o movimento.' },
  { id: 'trg_ipca_060', label: 'IPCA monthly above 0.60%', indicator_key: 'ipca', comparator: 'gt', threshold: 0.60, unit: '% a.m.', asset_classes: ['Fixed Income'], action: 'Inflation surprise: review the balance between inflation-linked and CDI-linked holdings.' , action_pt: 'Surpresa inflacionária: revisar o equilíbrio entre renda fixa indexada ao IPCA e ao CDI.' },
  { id: 'trg_selic_1500', label: 'Selic at or above 15.00%', indicator_key: 'selic', comparator: 'gte', threshold: 15.0, unit: '% a.a.', asset_classes: ['Fixed Income', 'Cash', 'Equities BR'], action: 'At this level of carry, confirm the client understands the opportunity cost of equity risk.' , action_pt: 'Com esse nível de carrego, confirmar que o cliente entende o custo de oportunidade do risco em renda variável.' },
  { id: 'trg_hy_stress', label: 'US high-yield ETF down more than 4% in a month', indicator_key: 'hy_etf', comparator: 'lt', threshold: -0.04, unit: 'mtd', asset_classes: ['Fixed Income'], action: 'Credit stress: review private-credit fund exposure and redemption terms.' , action_pt: 'Estresse de crédito: revisar a exposição a fundos de crédito privado e as janelas de resgate.' },
  { id: 'trg_btc_100k', label: 'Bitcoin above US$ 100,000', indicator_key: 'btc', comparator: 'gt', threshold: 100000, unit: 'USD', asset_classes: ['Digital Assets'], action: 'Rebalance digital-asset sleeves back inside the permitted range where one exists.' , action_pt: 'Rebalancear a parcela em ativos digitais de volta para dentro da faixa permitida, onde ela existir.' },
];

/**
 * Curated macro / policy events. These are the statements a language model must
 * never invent: each one is verifiable against a named source, and the
 * indicator value attached to it is retrieved live rather than typed here.
 */
export const CURATED_EVENTS = [
  {
    id: 'evt_copom_aug2026',
    date: '2026-08-06',
    title: 'Copom cuts the Selic rate to 14.00%',
    category: 'macro',
    summary: 'The Banco Central do Brasil reduced the policy rate by 0.25 p.p. at its August meeting, the first cut of the cycle, with monthly IPCA running well below the 2025 pace.',
    direction: 'positive',
    indicator_key: 'selic',
    asset_classes: ['Fixed Income', 'Cash', 'Equities BR'],
    instruments: [],
    impact_note: 'A falling policy rate lowers the return on CDI-linked cash and shortens the advantage of holding liquidity, while supporting local duration and domestic equity.',
    discussion_prompt: 'Discuss whether the cash balance should be reduced now that the carry on it is falling, and whether inflation-linked duration should be extended.',
    importance: 'high',
    title_pt: 'Copom reduz a Selic para 14,00% ao ano',
    summary_pt: 'O Banco Central cortou a taxa básica em 0,25 ponto percentual na reunião de agosto, o primeiro corte do ciclo, com o IPCA mensal bem abaixo do ritmo de 2025.',
    impact_note_pt: 'Juro básico em queda reduz o rendimento do caixa atrelado ao CDI e encurta a vantagem de manter liquidez parada, ao mesmo tempo em que favorece os títulos longos e a bolsa local.',
    discussion_prompt_pt: 'Vale discutirmos se o caixa deve ser reduzido agora que o rendimento sobre ele está caindo, e se faz sentido alongar a parcela indexada à inflação.',
    source: { provider: 'Banco Central do Brasil (SGS)', identifier: 'BCB-SGS-432', reference: 'https://www.bcb.gov.br/controleinflacao/historicotaxasjuros' },
  },
  {
    id: 'evt_ipca_jul2026',
    date: '2026-08-11',
    title: 'IPCA prints 0.07% in July, the softest month of the year',
    category: 'macro',
    summary: 'Monthly consumer inflation came in at 0.07%, well below the average of the first half, easing pressure on the local rates curve.',
    direction: 'positive',
    indicator_key: 'ipca',
    asset_classes: ['Fixed Income'],
    instruments: [],
    impact_note: 'Softer inflation reduces the accrual on inflation-linked instruments in the short run but supports their market price through lower real rates.',
    discussion_prompt: 'Review the balance between IPCA-linked and CDI-linked fixed income given the inflation path.',
    importance: 'medium',
    title_pt: 'IPCA de julho fica em 0,07%, o menor do ano',
    summary_pt: 'A inflação ao consumidor avançou 0,07% no mês, bem abaixo da média do primeiro semestre, o que alivia a pressão sobre a curva de juros local.',
    impact_note_pt: 'Inflação mais baixa reduz a correção dos títulos indexados no curto prazo, mas sustenta o preço deles pela queda dos juros reais.',
    discussion_prompt_pt: 'Revisar o equilíbrio entre renda fixa indexada ao IPCA e ao CDI diante da trajetória da inflação.',
    source: { provider: 'Banco Central do Brasil (SGS)', identifier: 'BCB-SGS-433', reference: 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.433/dados' },
  },
  {
    id: 'evt_oil_supply',
    date: '2026-09-02',
    title: 'Crude oil jumps on supply disruption',
    category: 'commodities',
    summary: 'Brent and WTI rose sharply at the start of September, the largest month-to-date move across the monitored commodity set.',
    direction: 'mixed',
    indicator_key: 'brent',
    asset_classes: ['Commodities', 'Equities BR', 'Fixed Income'],
    instruments: [],
    impact_note: 'Higher crude supports Brazilian export revenue and the currency, but feeds through to fuel and transport prices and therefore to the inflation the fixed-income sleeve is exposed to.',
    discussion_prompt: 'Discuss whether the portfolio has any direct energy exposure and how a sustained oil move would affect the inflation assumption behind the fixed-income allocation.',
    importance: 'high',
    title_pt: 'Petróleo dispara com interrupção de oferta',
    summary_pt: 'Brent e WTI subiram com força no início de setembro, a maior variação no mês entre as commodities monitoradas.',
    impact_note_pt: 'Petróleo mais caro sustenta a receita de exportação brasileira e a moeda, mas se transfere para combustíveis e transporte e, portanto, para a inflação a que a renda fixa está exposta.',
    discussion_prompt_pt: 'Vale conversarmos se a carteira tem exposição direta a energia e como um petróleo alto por mais tempo afeta a premissa de inflação da renda fixa.',
    source: { provider: 'Yahoo Finance', identifier: 'BZ=F, CL=F', reference: 'https://finance.yahoo.com/quote/BZ=F' },
  },
  {
    id: 'evt_gold_record',
    date: '2026-09-01',
    title: 'Gold holds above US$ 4,400 an ounce',
    category: 'commodities',
    summary: 'Gold continues to trade near record levels, extending a run driven by central-bank buying and demand for reserve assets outside the dollar.',
    direction: 'positive',
    indicator_key: 'gold',
    asset_classes: ['Commodities'],
    instruments: ['GOLD11'],
    impact_note: 'Portfolios holding gold have seen it act as the intended diversifier; portfolios without it have foregone that protection.',
    discussion_prompt: 'Discuss whether the gold allocation remains appropriate within the permitted range after the move.',
    importance: 'medium',
    title_pt: 'Ouro se mantém acima de US$ 4.400 a onça',
    summary_pt: 'O ouro segue perto das máximas históricas, sustentado pela compra de bancos centrais e pela procura por reservas fora do dólar.',
    impact_note_pt: 'O ouro costuma se valorizar quando a percepção de risco aumenta, e é por isso que ele aparece como diversificação em algumas políticas de investimento.',
    discussion_prompt_pt: 'Vale avaliarmos se uma alocação em ouro faz sentido dentro da faixa permitida na sua política.',
    source: { provider: 'Yahoo Finance', identifier: 'GC=F', reference: 'https://finance.yahoo.com/quote/GC=F' },
  },
  {
    id: 'evt_hapv_derating',
    date: '2026-08-27',
    title: 'Hapvida falls sharply through August',
    category: 'equities',
    summary: 'Hapvida was the weakest large-cap name in the monitored set over the month, with the technical rating deteriorating while sell-side analysts kept a positive consensus and a target well above the market price.',
    direction: 'negative',
    // Deliberately not attached to an index: the story is a single stock, and
    // showing the Ibovespa's move next to it would misattribute the number.
    indicator_key: null,
    move_label: 'HAPV3 −41,4% em agosto',
    asset_classes: ['Equities BR'],
    instruments: ['HAPV3'],
    impact_note: 'A single-name drawdown of this size is felt directly by any client holding the position, and it is exactly the case where the technical picture and the analyst consensus disagree.',
    discussion_prompt: 'Bring the technical rating and the analyst consensus to the meeting side by side and agree an explicit decision to hold, reduce or exit.',
    importance: 'high',
    title_pt: 'Hapvida cai com força ao longo de agosto',
    summary_pt: 'A Hapvida foi a ação de maior porte com pior desempenho no mês entre as monitoradas; a leitura técnica piorou enquanto os analistas mantiveram recomendação positiva e preço-alvo bem acima do preço de mercado.',
    impact_note_pt: 'Uma queda dessa magnitude em um único papel é sentida diretamente na carteira, e é justamente o caso em que a leitura técnica e o consenso de analistas discordam entre si.',
    discussion_prompt_pt: 'Levar a leitura técnica e o consenso de analistas lado a lado para a reunião e decidir explicitamente entre manter, reduzir ou encerrar.',
    source: { provider: 'TradingView', identifier: 'BMFBOVESPA:HAPV3', reference: 'https://www.tradingview.com/symbols/BMFBOVESPA-HAPV3/' },
  },
  {
    id: 'evt_brl_weakness',
    date: '2026-08-31',
    title: 'The real weakened against the dollar through August',
    category: 'fx',
    summary: 'The dollar ended the month higher against the real, which lifted the reais value of unhedged offshore holdings.',
    direction: 'mixed',
    indicator_key: 'usdbrl',
    asset_classes: ['FX', 'Equities Global'],
    instruments: [],
    impact_note: 'For a client holding unhedged offshore assets, part of the monthly result came from the currency rather than from the assets themselves. That distinction belongs in the letter.',
    discussion_prompt: 'Show the currency contribution separately from the asset contribution so the client understands what actually drove the result.',
    importance: 'high',
    title_pt: 'O real se desvalorizou frente ao dólar em agosto',
    summary_pt: 'O dólar encerrou o mês mais alto contra o real, o que elevou em reais o valor das posições no exterior sem proteção cambial.',
    impact_note_pt: 'Parte do resultado do mês veio da moeda, e não dos ativos: posições no exterior sem proteção cambial valem mais em reais quando o dólar sobe.',
    discussion_prompt_pt: 'Mostrar a contribuição do câmbio separada da contribuição dos ativos para que o cliente entenda o que de fato explicou o resultado.',
    source: { provider: 'Banco Central do Brasil (SGS)', identifier: 'BCB-SGS-1', reference: 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.1/dados' },
  },
  {
    id: 'evt_ai_capex',
    date: '2026-09-03',
    title: 'Semiconductor leadership continues to drive global equity returns',
    category: 'equities',
    summary: 'The technology complex again outpaced the broad index over the month, keeping global equity returns concentrated in a small number of names.',
    direction: 'positive',
    indicator_key: 'nasdaq',
    asset_classes: ['Equities Global'],
    instruments: ['NVDA'],
    impact_note: 'Clients holding a broad global index captured this indirectly; clients holding the individual name captured it directly, along with the concentration risk that comes with it.',
    discussion_prompt: 'For portfolios with a single-name technology position above the policy cap, agree a written exception or a reduction plan.',
    importance: 'medium',
    title_pt: 'Semicondutores seguem puxando o retorno da bolsa global',
    summary_pt: 'O setor de tecnologia voltou a superar o índice amplo no mês, mantendo o retorno da renda variável global concentrado em poucos nomes.',
    impact_note_pt: 'A exposição global da carteira captura esse movimento por meio de um índice amplo, sem depender do desempenho de uma única empresa.',
    discussion_prompt_pt: 'Para carteiras com posição individual em tecnologia acima do teto da política, formalizar por escrito a exceção ou combinar um plano de redução.',
    source: { provider: 'Yahoo Finance', identifier: '^IXIC, NVDA', reference: 'https://finance.yahoo.com/quote/%5EIXIC' },
  },
];

/**
 * XP's February 2025 macro projections, from Input/XP - Macro analysis.txt.
 * Kept as a dated vintage and never presented as a live market observation.
 */
export const MACRO_VINTAGE = {
  provider: 'XP Research — Brasil Macro Mensal',
  published: '2025-02-06',
  authors: 'Caio Megale, Andres Pardo, Rodolfo Margato, Tiago Sbardelotto, Alexandre Maluf, Luíza Pineze',
  headline: 'Pax brasileira ou calmaria antes de outra tempestade?',
  projections: {
    gdp_2025: 0.020, gdp_2026: 0.010,
    ipca_2025: 0.061, ipca_2026: 0.045,
    selic_end_2025: 0.1550, selic_end_2026: 0.1250,
    fx_end_2025: 6.20, fx_end_2026: 6.40,
    unemployment_2026: 0.078,
    gross_debt_2026: 0.839,
  },
  stance: 'Fragile near-term stabilisation: inflation above target, a restrictive policy rate, rising public debt and slowing growth.',
  note: 'Dated vintage. Every projection in this record is the view published on 6 February 2025 and is compared against, never substituted for, the live series retrieved from the Banco Central.',
};
