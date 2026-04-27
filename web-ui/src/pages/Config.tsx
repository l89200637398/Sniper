import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type PendingValue = number | boolean;

interface ConfigField {
  path: string;
  label: string;
  desc: string;
}

interface ConfigGroup {
  label: string;
  desc?: string;
  fields: ConfigField[];
}

const GROUPS: ConfigGroup[] = [
  {
    label: 'Entry & Sizing',
    desc: 'Основные параметры входа в позиции и управления размером',
    fields: [
      { path: 'strategy.maxPositions', label: 'Max Positions', desc: 'Макс. одновременных позиций по всем протоколам' },
      { path: 'strategy.maxPumpFunPositions', label: 'Max Pump.fun', desc: 'Макс. одновременных позиций на Pump.fun' },
      { path: 'strategy.maxPumpSwapPositions', label: 'Max PumpSwap', desc: 'Макс. одновременных позиций на PumpSwap' },
      { path: 'strategy.maxRaydiumLaunchPositions', label: 'Max Raydium Launch', desc: 'Макс. позиций на Raydium LaunchLab' },
      { path: 'strategy.maxRaydiumCpmmPositions', label: 'Max Raydium CPMM', desc: 'Макс. позиций на Raydium CPMM' },
      { path: 'strategy.maxRaydiumAmmV4Positions', label: 'Max Raydium AMM v4', desc: 'Макс. позиций на Raydium AMM v4' },
      { path: 'strategy.maxTotalExposureSol', label: 'Max Exposure (SOL)', desc: 'Макс. суммарный объём открытых позиций в SOL' },
      { path: 'strategy.minBalanceToTradeSol', label: 'Min Balance (SOL)', desc: 'Порог баланса — ниже этого бот не открывает новые позиции. 0 = отключено' },
      { path: 'strategy.minIndependentBuySol', label: 'Min Independent Buy (SOL)', desc: 'Минимальный размер покупки independent buyer для подтверждения спроса' },
      { path: 'strategy.waitForBuyerTimeoutMs', label: 'Wait for Buyer (ms)', desc: 'Сколько ждать independent buyer перед входом' },
      { path: 'strategy.earlyExitTimeoutMs', label: 'Early Exit Timeout (ms)', desc: 'Тайм-аут для первого чтения цены после входа. Больше = надёжнее' },
      { path: 'strategy.maxTokenAgeMs', label: 'Max Token Age (ms)', desc: 'Максимальный возраст токена для входа' },
      { path: 'strategy.minTokenAgeMs', label: 'Min Token Age (ms)', desc: 'Минимальный возраст — фильтрует bundled dev-buys' },
      { path: 'strategy.pumpSwapInstantEntry', label: 'PumpSwap Instant Entry', desc: 'Мгновенный вход без ожидания buyer (рискованно)' },
    ],
  },
  {
    label: 'Token Scoring',
    desc: 'Система скоринга токенов 0-100 баллов. Чем выше порог — тем строже фильтр',
    fields: [
      { path: 'strategy.enableScoring', label: 'Enable Scoring', desc: 'Включить/выключить систему скоринга' },
      { path: 'strategy.minTokenScore', label: 'Min Score', desc: 'Минимальный балл для входа (0-100). Ниже — токен пропускается' },
      { path: 'strategy.enableRugcheck', label: 'Enable Rugcheck', desc: 'Проверка токенов через Rugcheck API' },
    ],
  },
  {
    label: 'Entry Filters',
    desc: 'Дополнительные фильтры и множители при входе',
    fields: [
      { path: 'strategy.creatorSellExit', label: 'Creator Sell Exit', desc: 'Выход при обнаружении продажи создателем токена' },
      { path: 'strategy.creatorSellMinDropPct', label: 'Creator Sell Min Drop %', desc: 'Мин. падение PnL для срабатывания creator sell exit (8 = -8%)' },
      { path: 'strategy.socialHighMultiplier', label: 'Social High Multiplier', desc: 'Множитель entry при высоком social score (1.5×)' },
      { path: 'strategy.socialLowMultiplier', label: 'Social Low Multiplier', desc: 'Множитель entry при низком social score (0.5×)' },
      { path: 'strategy.entryMomentum.enabled', label: 'Entry Momentum Filter', desc: 'Блокировать вход если цена уже слишком выросла от первой замеченной' },
      { path: 'strategy.entryMomentum.maxPumpRatio', label: 'Max Pump Ratio', desc: 'Макс. отношение текущей цены к первой замеченной (3.0 = 3×)' },
    ],
  },
  {
    label: 'Social Gate',
    desc: 'Штраф/бонус по social mentions при скоринге',
    fields: [
      { path: 'strategy.socialGate.enabled', label: 'Enabled', desc: 'Включить social gate при entry scoring' },
      { path: 'strategy.socialGate.lookbackMs', label: 'Lookback (ms)', desc: 'Окно проверки social mentions (300000 = 5 мин)' },
      { path: 'strategy.socialGate.noMentionPenalty', label: 'No Mention Penalty', desc: 'Штраф к score если 0 mentions' },
      { path: 'strategy.socialGate.mentionBonus', label: 'Mention Bonus', desc: 'Бонус к score при ≥2 mentions' },
    ],
  },
  {
    label: 'Whale Sell Detection',
    desc: 'Мониторинг крупных holders — мгновенный exit при сбросе',
    fields: [
      { path: 'strategy.whaleSell.enabled', label: 'Enabled', desc: 'Включить whale sell detection' },
      { path: 'strategy.whaleSell.checkIntervalMs', label: 'Check Interval (ms)', desc: 'Частота проверки holders (30000 = 30с)' },
      { path: 'strategy.whaleSell.minPositionAgeMs', label: 'Min Position Age (ms)', desc: 'Не проверяем в первые N мс позиции' },
      { path: 'strategy.whaleSell.dropThresholdPct', label: 'Drop Threshold %', desc: 'Holder сбросил ≥N% своего баланса → exit' },
      { path: 'strategy.whaleSell.minHolderPct', label: 'Min Holder %', desc: 'Игнорировать holders с <N% от supply' },
    ],
  },
  {
    label: 'Adaptive Scoring',
    desc: 'Автоматическое повышение minTokenScore при низком WR',
    fields: [
      { path: 'strategy.adaptiveScoring.enabled', label: 'Enabled', desc: 'Включить adaptive scoring' },
      { path: 'strategy.adaptiveScoring.window', label: 'Window (trades)', desc: 'Кол-во последних сделок для оценки' },
      { path: 'strategy.adaptiveScoring.targetWinRate', label: 'Target WR', desc: 'Целевой WR (0.50 = 50%)' },
      { path: 'strategy.adaptiveScoring.bumpPerMiss', label: 'Bump per Miss', desc: 'Прибавка к minScore за каждые 5pp ниже цели' },
      { path: 'strategy.adaptiveScoring.maxBump', label: 'Max Bump', desc: 'Макс. прибавка к minTokenScore' },
      { path: 'strategy.adaptiveScoring.relaxAfterWins', label: 'Relax After Wins', desc: 'Уменьшить bump после N побед подряд' },
    ],
  },
  {
    label: 'Liquidity Depth',
    desc: 'Проверка глубины ликвидности перед sell',
    fields: [
      { path: 'strategy.liquidityDepth.enabled', label: 'Enabled', desc: 'Включить liquidity depth check' },
      { path: 'strategy.liquidityDepth.maxPoolImpactPct', label: 'Max Pool Impact %', desc: 'Если sell > N% пула → роутим через Jupiter' },
    ],
  },
  {
    label: 'Loss Control',
    desc: 'Защита от серий убытков',
    fields: [
      { path: 'strategy.consecutiveLossesMax', label: 'Max Consecutive Losses', desc: 'После N убытков подряд — пауза. 0 = отключено' },
      { path: 'strategy.pauseAfterLossesMs', label: 'Pause Duration (ms)', desc: 'Длительность паузы после серии убытков (900000 = 15 мин)' },
    ],
  },
  {
    label: 'Pump.fun — Entry',
    desc: 'Bonding curve протокол — основной источник токенов',
    fields: [
      { path: 'strategy.pumpFun.entryAmountSol', label: 'Entry (SOL)', desc: 'Размер входа в SOL' },
      { path: 'strategy.pumpFun.minEntryAmountSol', label: 'Min Entry (SOL)', desc: 'Минимальный размер входа (после scoring multiplier)' },
      { path: 'strategy.pumpFun.minLiquiditySol', label: 'Min Liquidity (SOL)', desc: 'Мин. ликвидность для входа' },
      { path: 'strategy.pumpFun.slippageBps', label: 'Slippage (bps)', desc: 'Макс. проскальзывание в базисных пунктах (2000 = 20%)' },
    ],
  },
  {
    label: 'Pump.fun — Exit',
    desc: 'Правила выхода из позиций Pump.fun',
    fields: [
      { path: 'strategy.pumpFun.exit.entryStopLossPercent', label: 'Stop-Loss %', desc: 'Стоп-лосс от цены входа' },
      { path: 'strategy.pumpFun.exit.hardStopPercent', label: 'Hard Stop %', desc: 'Абсолютный макс. убыток — выход без условий' },
      { path: 'strategy.pumpFun.exit.trailingActivationPercent', label: 'Trailing Activation %', desc: 'При каком PnL% активируется trailing stop' },
      { path: 'strategy.pumpFun.exit.trailingDrawdownPercent', label: 'Trailing Drawdown %', desc: 'Откат от максимума для срабатывания trailing stop' },
      { path: 'strategy.pumpFun.exit.velocityDropPercent', label: 'Velocity Drop %', desc: 'Резкое падение цены за короткий период — моментальный выход' },
      { path: 'strategy.pumpFun.exit.velocityWindowMs', label: 'Velocity Window (ms)', desc: 'Окно для расчёта velocity drop' },
      { path: 'strategy.pumpFun.exit.slowDrawdownPercent', label: 'Slow Drawdown %', desc: 'Медленный откат (за длительное время)' },
      { path: 'strategy.pumpFun.exit.stagnationWindowMs', label: 'Stagnation Window (ms)', desc: 'Время без движения цены → выход' },
      { path: 'strategy.pumpFun.exit.timeStopAfterMs', label: 'Time Stop (ms)', desc: 'Макс. время жизни позиции (45000 = 45 сек)' },
      { path: 'strategy.pumpFun.exit.timeStopMinPnl', label: 'Time Stop Min PnL', desc: 'Мин. PnL для срабатывания time-stop (отрицательное = выход даже в убытке)' },
      { path: 'strategy.pumpFun.exit.breakEvenAfterTrailingPercent', label: 'Break-Even %', desc: 'Перемещение стоп-лосса в безубыток после TP1 (отриц. = чуть ниже entry)' },
    ],
  },
  {
    label: 'Pump.fun — Runner Tail',
    desc: 'Режим монстр-раннера — даёт сильным токенам расти x5-x10',
    fields: [
      { path: 'strategy.pumpFun.exit.runnerActivationPercent', label: 'Activation %', desc: 'При каком PnL% переходим в режим runner' },
      { path: 'strategy.pumpFun.exit.runnerTrailDrawdownPercent', label: 'Trail Drawdown %', desc: 'Расширенный trailing для runner' },
      { path: 'strategy.pumpFun.exit.runnerHardStopPercent', label: 'Hard Stop %', desc: 'Потолок убытка для runner позиции' },
    ],
  },
  {
    label: 'PumpSwap — Entry',
    desc: 'AMM протокол после миграции с bonding curve',
    fields: [
      { path: 'strategy.pumpSwap.entryAmountSol', label: 'Entry (SOL)', desc: 'Размер входа в SOL' },
      { path: 'strategy.pumpSwap.minEntryAmountSol', label: 'Min Entry (SOL)', desc: 'Минимальный размер входа' },
      { path: 'strategy.pumpSwap.minLiquiditySol', label: 'Min Liquidity (SOL)', desc: 'Мин. ликвидность пула для входа' },
      { path: 'strategy.pumpSwap.slippageBps', label: 'Slippage (bps)', desc: 'Макс. проскальзывание (1500 = 15%)' },
      { path: 'strategy.pumpSwap.maxReserveFraction', label: 'Max Reserve Fraction', desc: 'Макс. доля от резервов пула для одного входа' },
    ],
  },
  {
    label: 'PumpSwap — Exit',
    desc: 'Правила выхода из позиций PumpSwap',
    fields: [
      { path: 'strategy.pumpSwap.exit.entryStopLossPercent', label: 'Stop-Loss %', desc: 'Стоп-лосс от цены входа' },
      { path: 'strategy.pumpSwap.exit.hardStopPercent', label: 'Hard Stop %', desc: 'Абсолютный макс. убыток' },
      { path: 'strategy.pumpSwap.exit.trailingActivationPercent', label: 'Trailing Activation %', desc: 'При каком PnL% активируется trailing stop' },
      { path: 'strategy.pumpSwap.exit.trailingDrawdownPercent', label: 'Trailing Drawdown %', desc: 'Откат от максимума для trailing stop' },
      { path: 'strategy.pumpSwap.exit.velocityDropPercent', label: 'Velocity Drop %', desc: 'Резкое падение цены — моментальный выход' },
      { path: 'strategy.pumpSwap.exit.velocityWindowMs', label: 'Velocity Window (ms)', desc: 'Окно velocity drop' },
      { path: 'strategy.pumpSwap.exit.slowDrawdownPercent', label: 'Slow Drawdown %', desc: 'Медленный откат' },
      { path: 'strategy.pumpSwap.exit.stagnationWindowMs', label: 'Stagnation Window (ms)', desc: 'Время без движения → выход' },
      { path: 'strategy.pumpSwap.exit.timeStopAfterMs', label: 'Time Stop (ms)', desc: 'Макс. время жизни позиции' },
      { path: 'strategy.pumpSwap.exit.timeStopMinPnl', label: 'Time Stop Min PnL', desc: 'Мин. PnL для time-stop' },
      { path: 'strategy.pumpSwap.exit.breakEvenAfterTrailingPercent', label: 'Break-Even %', desc: 'Безубыток после TP1' },
    ],
  },
  {
    label: 'PumpSwap — Runner Tail',
    desc: 'Runner-режим для PumpSwap',
    fields: [
      { path: 'strategy.pumpSwap.exit.runnerActivationPercent', label: 'Activation %', desc: 'PnL% для перехода в runner' },
      { path: 'strategy.pumpSwap.exit.runnerTrailDrawdownPercent', label: 'Trail Drawdown %', desc: 'Расширенный trailing для runner' },
      { path: 'strategy.pumpSwap.exit.runnerHardStopPercent', label: 'Hard Stop %', desc: 'Потолок убытка runner' },
    ],
  },
  {
    label: 'Raydium LaunchLab',
    desc: 'Bonding curve Raydium — graduation at ~85 SOL → AMM',
    fields: [
      { path: 'strategy.raydiumLaunch.entryAmountSol', label: 'Entry (SOL)', desc: 'Размер входа' },
      { path: 'strategy.raydiumLaunch.slippageBps', label: 'Slippage (bps)', desc: 'Проскальзывание' },
      { path: 'strategy.raydiumLaunch.exit.entryStopLossPercent', label: 'Stop-Loss %', desc: 'Стоп-лосс от цены входа' },
      { path: 'strategy.raydiumLaunch.exit.trailingActivationPercent', label: 'Trailing Activation %', desc: 'Активация trailing stop' },
      { path: 'strategy.raydiumLaunch.exit.trailingDrawdownPercent', label: 'Trailing Drawdown %', desc: 'Откат trailing stop' },
      { path: 'strategy.raydiumLaunch.exit.hardStopPercent', label: 'Hard Stop %', desc: 'Макс. убыток' },
      { path: 'strategy.raydiumLaunch.exit.timeStopAfterMs', label: 'Time Stop (ms)', desc: 'Макс. время позиции' },
      { path: 'strategy.raydiumLaunch.exit.runnerActivationPercent', label: 'Runner Activation %', desc: 'Порог перехода в runner' },
      { path: 'strategy.raydiumLaunch.exit.runnerTrailDrawdownPercent', label: 'Runner Trail %', desc: 'Trailing runner' },
    ],
  },
  {
    label: 'Raydium CPMM',
    desc: 'Constant product AMM — глубокая ликвидность, 4 уровня комиссии',
    fields: [
      { path: 'strategy.raydiumCpmm.entryAmountSol', label: 'Entry (SOL)', desc: 'Размер входа' },
      { path: 'strategy.raydiumCpmm.slippageBps', label: 'Slippage (bps)', desc: 'Проскальзывание' },
      { path: 'strategy.raydiumCpmm.exit.entryStopLossPercent', label: 'Stop-Loss %', desc: 'Стоп-лосс' },
      { path: 'strategy.raydiumCpmm.exit.trailingActivationPercent', label: 'Trailing Activation %', desc: 'Активация trailing' },
      { path: 'strategy.raydiumCpmm.exit.trailingDrawdownPercent', label: 'Trailing Drawdown %', desc: 'Откат trailing' },
      { path: 'strategy.raydiumCpmm.exit.hardStopPercent', label: 'Hard Stop %', desc: 'Макс. убыток' },
      { path: 'strategy.raydiumCpmm.exit.timeStopAfterMs', label: 'Time Stop (ms)', desc: 'Макс. время позиции' },
      { path: 'strategy.raydiumCpmm.exit.runnerActivationPercent', label: 'Runner Activation %', desc: 'Порог runner' },
    ],
  },
  {
    label: 'Raydium AMM v4',
    desc: 'Legacy AMM — фиксированная комиссия 25 bps',
    fields: [
      { path: 'strategy.raydiumAmmV4.entryAmountSol', label: 'Entry (SOL)', desc: 'Размер входа' },
      { path: 'strategy.raydiumAmmV4.slippageBps', label: 'Slippage (bps)', desc: 'Проскальзывание' },
      { path: 'strategy.raydiumAmmV4.exit.entryStopLossPercent', label: 'Stop-Loss %', desc: 'Стоп-лосс' },
      { path: 'strategy.raydiumAmmV4.exit.trailingActivationPercent', label: 'Trailing Activation %', desc: 'Активация trailing' },
      { path: 'strategy.raydiumAmmV4.exit.trailingDrawdownPercent', label: 'Trailing Drawdown %', desc: 'Откат trailing' },
      { path: 'strategy.raydiumAmmV4.exit.hardStopPercent', label: 'Hard Stop %', desc: 'Макс. убыток' },
      { path: 'strategy.raydiumAmmV4.exit.timeStopAfterMs', label: 'Time Stop (ms)', desc: 'Макс. время позиции' },
    ],
  },
  {
    label: 'Trend Tracking',
    desc: 'Trend-confirmed entry — анализ потока buy/sell перед входом (Режимы A/B/C)',
    fields: [
      { path: 'trend.enabled', label: 'Enabled', desc: 'Включить trend-confirmed entry (Mode B). Выключено = мгновенный вход как раньше' },
      { path: 'trend.eliteScoreThreshold', label: 'Elite Score', desc: 'Prelim score >= этого = Mode A (мгновенный вход). По умолчанию 50' },
      { path: 'trend.trackingScoreThreshold', label: 'Tracking Score', desc: 'Мин. prelim score для начала отслеживания. По умолчанию 15' },
      { path: 'trend.pumpFunWindowMs', label: 'Pump.fun Window (ms)', desc: 'Sliding window для агрегации buy/sell на pump.fun (20000 = 20с)' },
      { path: 'trend.pumpSwapWindowMs', label: 'PumpSwap Window (ms)', desc: 'Sliding window для PumpSwap (120000 = 2 мин)' },
      { path: 'trend.raydiumWindowMs', label: 'Raydium Window (ms)', desc: 'Sliding window для Raydium (180000 = 3 мин)' },
      { path: 'trend.minUniqueBuyers', label: 'Min Unique Buyers', desc: 'Мин. уникальных покупателей для подтверждения тренда' },
      { path: 'trend.minBuyVolumeSol', label: 'Min Buy Volume (SOL)', desc: 'Мин. суммарный объём покупок в SOL' },
      { path: 'trend.minBuySellRatio', label: 'Min Buy/Sell Ratio', desc: 'Мин. соотношение buy/sell (1.5 = покупок в 1.5× больше продаж)' },
      { path: 'trend.pumpFunTimeoutMs', label: 'Pump.fun Timeout (ms)', desc: 'Таймаут ожидания тренда для pump.fun (45000 = 45с)' },
      { path: 'trend.pumpSwapTimeoutMs', label: 'PumpSwap Timeout (ms)', desc: 'Таймаут для PumpSwap (300000 = 5 мин)' },
      { path: 'trend.raydiumTimeoutMs', label: 'Raydium Timeout (ms)', desc: 'Таймаут для Raydium (300000 = 5 мин)' },
      { path: 'trend.strengthenBuyerThreshold', label: 'Strengthen Buyers', desc: 'Порог unique buyers для сигнала trend:strengthening (докупка)' },
      { path: 'trend.strengthenVolumeSol', label: 'Strengthen Volume (SOL)', desc: 'Порог объёма для trend:strengthening' },
      { path: 'trend.weakenSellRatio', label: 'Weaken Sell Ratio', desc: 'Sell/buy ratio >= этого = trend:weakening (сигнал на выход)' },
      { path: 'trend.weakenWindowMs', label: 'Weaken Window (ms)', desc: 'Окно анализа ослабления тренда (30000 = 30с)' },
      { path: 'trend.socialDiscoveryEnabled', label: 'Social Discovery', desc: 'Mode C: social signal с mint → отслеживание → покупка при подтверждении' },
      { path: 'trend.socialMaxTrackedMints', label: 'Social Max Tracked', desc: 'Макс. одновременно отслеживаемых social-discovered mint' },
      { path: 'trend.inactiveCleanupMs', label: 'Cleanup Interval (ms)', desc: 'Интервал очистки неактивных трекеров (300000 = 5 мин)' },
    ],
  },
  {
    label: 'Trend Re-Entry',
    desc: 'Повторный вход после закрытия — если тренд возобновился (PumpSwap + Raydium)',
    fields: [
      { path: 'strategy.trendReEntry.enabled', label: 'Enabled', desc: 'Включить повторный вход по тренду' },
      { path: 'strategy.trendReEntry.maxReEntries', label: 'Max Re-Entries', desc: 'Макс. повторных входов на один mint' },
      { path: 'strategy.trendReEntry.cooldownMs', label: 'Cooldown (ms)', desc: 'Мин. пауза после закрытия перед повторным входом' },
      { path: 'strategy.trendReEntry.entryMultiplier', label: 'Entry Multiplier', desc: 'Множитель размера входа (0.5 = 50% от базового)' },
      { path: 'strategy.trendReEntry.requiresTpProfit', label: 'Requires TP Profit', desc: 'Предыдущий выход должен быть в плюсе' },
    ],
  },
  {
    label: 'Dead Volume Exit',
    desc: 'Ранний выход при отсутствии buy-активности — спасает от мёртвых позиций',
    fields: [
      { path: 'strategy.deadVolume.enabled', label: 'Enabled', desc: 'Включить ранний выход по dead volume' },
      { path: 'strategy.deadVolume.timeoutMs', label: 'Timeout (ms)', desc: 'Время без buy-активности до выхода (60000 = 60с)' },
      { path: 'strategy.deadVolume.minAgeMs', label: 'Min Age (ms)', desc: 'Не проверяем в первые N мс (15000 = 15с)' },
    ],
  },
  {
    label: 'Jupiter Fallback',
    desc: 'Покупка через Jupiter для неизвестных протоколов',
    fields: [
      { path: 'strategy.jupiterFallback.enabled', label: 'Enabled', desc: 'Включить Jupiter fallback buy' },
      { path: 'strategy.jupiterFallback.entryAmountSol', label: 'Entry (SOL)', desc: 'Размер входа (меньше стандартного — выше риск)' },
      { path: 'strategy.jupiterFallback.slippageBps', label: 'Slippage (bps)', desc: 'Проскальзывание' },
      { path: 'strategy.jupiterFallback.timeStopMs', label: 'Time Stop (ms)', desc: 'Жёсткий time-stop без мониторинга цены' },
    ],
  },
  {
    label: 'Jito MEV',
    desc: 'Jito bundle tips — влияют на скорость исполнения',
    fields: [
      { path: 'jito.tipAmountSol', label: 'Base Tip (SOL)', desc: 'Начальный tip. Слишком низкий = пропуск сделок' },
      { path: 'jito.maxTipAmountSol', label: 'Max Tip (SOL)', desc: 'Потолок tip после эскалации' },
      { path: 'jito.minTipAmountSol', label: 'Min Tip (SOL)', desc: 'Минимальный пол tip' },
      { path: 'jito.maxRetries', label: 'Max Retries', desc: 'Макс. попыток отправки bundle (3 = 1.2с задержка)' },
      { path: 'jito.tipIncreaseFactor', label: 'Tip Escalation', desc: 'Множитель tip при ретрае (1.5 = +50% каждую попытку)' },
      { path: 'jito.burstCount', label: 'Burst Count', desc: 'Кол-во одновременных bundle при входе' },
    ],
  },
  {
    label: 'Copy-Trade',
    desc: '2-tier система копирования сделок отслеживаемых кошельков',
    fields: [
      { path: 'strategy.copyTrade.enabled', label: 'Enabled', desc: 'Включить copy-trading' },
      { path: 'strategy.copyTrade.entryAmountSol', label: 'T1 Entry (SOL)', desc: 'Вход для Tier 1 кошельков (WR >= 60%, >= 15 сделок)' },
      { path: 'strategy.copyTrade.tier2EntryAmountSol', label: 'T2 Entry (SOL)', desc: 'Вход для Tier 2 кошельков (WR >= 50%, >= 8 сделок)' },
      { path: 'strategy.copyTrade.maxPositions', label: 'Max Positions', desc: 'Макс. одновременных copy-trade позиций' },
      { path: 'strategy.copyTrade.minBuySolFromTracked', label: 'Min Buy Signal (SOL)', desc: 'Мин. размер покупки трекера для копирования' },
      { path: 'strategy.copyTrade.reservedT1Slots', label: 'Reserved T1 Slots', desc: 'Зарезервированные слоты под T1 (не занимаются обычными сделками)' },
    ],
  },
  {
    label: 'Wallet Tracker',
    desc: 'Пороги для автоматического определения тиров кошельков',
    fields: [
      { path: 'walletTracker.minCompletedTrades', label: 'T1 Min Trades', desc: 'Мин. завершённых сделок для Tier 1' },
      { path: 'walletTracker.minWinRate', label: 'T1 Min WR', desc: 'Мин. винрейт для Tier 1 (0.60 = 60%)' },
      { path: 'walletTracker.tier2MinCompletedTrades', label: 'T2 Min Trades', desc: 'Мин. сделок для Tier 2' },
      { path: 'walletTracker.tier2MinWinRate', label: 'T2 Min WR', desc: 'Мин. винрейт для Tier 2 (0.50 = 50%)' },
      { path: 'walletTracker.maxTrackedWallets', label: 'Max Tracked', desc: 'Макс. отслеживаемых кошельков' },
    ],
  },
  {
    label: 'Defensive Mode',
    desc: 'Автоматическое ужесточение фильтров при низком винрейте',
    fields: [
      { path: 'strategy.defensive.enabled', label: 'Enabled', desc: 'Включить defensive mode' },
      { path: 'strategy.defensive.window', label: 'Window (trades)', desc: 'Минимум сделок для оценки rolling WR' },
      { path: 'strategy.defensive.entryThreshold', label: 'Entry WR', desc: 'WR ниже этого → включить (0.45 = 45%)' },
      { path: 'strategy.defensive.exitThreshold', label: 'Exit WR', desc: 'WR выше этого → выключить (0.55 = 55%)' },
      { path: 'strategy.defensive.scoreDelta', label: 'Score Delta', desc: 'Прибавка к minTokenScore в defensive' },
      { path: 'strategy.defensive.entryMultiplier', label: 'Entry Multiplier', desc: 'Множитель размера входа (0.70 = -30%)' },
    ],
  },
  {
    label: 'Compute & Fees',
    desc: 'Compute budget для транзакций — влияет на стоимость каждой TX',
    fields: [
      { path: 'compute.unitLimit', label: 'CU Limit', desc: 'Compute units на TX (200000 = 200k CU)' },
      { path: 'compute.unitPriceMicroLamports', label: 'CU Price (microLamports)', desc: 'Цена за CU. 50000 = ~0.010 SOL/TX' },
    ],
  },
  {
    label: 'Timeouts',
    desc: 'Таймауты подтверждения транзакций',
    fields: [
      { path: 'timeouts.pendingBuyTimeoutMs', label: 'Pending Buy (ms)', desc: 'Тайм-аут ожидания подтверждения buy bundle' },
      { path: 'timeouts.confirmTransactionTimeoutMs', label: 'Confirm TX (ms)', desc: 'Тайм-аут подтверждения транзакции' },
      { path: 'timeouts.confirmIntervalMs', label: 'Confirm Interval (ms)', desc: 'Интервал проверки подтверждения (400 = каждые 400мс)' },
    ],
  },
];

