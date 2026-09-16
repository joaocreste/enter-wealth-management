-- Where a threshold came from.
--
-- Every other figure the portal prints names its provider (§29). The trigger
-- was the exception: the portal could say "Brent acima de US$ 90/bbl: limiar
-- rompido" with the observed price fully sourced to Yahoo Finance, and no way
-- for the advisor reading it to ask who decided that 90 was the number.
--
--   rationale — why this level and not another, in one sentence
--   source    — the document or decision that set it: a committee minute, a
--               house note, the client's own investment policy. NULL means
--               nobody has signed it, and the portal says so rather than
--               letting an unsourced number pass as a house view.
ALTER TABLE market_triggers ADD COLUMN rationale TEXT;
ALTER TABLE market_triggers ADD COLUMN source TEXT;

-- The thresholds that shipped with the product are desk conventions written
-- into the seed, not a published XP view. They keep their reasoning and stay
-- explicitly unsourced until someone signs them.
UPDATE market_triggers SET rationale = 'Acima de US$ 120 o petróleo deixa de ser custo setorial e vira choque de inflação, com repasse à curva de juros local.' WHERE id = 'trg_brent_120';
UPDATE market_triggers SET rationale = 'US$ 90 é o nível em que o repasse do petróleo começa a aparecer nas margens das empresas de consumo brasileiras.' WHERE id = 'trg_brent_90';
UPDATE market_triggers SET rationale = '5,00% é a marca em que a renda variável global de duração longa costuma ser remarcada pela taxa de desconto.' WHERE id = 'trg_us10y_500';
UPDATE market_triggers SET rationale = '4,50% é o ponto em que a duration da carteira merece uma conferência antes da próxima reunião.' WHERE id = 'trg_us10y_450';
UPDATE market_triggers SET rationale = 'VIX acima de 30 é estresse; sustentado por cinco pregões, deixa de ser ruído e vira regime.' WHERE id = 'trg_vix_30';
UPDATE market_triggers SET rationale = 'Acima de 105 o dólar forte historicamente drena fluxo de mercados emergentes.' WHERE id = 'trg_dxy_105';
UPDATE market_triggers SET rationale = 'Abaixo de 92 o dólar fraco favorece emergentes, e a exposição em dólar sem hedge perde parte da razão de ser.' WHERE id = 'trg_dxy_92';
UPDATE market_triggers SET rationale = 'A R$ 6,00 o câmbio sozinho explica boa parte do resultado de uma carteira com posição no exterior sem hedge.' WHERE id = 'trg_usdbrl_600';
UPDATE market_triggers SET rationale = 'A partir de R$ 5,00 a contribuição cambial deixa de ser detalhe e precisa ser dita na carta.' WHERE id = 'trg_usdbrl_500';
UPDATE market_triggers SET rationale = 'US$ 4.000/oz costuma levar a parcela em ouro para fora da faixa sem que ninguém tenha comprado nada.' WHERE id = 'trg_gold_4000';
UPDATE market_triggers SET rationale = '0,60% ao mês anualiza acima do teto da meta; é surpresa inflacionária, não ruído mensal.' WHERE id = 'trg_ipca_060';
UPDATE market_triggers SET rationale = 'Com a Selic em 15% o carrego do caixa compete de frente com o prêmio de risco da bolsa.' WHERE id = 'trg_selic_1500';
UPDATE market_triggers SET rationale = 'Queda de mais de 4% no mês no high yield americano é o primeiro sinal de estresse de crédito que chega aos fundos locais.' WHERE id = 'trg_hy_stress';
UPDATE market_triggers SET rationale = 'US$ 100 mil é um número redondo e nada além disso; serve como marca de rebalanceamento da parcela em ativos digitais, onde ela existe.' WHERE id = 'trg_btc_100k';