function getByPath(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

export function Config() {
  const [cfg, setCfg] = useState<any>(null);
  const [cfgVersion, setCfgVersion] = useState(0);
  const [pending, setPending] = useState<Record<string, PendingValue>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const reload = async () => {
    setError(null);
    try {
      const data = await api.getConfig();
      setCfg(data);
      setCfgVersion(v => v + 1);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load config');
    }
  };

  useEffect(() => {
    reload();
  }, []);

  const toggleGroup = (label: string) => {
    setCollapsed(c => ({ ...c, [label]: !c[label] }));
  };

  const handleChange = (path: string, value: PendingValue) => {
    setPending(p => ({ ...p, [path]: value }));
  };

  const handleRevert = (path: string) => {
    setPending(p => {
      const n = { ...p };
      delete n[path];
      return n;
    });
    setCfgVersion(v => v + 1);
  };

  const handleApply = async () => {
    if (!Object.keys(pending).length) return;
    setBusy(true);
    setError(null);
    try {
      const changes = Object.entries(pending).map(([path, value]) => ({ path, value }));
      const res: any = await api.setConfig(changes);
      if (res?.errors?.length) {
        setError('Rejected: ' + res.errors.join('; '));
      }
      setPending({});
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      await reload();
    } catch (e: any) {
      setError(e?.message ?? 'Failed to save');
    } finally {
      setBusy(false);
    }
  };

  const handleRollback = async () => {
    if (!confirm('Rollback last 50 config changes?')) return;
    setBusy(true);
    setError(null);
    try {
      await api.rollback();
      setPending({});
      await reload();
    } catch (e: any) {
      setError(e?.message ?? 'Rollback failed');
    } finally {
      setBusy(false);
    }
  };

  if (!cfg) {
    return (
      <div className="text-zinc-400">
        {error ? <span className="text-red-400">Error: {error}</span> : 'Loading config...'}
      </div>
    );
  }

  const pendingCount = Object.keys(pending).length;

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center justify-between sticky top-0 bg-zinc-950 py-3 z-10">
        <h1 className="text-2xl font-bold">Configuration</h1>
        <div className="flex gap-2">
          <button
            onClick={handleRollback}
            disabled={busy}
            className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 rounded text-sm"
          >
            Rollback
          </button>
          <button
            onClick={handleApply}
            disabled={busy || pendingCount === 0}
            className="px-3 py-1.5 bg-green-600 hover:bg-green-500 disabled:opacity-40 rounded text-sm"
          >
            {busy ? '...' : saved ? 'Saved' : pendingCount > 0 ? `Apply (${pendingCount})` : 'Apply'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-950/40 border border-red-900 text-red-300 rounded-lg px-3 py-2 text-sm">
          {error}
        </div>
      )}

      {GROUPS.map(({ label, desc, fields }) => {
        const isCollapsed = collapsed[label];
        const dirtyCount = fields.filter(f => f.path in pending).length;

        return (
          <div key={label} className="bg-zinc-900 rounded-xl overflow-hidden">
            <button
              onClick={() => toggleGroup(label)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-zinc-800/50 transition"
            >
              <div className="text-left">
                <h2 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
                  {label}
                  {dirtyCount > 0 && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-yellow-600 text-white">{dirtyCount}</span>
                  )}
                </h2>
                {desc && <p className="text-[11px] text-zinc-500 mt-0.5">{desc}</p>}
              </div>
              <span className="text-zinc-500 text-xs">{isCollapsed ? '+' : '-'}</span>
            </button>

            {!isCollapsed && (
              <div className="px-4 pb-4 space-y-2.5 border-t border-zinc-800 pt-3">
                {fields.map(({ path, label: fieldLabel, desc: fieldDesc }) => {
                  const current = getByPath(cfg, path);
                  const dirty = path in pending;
                  const inputKey = `${path}:${cfgVersion}`;

                  if (current === undefined) {
                    return (
                      <div key={path} className="text-xs text-zinc-600">
                        <span className="font-mono">{fieldLabel}</span>: <span className="text-red-400">not in config</span>
                      </div>
                    );
                  }

                  if (typeof current === 'boolean') {
                    const shown = dirty ? (pending[path] as boolean) : current;
                    return (
                      <div key={path} className="flex items-start gap-3 group">
                        <div className="w-56 shrink-0 pt-0.5">
                          <div className="text-xs text-zinc-300">{fieldLabel}</div>
                          <div className="text-[10px] text-zinc-600 leading-tight">{fieldDesc}</div>
                        </div>
                        <input
                          type="checkbox"
                          checked={shown}
                          onChange={e => handleChange(path, e.target.checked)}
                          className="w-4 h-4 accent-green-500 mt-0.5"
                        />
                        {dirty && (
                          <button
                            onClick={() => handleRevert(path)}
                            className="text-[10px] text-zinc-500 hover:text-zinc-300"
                          >
                            revert ({String(current)})
                          </button>
                        )}
                      </div>
                    );
                  }

                  if (typeof current === 'number') {
                    return (
                      <div key={path} className="flex items-start gap-3 group">
                        <div className="w-56 shrink-0 pt-0.5">
                          <div className="text-xs text-zinc-300">{fieldLabel}</div>
                          <div className="text-[10px] text-zinc-600 leading-tight">{fieldDesc}</div>
                        </div>
                        <input
                          key={inputKey}
                          type="number"
                          step="any"
                          defaultValue={current}
                          onChange={e => {
                            const v = e.target.value;
                            if (v === '') return;
                            const n = Number(v);
                            if (!Number.isFinite(n)) return;
                            handleChange(path, n);
                          }}
                          className={`bg-zinc-800 border rounded px-2 py-1 text-sm w-32 font-mono text-white
                            ${dirty ? 'border-yellow-500' : 'border-zinc-700'}`}
                        />
                        {dirty && (
                          <span className="text-[10px] text-yellow-400 flex items-center gap-2 pt-0.5">
                            {String(pending[path])}
                            <button
                              onClick={() => handleRevert(path)}
                              className="text-zinc-500 hover:text-zinc-300"
                            >
                              revert
                            </button>
                          </span>
                        )}
                      </div>
                    );
                  }

                  return (
                    <div key={path} className="text-xs font-mono text-zinc-600">
                      {fieldLabel}: unsupported type ({typeof current})
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      <p className="text-xs text-zinc-600 pb-4">
        Изменения применяются мгновенно без перезапуска бота. Rollback откатывает последние 50 изменений.
      </p>
    </div>
  );
}
