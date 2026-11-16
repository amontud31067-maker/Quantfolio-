/**
 * QuantFolio Wealth Analytics - Frontend Controller (v2.3)
 * ออกแบบให้คนทั่วไปใช้งานง่ายที่สุด รอบคอบ และนำไปส่งคำสั่งซื้อขายจริงได้ทันที:
 * 1. Backtest แปลงค่า Max Drawdown (%) เป็น 'จำนวนเงินบาทสูงสุดที่เคยหายไปในอดีต' อิงจากเงินต้นที่กรอก
 * 2. Dashboard & Rebalance สรุปคำแนะนำการปรับพอร์ตเป็น 'คำสั่งซื้อ/ขายที่เป็นยอดเงินบาทชัดเจน' (ขาย A กี่บาท -> ซื้อ B กี่บาท)
 */

const state = {
  tickers: ['NVDA', 'TSLA', 'AMZN', 'BTC-USD', 'AAPL'],
  tickerQuotes: {},
  activeGoal: 'max_sharpe',
  optData: null,
  growthLogScale: true,
  backtestChartMode: 'wealth', // 'wealth' | 'drawdown'
  currency: 'THB',
  currencySymbol: '฿',
  currencyUnitText: 'บาท',
  fxRate: 34.50,
  isFallbackFx: false,
  isFallbackRf: false,
  primaryMode: 'new_capital',    // 'new_capital' | 'existing_portfolio'
  rebalanceMode: 'cash',         // 'cash' | 'equal_weight' | 'custom'
  holdingsInputUnit: 'money',    // 'money' | 'shares'
  customHoldings: {},            // { ticker: amountInCurrency }
  customShares: {},              // { ticker: shareCount }
  customCashInjection: 0,
  executedOrders: {},
  useNewsAdjustment: true,
  lastRebalancePlan: null,
  searchDebounceTimer: null,
  activeTab: 'setup',
  tradePlanViewMode: 'cards',
  balancePrivacyHidden: false
};
window.state = state;

function escapeHtmlText(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeExternalUrl(url) {
  const raw = String(url ?? '').trim();
  if (/^https?:\/\//i.test(raw)) {
    return escapeHtmlText(raw);
  }
  return '#';
}

function getDefaultDateRange(yearsBack = 3) {
  const end = new Date();
  const start = new Date(end);
  start.setFullYear(end.getFullYear() - yearsBack);
  const toIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { start: toIso(start), end: toIso(end) };
}

const PRESETS = {
  colab_original: {
    tickers: ['NVDA', 'TSLA', 'AMZN', 'BTC-USD', 'AAPL'],
    get start() { return getDefaultDateRange(3).start; },
    get end() { return getDefaultDateRange(3).end; },
    currency: 'THB',
    budget: 100000
  },
  tech_titans: {
    tickers: ['NVDA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'TSLA'],
    get start() { return getDefaultDateRange(3).start; },
    get end() { return getDefaultDateRange(3).end; },
    currency: 'THB',
    budget: 100000
  },
  all_weather: {
    tickers: ['SPY', 'QQQ', 'GLD', 'TLT', 'DBC'],
    get start() { return getDefaultDateRange(3).start; },
    get end() { return getDefaultDateRange(3).end; },
    currency: 'THB',
    budget: 100000
  },
  thai_set50: {
    tickers: ['PTT.BK', 'AOT.BK', 'CPALL.BK', 'DELTA.BK', 'BDMS.BK'],
    get start() { return getDefaultDateRange(3).start; },
    get end() { return getDefaultDateRange(3).end; },
    currency: 'THB',
    budget: 100000
  }
};

// Dime! Obsidian Dark Mode vibrant financial color palette
const ASSET_COLORS = [
  '#00D084', '#38BDF8', '#F59E0B', '#A78BFA', '#F472B6',
  '#2DD4BF', '#FF5A5F', '#60A5FA', '#FBBF24', '#818CF8'
];

const STRATEGY_COLORS = {
  max_sharpe: '#00D084',
  min_volatility: '#38BDF8',
  hrp: '#A78BFA',
  equal_weight: '#94A3B8'
};

// Official Corporate Domain Map for Yahoo Finance / US / Global / Thai SET50 / Crypto Logo Resolution
const STOCK_DOMAIN_MAP = {
  // US & Global Equities
  'NVDA': 'nvidia.com', 'AAPL': 'apple.com', 'TSLA': 'tesla.com', 'AMZN': 'amazon.com',
  'MSFT': 'microsoft.com', 'GOOGL': 'google.com', 'GOOG': 'google.com', 'META': 'meta.com',
  'NFLX': 'netflix.com', 'AMD': 'amd.com', 'INTC': 'intel.com', 'AVGO': 'broadcom.com',
  'TSM': 'tsmc.com', 'ASML': 'asml.com', 'ORCL': 'oracle.com', 'CRM': 'salesforce.com',
  'ADBE': 'adobe.com', 'PLTR': 'palantir.com', 'UBER': 'uber.com', 'ABNB': 'airbnb.com',
  'SHOP': 'shopify.com', 'COIN': 'coinbase.com', 'BRK-B': 'berkshirehathaway.com',
  'JPM': 'jpmorganchase.com', 'V': 'visa.com', 'MA': 'mastercard.com', 'BAC': 'bankofamerica.com',
  'GS': 'goldmansachs.com', 'MS': 'morganstanley.com', 'JNJ': 'jnj.com', 'LLY': 'lilly.com',
  'UNH': 'unitedhealthgroup.com', 'PFE': 'pfizer.com', 'MRK': 'merck.com',
  'KO': 'coca-colacompany.com', 'PEP': 'pepsico.com', 'PG': 'pg.com', 'WMT': 'walmart.com',
  'COST': 'costco.com', 'MCD': 'mcdonalds.com', 'SBUX': 'starbucks.com', 'NKE': 'nike.com',
  'DIS': 'thewaltdisneycompany.com', 'XOM': 'exxonmobil.com', 'CVX': 'chevron.com',
  'BA': 'boeing.com', 'CAT': 'caterpillar.com', 'BABA': 'alibabagroup.com',
  // ETFs & Funds
  'SPY': 'ssga.com', 'QQQ': 'invesco.com', 'GLD': 'spdrgoldshares.com', 'TLT': 'ishares.com',
  'DBC': 'invesco.com', 'VOO': 'vanguard.com', 'VTI': 'vanguard.com', 'IVV': 'ishares.com',
  'SCHD': 'schwabassetmanagement.com', 'ARKK': 'ark-funds.com', 'IWM': 'ishares.com', 'DIA': 'ssga.com',
  // Crypto
  'BTC-USD': 'bitcoin.org', 'ETH-USD': 'ethereum.org', 'SOL-USD': 'solana.com',
  'BNB-USD': 'binance.com', 'XRP-USD': 'ripple.com', 'DOGE-USD': 'dogecoin.com', 'ADA-USD': 'cardano.org',
  // Thai SET50 / SET100 (.BK)
  'PTT.BK': 'pttplc.com', 'AOT.BK': 'airportthai.co.th', 'CPALL.BK': 'cpall.co.th',
  'DELTA.BK': 'deltathailand.com', 'BDMS.BK': 'bdms.co.th', 'ADVANC.BK': 'ais.th',
  'SCB.BK': 'scb.co.th', 'KBANK.BK': 'kasikornbank.com', 'BBL.BK': 'bangkokbank.com',
  'SCC.BK': 'scg.com', 'GULF.BK': 'gulf.co.th', 'PTTEP.BK': 'pttep.com',
  'TRUE.BK': 'true.th', 'CPN.BK': 'centralpattana.co.th', 'MINT.BK': 'minor.com',
  'BH.BK': 'bumrungrad.com', 'OR.BK': 'pttor.com', 'CRC.BK': 'centralretail.com',
  'HMPRO.BK': 'homepro.co.th', 'IVL.BK': 'indoramaventures.com', 'KTB.BK': 'krungthai.com',
  'TTB.BK': 'ttbbank.com', 'TISCO.BK': 'tisco.co.th', 'BEM.BK': 'bemplc.co.th',
  'BTS.BK': 'btsgroup.co.th', 'GPSC.BK': 'gpscgroup.com', 'EA.BK': 'energyabsolute.co.th',
  'BANPU.BK': 'banpu.com', 'TOP.BK': 'thaioilgroup.com', 'IRPC.BK': 'irpc.co.th',
  'PTTGC.BK': 'pttgcgroup.com', 'SCGP.BK': 'scgp.com', 'CPF.BK': 'cpfworldwide.com',
  'TU.BK': 'thaiunion.com', 'OSP.BK': 'osotspa.com', 'CBG.BK': 'carabao.co.th',
  'CENTEL.BK': 'centarahotelsresorts.com', 'AWC.BK': 'assetworldcorp-th.com',
  'LH.BK': 'lh.co.th', 'SIRI.BK': 'sansiri.com', 'WHA.BK': 'wha-group.com',
  'HANA.BK': 'hanagroup.com', 'KCE.BK': 'kce.co.th', 'COM7.BK': 'com7.com',
  'SAWAD.BK': 'risawad.com', 'MTC.BK': 'muangthaicap.com', 'TIDLOR.BK': 'tidlor.com',
  'KTC.BK': 'ktc.co.th', 'BGRIM.BK': 'bgrimmpower.com', 'RATCH.BK': 'ratch.co.th',
  'EGCO.BK': 'egco.com', 'INTUCH.BK': 'intouchcompany.com', 'GLOBAL.BK': 'globalhouse.co.th',
  'BJC.BK': 'bjc.co.th', 'CPAXT.BK': 'cpaxtra.com'
};

function getAssetLogoUrls(ticker) {
  const sym = String(ticker || '').trim().toUpperCase();
  const domain = STOCK_DOMAIN_MAP[sym];
  const domainFavicon = domain ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128` : '';

  if (sym.endsWith('.BK')) {
    const fmpBk = `https://financialmodelingprep.com/image-stock/${encodeURIComponent(sym)}.png`;
    return {
      primary: domainFavicon || fmpBk,
      secondary: domainFavicon ? fmpBk : ''
    };
  }

  if (sym.endsWith('-USD')) {
    const baseCoin = sym.replace('-USD', '');
    const fmpCrypto = `https://financialmodelingprep.com/image-stock/${encodeURIComponent(baseCoin + 'USD')}.png`;
    return {
      primary: fmpCrypto,
      secondary: domainFavicon || `https://assets.parqet.com/logos/symbol/${encodeURIComponent(baseCoin)}?format=png`
    };
  }

  const fmpStock = `https://financialmodelingprep.com/image-stock/${encodeURIComponent(sym)}.png`;
  return {
    primary: fmpStock,
    secondary: domainFavicon || `https://assets.parqet.com/logos/symbol/${encodeURIComponent(sym)}?format=png`
  };
}

function handleStockLogoError(imgEl) {
  if (!imgEl) return;
  const fallback = imgEl.getAttribute('data-fallback');
  if (fallback && imgEl.src !== fallback) {
    imgEl.removeAttribute('data-fallback');
    imgEl.src = fallback;
  } else {
    imgEl.style.display = 'none';
  }
}

function renderStockLogoBadge(ticker, fallbackColor = '#00D084', sizePx = 38) {
  const clean = String(ticker || '').trim().toUpperCase();
  const safeTicker = escapeHtmlText(clean);
  const shortCode = escapeHtmlText(clean.replace('.BK', '').replace('-USD', '').slice(0, 4));
  const { primary, secondary } = getAssetLogoUrls(clean);
  const fontSize = sizePx <= 30 ? '9.5px' : '11px';

  return `
    <div class="qf-stock-logo-wrap relative rounded-full overflow-hidden flex items-center justify-center shrink-0 shadow-2xs border border-white/15" style="width:${sizePx}px;height:${sizePx}px;background-color:${fallbackColor};">
      <span class="font-mono font-extrabold text-white select-none" style="font-size:${fontSize};letter-spacing:-0.02em;">${shortCode}</span>
      <img
        src="${primary}"
        data-fallback="${secondary}"
        alt="${safeTicker}"
        loading="lazy"
        onerror="handleStockLogoError(this)"
        class="qf-stock-logo-img absolute inset-0 w-full h-full object-contain bg-white p-1 rounded-full"
      />
    </div>
  `;
}

document.addEventListener('DOMContentLoaded', () => {
  let savedTheme = 'dark';
  try {
    savedTheme = localStorage.getItem('qf_theme') || 'dark';
  } catch (e) {}
  applyAppTheme(savedTheme, false);

  const defDates = getDefaultDateRange(3);
  const startInput = document.getElementById('start-date-input');
  const endInput = document.getElementById('end-date-input');
  if (startInput) startInput.value = defDates.start;
  if (endInput) endInput.value = defDates.end;

  if (window.lucide) {
    lucide.createIcons();
  }

  syncCurrencyToggleButtons();
  updateMaxWeightLabel(document.getElementById('max-weight-slider')?.value || 100);
  refreshAdvancedSummaryLabel();
  renderDimeWealthOverview();
  fetchLiveMarketRates();
  renderTickersList();
  fetchLiveQuotesForTickers();

  // Run initial portfolio calculation silently so Tabs 2-5 are ready immediately
  setTimeout(() => {
    runOptimization(false);
  }, 200);
});

function isDarkTheme() {
  return document.body.classList.contains('theme-dark');
}

function getChartThemeTokens() {
  const dark = isDarkTheme();
  return {
    dark,
    plotBg: dark ? 'rgba(17, 22, 32, 0.55)' : '#FFFFFF',
    grid: dark ? '#222B3B' : '#F1F5F9',
    line: dark ? '#2D374B' : '#E2E8F0',
    axisText: dark ? '#CBD5E1' : '#475569',
    legendText: dark ? '#E2E8F0' : '#334155',
    donutBorder: dark ? '#131822' : '#FFFFFF',
    donutLabel: dark ? '#E2E8F0' : '#1E293B',
    donutSub: dark ? '#94A3B8' : '#64748B',
    wfLine: dark ? '#FBBF24' : '#0F172A',
    corrScale: dark
      ? [[0.0, '#161D2B'], [0.5, '#0F4C5C'], [1.0, '#00D084']]
      : [[0.0, '#EFF6FF'], [0.5, '#DBEAFE'], [1.0, '#00A86B']],
    corrText: dark ? '#F8FAFC' : '#0F172A'
  };
}

function applyAppTheme(mode, reRenderCharts = true) {
  const dark = mode !== 'light';
  state.theme = dark ? 'dark' : 'light';
  document.body.classList.toggle('theme-dark', dark);
  try {
    localStorage.setItem('qf_theme', state.theme);
  } catch (e) {}

  const iconEl = document.getElementById('theme-toggle-icon');
  const labelEl = document.getElementById('theme-toggle-label');
  if (iconEl) {
    iconEl.setAttribute('data-lucide', dark ? 'sun' : 'moon');
    iconEl.className = dark ? 'w-4 h-4 text-amber-400' : 'w-4 h-4 text-slate-700';
  }
  if (labelEl) {
    labelEl.innerText = dark ? 'โหมดสว่าง' : 'โหมดมืด';
  }
  if (window.lucide) {
    lucide.createIcons();
  }

  if (reRenderCharts && state.optData) {
    const strat = state.optData.strategies?.[state.activeGoal];
    if (strat) renderDonutAllocationChart(strat.weights, state.optData.metadata?.tickers || []);
    renderPortfolioGrowthChart();
    renderEfficientFrontierPlot();
    renderCorrelationAndGrowthPlots();
    recalculateGoalProjection();
  }
}

function toggleAppTheme() {
  applyAppTheme(isDarkTheme() ? 'light' : 'dark', true);
}

function getCurrentCurrency() {
  return state.currency || 'THB';
}

// Parse numeric input safely even when formatted with commas (e.g. "100,000.50" -> 100000.5)
function parseNumericInput(val) {
  if (val === null || val === undefined) return 0;
  const cleaned = String(val).replace(/,/g, '').trim();
  if (!cleaned || cleaned === '-' || cleaned === '.') return 0;
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : 0;
}

// Format a numeric value with thousand-separator commas for input fields
function formatNumberWithCommas(val, maxDecimals = 2) {
  const num = Number(val);
  if (!Number.isFinite(num)) return '0';
  return num.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDecimals
  });
}

// Live comma formatting while the user is typing in an input field (preserves cursor & decimals)
function formatLiveCommaInput(inputEl, allowNegative = false) {
  if (!inputEl) return;
  const raw = inputEl.value;
  const selStart = inputEl.selectionStart ?? raw.length;

  // Count non-comma characters before the cursor so we can restore exact cursor position
  let nonCommaBeforeCursor = 0;
  for (let i = 0; i < selStart; i++) {
    if (raw[i] !== ',') nonCommaBeforeCursor++;
  }

  let isNeg = false;
  let cleaned = '';
  let hasDot = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (allowNegative && ch === '-' && cleaned.length === 0 && !isNeg) {
      isNeg = true;
    } else if (ch >= '0' && ch <= '9') {
      cleaned += ch;
    } else if (ch === '.' && !hasDot) {
      hasDot = true;
      cleaned += '.';
    }
  }

  if (!cleaned) {
    inputEl.value = isNeg ? '-' : '';
    return;
  }

  const parts = cleaned.split('.');
  let intPart = parts[0].replace(/^0+(?=\d)/, '');
  if (!intPart && hasDot) intPart = '0';
  const formattedInt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const decPart = parts.length > 1 ? '.' + parts[1].slice(0, 4) : '';
  const finalStr = (isNeg ? '-' : '') + formattedInt + decPart;

  inputEl.value = finalStr;

  // Restore cursor position accurately
  let newCursorPos = 0;
  let seenNonComma = 0;
  while (newCursorPos < finalStr.length && seenNonComma < nonCommaBeforeCursor) {
    if (finalStr[newCursorPos] !== ',') {
      seenNonComma++;
    }
    newCursorPos++;
  }
  try {
    inputEl.setSelectionRange(newCursorPos, newCursorPos);
  } catch (e) {}
}

// Format number as currency with clear unit
function formatMoney(amount, decimals = 2, showUnitWord = false) {
  const num = Number(amount) || 0;
  const formatted = num.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
  if (showUnitWord) {
    return `${formatted} ${state.currencyUnitText}`;
  }
  return `${state.currencySymbol}${formatted}`;
}

async function fetchLiveMarketRates() {
  try {
    const res = await fetch('/api/rf');
    if (res.ok) {
      const data = await res.json();
      state.isFallbackRf = !!data.is_fallback_rf;
      state.isFallbackFx = !!data.is_fallback_fx;
      const rfEl = document.getElementById('top-rf-rate');
      if (rfEl && data.percentage) {
        rfEl.innerText = data.is_fallback_rf ? `${data.percentage} (ค่าสำรอง)` : data.percentage;
      }
      if (data.usd_thb_rate) {
        state.fxRate = Number(data.usd_thb_rate);
        const fxInput = document.getElementById('fx-rate-input');
        if (fxInput) fxInput.value = state.fxRate.toFixed(2);
        const topFx = document.getElementById('top-fx-rate');
        if (topFx) {
          topFx.innerText = data.is_fallback_fx
            ? `${state.fxRate.toFixed(2)} บาท/$ (ค่าสำรอง)`
            : `${state.fxRate.toFixed(2)} บาท/$`;
        }
        refreshAdvancedSummaryLabel();
      }
    }
  } catch (e) {
    console.warn('Market rate fetch notice:', e);
  }
}

function handleFxRateChange() {
  const val = parseNumericInput(document.getElementById('fx-rate-input').value);
  if (val && val >= 15 && val <= 100) {
    state.fxRate = val;
    const topFx = document.getElementById('top-fx-rate');
    if (topFx) topFx.innerText = `${state.fxRate.toFixed(2)} บาท/$`;
    refreshAdvancedSummaryLabel();
    renderTickersList();
    if (state.optData) {
      renderAllViews();
    }
  }
}

function syncStripBudgetToMain(rawVal) {
  const mainInput = document.getElementById('budget-input');
  if (mainInput) mainInput.value = rawVal;
  handleBudgetQuickUpdate();
}

function setQuickBudget(amount) {
  const input = document.getElementById('budget-input');
  const formatted = formatNumberWithCommas(amount, 0);
  if (input) input.value = formatted;
  const stripInput = document.getElementById('strip-budget-input');
  if (stripInput) stripInput.value = formatted;
  handleBudgetQuickUpdate();
}

function handleBudgetQuickUpdate() {
  const mainEl = document.getElementById('budget-input');
  const stripEl = document.getElementById('strip-budget-input');
  const budget = parseNumericInput(mainEl?.value) || 100000;
  if (stripEl && mainEl && document.activeElement !== stripEl) {
    stripEl.value = mainEl.value;
  }
  if (!state.optData || budget < 10) return;

  const oldBudget = state.optData.metadata.budget || 100000;
  const ratio = oldBudget > 0 ? budget / oldBudget : 1;

  state.optData.metadata.budget = budget;

  // Dynamically scale all monetary metrics in optData so UI updates at 0ms latency
  Object.keys(state.optData.strategies).forEach(k => {
    const s = state.optData.strategies[k];
    const mddPct = Math.abs(s.max_drawdown || 0);
    s.expected_annual_profit = Number((s.expected_return * budget).toFixed(2));
    s.max_drawdown_amount = Number((mddPct * budget).toFixed(2));
    s.min_capital_remaining = Number(Math.max(0, budget - s.max_drawdown_amount).toFixed(2));
    if (s.drawdown_details) {
      s.drawdown_details.max_drawdown_amount = s.max_drawdown_amount;
      s.drawdown_details.min_capital_remaining = s.min_capital_remaining;
      s.drawdown_details.peak_value = Number((s.drawdown_details.peak_value * ratio).toFixed(2));
      s.drawdown_details.trough_value = Number((s.drawdown_details.trough_value * ratio).toFixed(2));
      s.drawdown_details.peak_to_trough_amount = Number((s.drawdown_details.peak_to_trough_amount * ratio).toFixed(2));
    }
    s.final_historical_value = Number((s.final_historical_value * ratio).toFixed(2));
  });

  if (state.optData.portfolio_growth) {
    Object.keys(state.optData.portfolio_growth.series).forEach(k => {
      state.optData.portfolio_growth.series[k] = state.optData.portfolio_growth.series[k].map(v => Number((v * ratio).toFixed(2)));
    });
    if (state.optData.portfolio_growth.drawdown_amount_series) {
      Object.keys(state.optData.portfolio_growth.drawdown_amount_series).forEach(k => {
        state.optData.portfolio_growth.drawdown_amount_series[k] = state.optData.portfolio_growth.drawdown_amount_series[k].map(v => Number((v * ratio).toFixed(2)));
      });
    }
  }

  (state.optData.asset_stats || []).forEach(a => {
    const mddPct = Math.abs(a.max_drawdown || 0);
    a.max_drawdown_amount = Number((mddPct * budget).toFixed(2));
    a.min_capital_remaining = Number(Math.max(0, budget - a.max_drawdown_amount).toFixed(2));
  });

  renderAllViews();
}

// Preset Selection
function applyPreset(presetKey) {
  const p = PRESETS[presetKey];
  if (!p) return;

  state.tickers = [...p.tickers];
  if (p.start) document.getElementById('start-date-input').value = p.start;
  if (p.end) document.getElementById('end-date-input').value = p.end;

  if (p.currency) {
    const sel = document.getElementById('currency-select');
    if (sel) sel.value = p.currency;
    updateCurrencySymbol(false);
  }
  if (p.budget) {
    const formattedBudget = formatNumberWithCommas(p.budget, 0);
    const budgetEl = document.getElementById('budget-input');
    const stripBudgetEl = document.getElementById('strip-budget-input');
    if (budgetEl) budgetEl.value = formattedBudget;
    if (stripBudgetEl) stripBudgetEl.value = formattedBudget;
  }

  // Highlight active timeframe (3Y)
  document.querySelectorAll('.tf-btn').forEach(b => {
    b.className = 'tf-btn px-1.5 py-0.5 rounded bg-white border border-slate-200 text-slate-600 hover:bg-slate-100 font-medium cursor-pointer';
  });
  const btn3Y = document.getElementById('tf-btn-3Y');
  if (btn3Y) {
    btn3Y.className = 'tf-btn px-1.5 py-0.5 rounded bg-slate-900 text-white font-semibold cursor-pointer';
  }

  // Highlight active preset button
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.className = 'preset-btn px-2.5 py-1 text-xs rounded-lg bg-white hover:bg-slate-50 text-slate-700 font-medium border border-slate-200 transition cursor-pointer';
  });
  const activeBtn = document.getElementById(`preset-btn-${presetKey}`);
  if (activeBtn) {
    activeBtn.className = 'preset-btn px-2.5 py-1 text-xs rounded-lg bg-blue-50 text-blue-700 font-semibold border border-blue-200 transition cursor-pointer';
  }

  renderTickersList();
  updateMaxWeightLabel(document.getElementById('max-weight-slider')?.value || 100);
  refreshAdvancedSummaryLabel();
  fetchLiveQuotesForTickers();
  runOptimization(false);
}

// Timeframe buttons
function setTimeframe(tf, btnEl) {
  const yearsMap = { '1Y': 1, '3Y': 3, '4Y': 4, '5Y': 5 };
  const years = yearsMap[tf] || 3;
  const range = getDefaultDateRange(years);

  document.getElementById('end-date-input').value = range.end;
  document.getElementById('start-date-input').value = range.start;

  document.querySelectorAll('.tf-btn').forEach(b => {
    b.className = 'tf-btn px-1.5 py-0.5 rounded bg-white border border-slate-200 text-slate-600 hover:bg-slate-100 font-medium cursor-pointer';
  });
  if (btnEl) {
    btnEl.className = 'tf-btn px-1.5 py-0.5 rounded bg-slate-900 text-white font-semibold cursor-pointer';
  }
  refreshAdvancedSummaryLabel();
}

// Max Weight Controls
function updateMaxWeightLabel(val) {
  const num = parseInt(val, 10);
  const label = document.getElementById('max-weight-val');
  if (label) {
    label.innerText = num >= 100 ? 'ไม่จำกัด (100%)' : `ไม่เกิน ${num}% ต่อตัว`;
  }
  const hint = document.getElementById('max-weight-feasibility-hint');
  if (hint) {
    const count = Math.max(1, (state.tickers || []).length);
    if ((num / 100) * count < 0.9999) {
      const minPct = Math.ceil(100 / count);
      hint.innerText = `คำเตือน: ${count} หุ้นต้องตั้งเพดานอย่างน้อย ${minPct}% จึงจะรวมครบ 100%`;
      hint.className = 'text-[10px] text-rose-700 font-bold pt-0.5';
    } else if (num < 100) {
      hint.innerText = `กระจายขั้นต่ำ ${(100 / num).toFixed(1)} ตัว (ผ่านเงื่อนไข ${count} หุ้น)`;
      hint.className = 'text-[10px] text-emerald-700 font-medium pt-0.5';
    } else {
      hint.innerText = 'เพดานสูงสุดต่อสินทรัพย์ 1 ตัว (ปรับอิสระ)';
      hint.className = 'text-[10px] text-slate-500 pt-0.5';
    }
  }
  refreshAdvancedSummaryLabel();
}

function setMaxWeight(val) {
  const slider = document.getElementById('max-weight-slider');
  slider.value = val;
  updateMaxWeightLabel(val);
}

// Global Currency Switcher (THB <-> USD) with instant conversion
function setGlobalCurrency(targetCurr) {
  const sel = document.getElementById('currency-select');
  if (sel) {
    sel.value = targetCurr;
  }
  updateCurrencySymbol(false);
}

function syncCurrencyToggleButtons() {
  const isThb = state.currency === 'THB';
  const pairs = [
    ['header-curr-thb', 'header-curr-usd', 'px-2.5 py-1 text-xs font-bold rounded-md bg-slate-900 text-white shadow-2xs transition cursor-pointer', 'px-2.5 py-1 text-xs font-semibold rounded-md text-slate-600 hover:text-slate-900 transition cursor-pointer']
  ];

  pairs.forEach(([thbId, usdId, activeCls, inactiveCls]) => {
    const btnThb = document.getElementById(thbId);
    const btnUsd = document.getElementById(usdId);
    if (btnThb && btnUsd) {
      btnThb.className = isThb ? activeCls : inactiveCls;
      btnUsd.className = !isThb ? activeCls : inactiveCls;
    }
  });

  const stripSym = document.getElementById('strip-curr-symbol');
  if (stripSym) stripSym.innerText = state.currencySymbol;

  document.querySelectorAll('.curr-unit-inline').forEach(el => {
    el.innerText = state.currencyUnitText;
  });
}

function updateCurrencySymbol(reRun = false) {
  const sel = document.getElementById('currency-select');
  const prevCurrency = state.currency;
  const nextCurrency = sel ? sel.value : 'THB';
  state.currency = nextCurrency;

  if (nextCurrency === 'THB') {
    state.currencySymbol = '฿';
    state.currencyUnitText = 'บาท';
  } else {
    state.currencySymbol = '$';
    state.currencyUnitText = 'USD';
  }

  const symEl = document.getElementById('currency-symbol');
  if (symEl) symEl.innerText = state.currencySymbol;
  syncCurrencyToggleButtons();

  // Convert budget & custom holdings proportionally when switching between THB and USD
  const fx = state.fxRate > 0 ? state.fxRate : 34.50;
  if (prevCurrency !== nextCurrency) {
    const convFactor = nextCurrency === 'USD' ? (1.0 / fx) : fx;
    const budgetEl = document.getElementById('budget-input');
    if (budgetEl) {
      const curBudget = parseNumericInput(budgetEl.value) || 100000;
      const newBudget = nextCurrency === 'USD'
        ? Math.round((curBudget * convFactor) * 100) / 100
        : Math.round(curBudget * convFactor);
      const formattedNew = formatNumberWithCommas(newBudget, nextCurrency === 'USD' ? 2 : 0);
      budgetEl.value = formattedNew;
      const stripEl = document.getElementById('strip-budget-input');
      if (stripEl) stripEl.value = formattedNew;
    }

    Object.keys(state.customHoldings).forEach(t => {
      state.customHoldings[t] = Math.round((Number(state.customHoldings[t]) || 0) * convFactor * 100) / 100;
    });
    state.customCashInjection = Math.round((Number(state.customCashInjection) || 0) * convFactor * 100) / 100;
    const cashInEl = document.getElementById('custom-cash-injection');
    if (cashInEl) cashInEl.value = formatNumberWithCommas(state.customCashInjection, 2);

    const targetEl = document.getElementById('save-target-amount');
    if (targetEl) {
      const curTarget = parseNumericInput(targetEl.value) || 1000000;
      const newTarget = Math.round(curTarget * convFactor);
      targetEl.value = formatNumberWithCommas(newTarget, 0);
    }
    const dcaEl = document.getElementById('save-monthly-dca');
    if (dcaEl) {
      const curDca = parseNumericInput(dcaEl.value) || 0;
      const newDca = Math.round(curDca * convFactor);
      dcaEl.value = formatNumberWithCommas(newDca, 0);
    }
  }

  renderTickersList();
  renderDimeWealthOverview();

  if (state.optData) {
    // Update latest_price in asset_stats to match selected currency
    (state.optData.asset_stats || []).forEach(a => {
      if (state.currency === 'THB') {
        a.latest_price = a.price_thb !== undefined ? a.price_thb : (a.native_currency === 'THB' ? a.native_price : Number((a.native_price * fx).toFixed(2)));
      } else {
        a.latest_price = a.price_usd !== undefined ? a.price_usd : (a.native_currency === 'USD' ? a.native_price : Number((a.native_price / fx).toFixed(2)));
      }
    });
    handleBudgetQuickUpdate();
    recalculateGoalProjection();
  } else if (reRun) {
    runOptimization(false);
  }
}

// Primary Investment Mode Selector ('new_capital' vs 'existing_portfolio' vs 'goal_based')
function selectPrimaryInvestmentMode(modeKey) {
  state.primaryMode = modeKey;

  const modes = [
    {
      key: 'new_capital',
      activeCard: 'cursor-pointer rounded-2xl p-4 border-2 border-emerald-500 bg-emerald-50/40 hover:bg-emerald-50/70 transition flex flex-col justify-between gap-1.5 shadow-2xs',
      inactiveCard: 'cursor-pointer rounded-2xl p-4 border border-slate-200 bg-white hover:bg-slate-50 transition flex flex-col justify-between gap-1.5',
      activeBadge: 'px-2.5 py-0.5 rounded-full bg-emerald-600 text-white text-[11px] font-bold shrink-0'
    },
    {
      key: 'existing_portfolio',
      activeCard: 'cursor-pointer rounded-2xl p-4 border-2 border-blue-600 bg-blue-50/40 hover:bg-blue-50/70 transition flex flex-col justify-between gap-1.5 shadow-2xs',
      inactiveCard: 'cursor-pointer rounded-2xl p-4 border border-slate-200 bg-white hover:bg-slate-50 transition flex flex-col justify-between gap-1.5',
      activeBadge: 'px-2.5 py-0.5 rounded-full bg-blue-600 text-white text-[11px] font-bold shrink-0'
    },
    {
      key: 'goal_based',
      activeCard: 'cursor-pointer rounded-2xl p-4 border-2 border-indigo-600 bg-indigo-50/50 hover:bg-indigo-50/80 transition flex flex-col justify-between gap-1.5 shadow-2xs',
      inactiveCard: 'cursor-pointer rounded-2xl p-4 border border-slate-200 bg-white hover:bg-indigo-50/40 transition flex flex-col justify-between gap-1.5',
      activeBadge: 'px-2.5 py-0.5 rounded-full bg-indigo-600 text-white text-[11px] font-bold shrink-0'
    }
  ];

  modes.forEach(m => {
    const card = document.getElementById(`primary-mode-card-${m.key}`);
    const badge = document.getElementById(`primary-mode-badge-${m.key}`);
    const isSelected = m.key === modeKey;
    if (card) card.className = isSelected ? m.activeCard : m.inactiveCard;
    if (badge) {
      badge.className = isSelected ? m.activeBadge : 'px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-600 text-[11px] font-semibold shrink-0';
      badge.innerText = isSelected ? 'กำลังเลือก' : 'คลิกเลือก';
    }
  });

  if (modeKey === 'new_capital') {
    setRebalanceMode('cash');
    if (state.activeTab !== 'setup') switchAppTab('trade-plan');
  } else if (modeKey === 'existing_portfolio') {
    setRebalanceMode('custom');
    switchAppTab('trade-plan');
    setTimeout(() => {
      const customPanel = document.getElementById('custom-holdings-panel');
      if (customPanel) {
        customPanel.classList.remove('hidden');
        customPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 80);
  } else if (modeKey === 'goal_based') {
    setRebalanceMode('cash');
    switchAppTab('goals');
  }
}

// Goal Selection (Instant reactive update)
function selectGoal(goalKey) {
  state.activeGoal = goalKey;

  ['max_sharpe', 'min_volatility', 'hrp', 'equal_weight'].forEach(k => {
    const card = document.getElementById(`goal-card-${k}`);
    if (card) {
      if (k === goalKey) card.classList.add('active');
      else card.classList.remove('active');
    }
    const pill = document.getElementById(`top-pill-${k}`);
    if (pill) {
      if (k === goalKey) {
        pill.className = 'top-goal-pill px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-[#00D084] text-[#1A1D1F] transition cursor-pointer';
      } else {
        pill.className = 'top-goal-pill px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-slate-300 hover:text-white transition cursor-pointer';
      }
    }
  });

  if (state.optData) {
    renderActiveGoalView();
    renderDimeWealthOverview();
    renderNewsAndSignalSection();
    renderBacktestStressCard();
    renderStrategyCompareTable();
    renderPortfolioGrowthChart();
    renderAssetStatsTable();
    recalculateGoalProjection();
  }
}

// Rebalance Mode Switcher ('equal_weight' | 'custom' | 'cash')
function setRebalanceMode(mode) {
  state.rebalanceMode = mode;

  const btnMap = {
    equal_weight: 'rebal-mode-equal',
    custom: 'rebal-mode-custom',
    cash: 'rebal-mode-cash'
  };

  Object.entries(btnMap).forEach(([k, id]) => {
    const el = document.getElementById(id);
    if (el) {
      if (k === mode) el.classList.add('active');
      else el.classList.remove('active');
    }
  });

  const customPanel = document.getElementById('custom-holdings-panel');
  if (customPanel) {
    if (mode === 'custom') {
      customPanel.classList.remove('hidden');
      initCustomHoldingsIfEmpty();
      renderCustomHoldingsInputs();
    } else {
      customPanel.classList.add('hidden');
    }
  }

  renderActiveGoalView();
}

function initCustomHoldingsIfEmpty() {
  if (!state.optData) return;
  const tickers = state.optData.metadata.tickers || [];
  const budget = state.optData.metadata.budget || 100000;
  const hasAny = tickers.some(t => state.customHoldings[t] !== undefined);
  if (!hasAny && tickers.length > 0) {
    const perAsset = Math.round((budget / tickers.length) * 100) / 100;
    tickers.forEach(t => {
      state.customHoldings[t] = perAsset;
      const p = getAssetPriceInCurrentCurrency(t);
      state.customShares[t] = p > 0 ? Number((perAsset / p).toFixed(4)) : 0;
    });
  }
}

function getAssetPriceInCurrentCurrency(ticker) {
  const fx = state.fxRate > 0 ? state.fxRate : 34.50;
  const stat = (state.optData?.asset_stats || []).find(a => a.ticker === ticker);
  if (stat) {
    if (state.currency === 'THB') {
      return stat.price_thb !== undefined ? stat.price_thb : (stat.native_currency === 'THB' ? stat.native_price : Number((stat.native_price * fx).toFixed(2)));
    } else {
      return stat.price_usd !== undefined ? stat.price_usd : (stat.native_currency === 'USD' ? stat.native_price : Number((stat.native_price / fx).toFixed(2)));
    }
  }
  const q = state.tickerQuotes[ticker];
  if (q && q.price !== undefined) {
    const isThai = ticker.endsWith('.BK');
    if (state.currency === 'THB') {
      return isThai ? q.price : Number((q.price * fx).toFixed(2));
    } else {
      return isThai ? Number((q.price / fx).toFixed(2)) : q.price;
    }
  }
  return 1;
}

function setHoldingsInputUnit(unit) {
  state.holdingsInputUnit = unit;
  const btnMoney = document.getElementById('holdings-unit-btn-money');
  const btnShares = document.getElementById('holdings-unit-btn-shares');
  if (btnMoney && btnShares) {
    if (unit === 'money') {
      btnMoney.className = 'px-2.5 py-1 rounded-md font-bold bg-slate-900 text-white transition';
      btnShares.className = 'px-2.5 py-1 rounded-md font-semibold text-slate-700 hover:text-slate-900 transition';
    } else {
      btnShares.className = 'px-2.5 py-1 rounded-md font-bold bg-slate-900 text-white transition';
      btnMoney.className = 'px-2.5 py-1 rounded-md font-semibold text-slate-700 hover:text-slate-900 transition';
    }
  }

  // Sync shares from money when switching to shares mode
  if (state.optData) {
    (state.optData.metadata.tickers || []).forEach(t => {
      const p = getAssetPriceInCurrentCurrency(t);
      const val = Number(state.customHoldings[t]) || 0;
      state.customShares[t] = p > 0 ? Number((val / p).toFixed(4)) : 0;
    });
  }

  renderCustomHoldingsInputs();
  renderActiveGoalView();
}

function prefillCustomHoldings(sourceType) {
  if (!state.optData) return;
  const tickers = state.optData.metadata.tickers || [];
  const budget = state.optData.metadata.budget || 100000;

  if (sourceType === 'zero') {
    tickers.forEach(t => {
      state.customHoldings[t] = 0;
      state.customShares[t] = 0;
    });
    state.customCashInjection = budget;
    const cashInEl = document.getElementById('custom-cash-injection');
    if (cashInEl) cashInEl.value = formatNumberWithCommas(budget, 2);
  } else {
    const strat = state.optData.strategies[sourceType];
    if (strat) {
      tickers.forEach(t => {
        const w = strat.weights[t] || 0;
        const amt = Math.round(budget * w * 100) / 100;
        state.customHoldings[t] = amt;
        const p = getAssetPriceInCurrentCurrency(t);
        state.customShares[t] = p > 0 ? Number((amt / p).toFixed(4)) : 0;
      });
      state.customCashInjection = 0;
      const cashInEl = document.getElementById('custom-cash-injection');
      if (cashInEl) cashInEl.value = '0';
    }
  }

  renderCustomHoldingsInputs();
  renderActiveGoalView();
}

function renderCustomHoldingsInputs() {
  if (!state.optData) return;
  const container = document.getElementById('custom-holdings-inputs');
  if (!container) return;

  const tickers = state.optData.metadata.tickers || [];
  const isSharesMode = state.holdingsInputUnit === 'shares';

  container.innerHTML = tickers.map((t, idx) => {
    const color = ASSET_COLORS[idx % ASSET_COLORS.length];
    const price = getAssetPriceInCurrentCurrency(t);
    const moneyVal = state.customHoldings[t] !== undefined ? state.customHoldings[t] : 0;
    const sharesVal = state.customShares[t] !== undefined
      ? state.customShares[t]
      : (price > 0 ? Number((moneyVal / price).toFixed(4)) : 0);

    const inputVal = isSharesMode ? formatNumberWithCommas(sharesVal, 4) : formatNumberWithCommas(moneyVal, 2);
    const unitPrefix = isSharesMode ? 'หุ้น' : state.currencySymbol;
    const subComputedText = isSharesMode
      ? `คิดเป็น ${formatMoney(moneyVal, 2, false)} (@${formatMoney(price, 2, false)})`
      : `ประมาณ ${formatNumberWithCommas(sharesVal, 4)} หุ้น (@${formatMoney(price, 2, false)})`;

    return `
      <div class="p-2.5 rounded-lg bg-white border border-slate-200 flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background-color: ${color}"></span>
          <div class="truncate">
            <div class="text-xs font-bold font-mono text-slate-900">${t}</div>
            <div class="text-[10px] text-slate-500 truncate" id="custom-sub-${t}">${subComputedText}</div>
          </div>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <span class="text-[11px] font-mono text-slate-400">${unitPrefix}</span>
          <input
            type="text"
            inputmode="decimal"
            value="${inputVal}"
            data-ticker="${t}"
            oninput="formatLiveCommaInput(this, false); handleCustomHoldingInput(this)"
            class="w-28 px-2 py-1 text-xs font-mono font-bold text-right bg-slate-50 border border-slate-300 rounded text-slate-900 focus:bg-white focus:outline-none focus:border-blue-600"
          />
        </div>
      </div>
    `;
  }).join('');

  updateCustomTotalPortfolioLabel();
}

function handleCustomHoldingInput(inputEl) {
  const ticker = inputEl.getAttribute('data-ticker');
  const rawVal = Math.max(0, parseNumericInput(inputEl.value));
  const price = getAssetPriceInCurrentCurrency(ticker);

  if (state.holdingsInputUnit === 'shares') {
    state.customShares[ticker] = rawVal;
    state.customHoldings[ticker] = Number((rawVal * price).toFixed(2));
  } else {
    state.customHoldings[ticker] = rawVal;
    state.customShares[ticker] = price > 0 ? Number((rawVal / price).toFixed(4)) : 0;
  }

  const subEl = document.getElementById(`custom-sub-${ticker}`);
  if (subEl) {
    subEl.innerText = state.holdingsInputUnit === 'shares'
      ? `คิดเป็น ${formatMoney(state.customHoldings[ticker], 2, false)} (@${formatMoney(price, 2, false)})`
      : `ประมาณ ${formatNumberWithCommas(state.customShares[ticker], 4)} หุ้น (@${formatMoney(price, 2, false)})`;
  }

  updateCustomTotalPortfolioLabel();
  renderActiveGoalView();
}

function syncExistingPortfolioToMainBudget() {
  if (!state.optData) return;
  const tickers = state.optData.metadata.tickers || [];
  const sumHoldings = tickers.reduce((acc, t) => acc + (Number(state.customHoldings[t]) || 0), 0);
  const total = Math.max(10, Math.round((sumHoldings + (Number(state.customCashInjection) || 0)) * 100) / 100);
  const budgetEl = document.getElementById('budget-input');
  if (budgetEl) {
    budgetEl.value = formatNumberWithCommas(total, state.currency === 'USD' ? 2 : 0);
    handleBudgetQuickUpdate();
  }
}

function recalculateRebalanceFromCustom() {
  const cashIn = parseNumericInput(document.getElementById('custom-cash-injection').value);
  state.customCashInjection = cashIn;
  updateCustomTotalPortfolioLabel();
  renderActiveGoalView();
}

function updateCustomTotalPortfolioLabel() {
  if (!state.optData) return;
  const tickers = state.optData.metadata.tickers || [];
  const sumHoldings = tickers.reduce((acc, t) => acc + (Number(state.customHoldings[t]) || 0), 0);
  const total = Math.max(0, sumHoldings + (Number(state.customCashInjection) || 0));
  const el = document.getElementById('custom-total-portfolio-val');
  if (el) {
    el.innerText = formatMoney(total, 2, true);
  }
}

// Selected Tickers List in Left Sidebar (Shows both THB and USD prices clearly)
function renderTickersList() {
  const container = document.getElementById('selected-tickers-container');
  document.getElementById('asset-count').innerText = state.tickers.length;

  if (state.tickers.length === 0) {
    container.innerHTML = `
      <div class="p-4 text-center text-xs text-slate-400">
        ยังไม่มีสินทรัพย์ในพอร์ต กรุณาค้นหาและเพิ่มอย่างน้อย 2 รายการ
      </div>
    `;
    return;
  }

  const fx = state.fxRate > 0 ? state.fxRate : 34.50;

  container.innerHTML = state.tickers.map((ticker, idx) => {
    const q = state.tickerQuotes[ticker] || {};
    const name = q.name || ticker;
    const isThai = ticker.endsWith('.BK');
    let primaryPrice = 'กำลังดึงราคา...';
    let secondaryPrice = '';

    if (q.price !== undefined) {
      const pThb = isThai ? q.price : (q.price * fx);
      const pUsd = isThai ? (q.price / fx) : q.price;
      const thbStr = `฿${pThb.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const usdStr = `$${pUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

      if (state.currency === 'THB') {
        primaryPrice = thbStr;
        secondaryPrice = usdStr;
      } else {
        primaryPrice = usdStr;
        secondaryPrice = thbStr;
      }
    }

    const isUp = (q.change_pct || 0) >= 0;
    const chgColor = isUp ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-rose-700 bg-rose-50 border-rose-200';
    const chgSign = isUp ? '+' : '';
    const chgBadge = q.change_pct !== undefined
      ? `<span class="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded border ${chgColor}">${chgSign}${q.change_pct.toFixed(2)}%</span>`
      : '';

    const safeTicker = escapeHtmlText(ticker);
    const safeName = escapeHtmlText(name !== ticker ? name : (isThai ? 'หุ้นไทย (SET)' : 'Global Asset'));
    const avatarBg = ASSET_COLORS[idx % ASSET_COLORS.length];
    return `
      <div class="px-3.5 py-2.5 flex items-center justify-between gap-3 hover:bg-slate-50/90 transition">
        <div class="flex items-center gap-3 min-w-0">
          ${renderStockLogoBadge(ticker, avatarBg, 38)}
          <div class="min-w-0">
            <div class="flex items-center gap-1.5">
              <span class="font-extrabold text-sm font-mono text-slate-900 tracking-tight">${safeTicker}</span>
              ${chgBadge}
            </div>
            <div class="text-xs text-slate-500 truncate max-w-[180px] sm:max-w-[240px]">${safeName}</div>
          </div>
        </div>
        <div class="flex items-center gap-2.5 shrink-0">
          <div class="text-right leading-tight">
            <div class="font-mono text-sm sm:text-[15px] font-extrabold text-slate-900 tracking-tight">${primaryPrice}</div>
            ${secondaryPrice ? `<div class="font-mono text-[11px] text-slate-400 mt-0.5">${secondaryPrice}</div>` : ''}
          </div>
          <button data-ticker="${safeTicker}" onclick="removeTicker(this.dataset.ticker)" title="ลบออก" class="text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg p-1.5 transition cursor-pointer">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
          </button>
        </div>
      </div>
    `;
  }).join('');
  renderDimeWealthOverview();
}

async function fetchLiveQuotesForTickers() {
  if (state.tickers.length === 0) return;
  try {
    const res = await fetch(`/api/quote?tickers=${encodeURIComponent(state.tickers.join(','))}`);
    if (res.ok) {
      const data = await res.json();
      if (data.usd_thb_rate) {
        state.fxRate = Number(data.usd_thb_rate);
        const fxInput = document.getElementById('fx-rate-input');
        if (fxInput) fxInput.value = state.fxRate.toFixed(2);
      }
      if (data.quotes) {
        state.tickerQuotes = { ...state.tickerQuotes, ...data.quotes };
        renderTickersList();
      }
    }
  } catch (e) {
    console.warn('Live quotes warning:', e);
  }
}

function addTicker(symbol) {
  const clean = symbol.trim().toUpperCase();
  if (!clean) return;
  if (!state.tickers.includes(clean)) {
    state.tickers.push(clean);
    renderTickersList();
    updateMaxWeightLabel(document.getElementById('max-weight-slider')?.value || 100);
    fetchLiveQuotesForTickers();
  }
  document.getElementById('ticker-search-input').value = '';
  hideSearchDropdown();
}

function addTickerFromInput() {
  addTicker(document.getElementById('ticker-search-input').value);
}

function removeTicker(symbol) {
  state.tickers = state.tickers.filter(t => t !== symbol);
  renderTickersList();
  updateMaxWeightLabel(document.getElementById('max-weight-slider')?.value || 100);
}

function clearAllTickers() {
  state.tickers = [];
  renderTickersList();
  updateMaxWeightLabel(document.getElementById('max-weight-slider')?.value || 100);
}

// Search & Autocomplete
function handleSearchInput(e) {
  const query = e.target.value.trim();
  clearTimeout(state.searchDebounceTimer);

  if (!query) {
    hideSearchDropdown();
    return;
  }

  state.searchDebounceTimer = setTimeout(async () => {
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      if (res.ok) {
        const data = await res.json();
        renderSearchDropdown(data.results || []);
      }
    } catch (err) {
      console.warn('Search error:', err);
    }
  }, 220);
}

function handleSearchKeyDown(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    addTickerFromInput();
  } else if (e.key === 'Escape') {
    hideSearchDropdown();
  }
}

function renderSearchDropdown(results) {
  const dd = document.getElementById('search-dropdown');
  if (!results || results.length === 0) {
    dd.innerHTML = `<div class="p-3 text-xs text-slate-400 text-center">ไม่พบชื่อย่อหุ้นที่ค้นหา</div>`;
    dd.classList.remove('hidden');
    return;
  }

  dd.innerHTML = results.map((r, idx) => {
    const sym = escapeHtmlText(r.symbol);
    const type = escapeHtmlText(r.type || 'EQUITY');
    const exch = escapeHtmlText(r.exchange || '');
    const name = escapeHtmlText(r.name || '');
    const logoBadge = renderStockLogoBadge(r.symbol, ASSET_COLORS[idx % ASSET_COLORS.length], 30);
    return `
    <div
      data-symbol="${sym}"
      onclick="addTicker(this.dataset.symbol)"
      class="px-3 py-2 hover:bg-blue-50/60 cursor-pointer flex items-center justify-between transition"
    >
      <div class="flex items-center gap-2.5 min-w-0 pr-2">
        ${logoBadge}
        <div class="min-w-0">
          <div class="flex items-center gap-1.5">
            <span class="font-bold text-xs font-mono text-blue-700">${sym}</span>
            <span class="text-[10px] px-1.5 py-0.2 rounded bg-slate-100 text-slate-600 font-medium">${type}</span>
            <span class="text-[10px] text-slate-400">${exch}</span>
          </div>
          <div class="text-[11px] text-slate-600 truncate">${name}</div>
        </div>
      </div>
      <span class="text-xs text-blue-700 font-semibold shrink-0">+ เพิ่ม</span>
    </div>
  `;
  }).join('');

  dd.classList.remove('hidden');
}

function hideSearchDropdown() {
  document.getElementById('search-dropdown').classList.add('hidden');
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#ticker-search-input') && !e.target.closest('#search-dropdown')) {
    hideSearchDropdown();
  }
});

// Run Optimization
async function runOptimization(shouldSwitchTab = false) {
  if (state.tickers.length < 2) {
    showError('กรุณาเลือกหุ้นหรือสินทรัพย์อย่างน้อย 2 รายการขึ้นไปเพื่อคำนวณสัดส่วนพอร์ต');
    return;
  }

  const startDate = document.getElementById('start-date-input').value;
  const endDate = document.getElementById('end-date-input').value;
  const budget = parseNumericInput(document.getElementById('budget-input').value) || 100000;
  const maxWeight = parseFloat(document.getElementById('max-weight-slider').value) / 100.0;
  const fxRate = parseNumericInput(document.getElementById('fx-rate-input').value) || state.fxRate;

  if (!startDate || !endDate || startDate >= endDate) {
    showError('ช่วงวันที่ไม่ถูกต้อง: ตั้งแต่วันที่ ต้องน้อยกว่า ถึงวันที่');
    return;
  }
  if (maxWeight * state.tickers.length < 0.9999) {
    const minReqPct = Math.ceil(100 / state.tickers.length);
    showError(`เพดานน้ำหนักต่อหุ้น (${Math.round(maxWeight * 100)}%) ต่ำเกินไปสำหรับ ${state.tickers.length} สินทรัพย์ (ต้องตั้งอย่างน้อย ${minReqPct}% เพื่อให้ผลรวมครบ 100%)`);
    return;
  }
  if (budget < 10) {
    showError('กรุณาระบุเงินลงทุนตั้งต้นอย่างน้อย 10');
    return;
  }

  hideError();
  showLoading(true);

  try {
    const payload = {
      tickers: state.tickers,
      start_date: startDate,
      end_date: endDate,
      budget: budget,
      currency: state.currency,
      fx_rate: fxRate,
      max_weight: maxWeight,
      min_weight: 0.0,
      risk_free_rate: null,
      num_simulations: 3500,
      use_news_adjustment: state.useNewsAdjustment
    };

    const res = await fetch('/api/optimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || 'ไม่สามารถคำนวณข้อมูลพอร์ตได้ กรุณาตรวจสอบช่วงเวลาและชื่อหุ้น');
    }

    state.optData = data;
    if (data.metadata && data.metadata.usd_thb_rate) {
      state.fxRate = Number(data.metadata.usd_thb_rate);
    }

    // Reset custom holdings to match current tickers
    const validTickers = data.metadata.tickers || [];
    const perAsset = Math.round((budget / validTickers.length) * 100) / 100;
    validTickers.forEach(t => {
      if (state.customHoldings[t] === undefined) {
        state.customHoldings[t] = perAsset;
      }
      const p = getAssetPriceInCurrentCurrency(t);
      state.customShares[t] = p > 0 ? Number((state.customHoldings[t] / p).toFixed(4)) : 0;
    });

    renderAllViews();
    if (shouldSwitchTab) {
      switchAppTab('trade-plan');
    }
  } catch (err) {
    showError(err.message);
  } finally {
    showLoading(false);
  }
}

function renderAllViews() {
  const data = state.optData;
  if (!data) return;

  const resDash = document.getElementById('results-dashboard');
  if (resDash) resDash.classList.remove('hidden');

  const stripEl = document.getElementById('global-result-strip');
  if (stripEl) {
    if (state.activeTab && state.activeTab !== 'setup') {
      stripEl.classList.remove('hidden');
    } else {
      stripEl.classList.add('hidden');
    }
  }

  const mainBudgetEl = document.getElementById('budget-input');
  const stripBudgetEl = document.getElementById('strip-budget-input');
  if (stripBudgetEl && mainBudgetEl && document.activeElement !== stripBudgetEl) {
    stripBudgetEl.value = mainBudgetEl.value;
  }

  const tradingDaysEl = document.getElementById('top-trading-days');
  if (tradingDaysEl) tradingDaysEl.innerText = data.metadata.trading_days.toLocaleString();
  state.isFallbackRf = !!data.metadata.is_fallback_rf;
  state.isFallbackFx = !!data.metadata.is_fallback_fx;
  const rfPctStr = `${(data.metadata.risk_free_rate * 100).toFixed(2)}%`;
  const rfEl = document.getElementById('top-rf-rate');
  if (rfEl) rfEl.innerText = data.metadata.is_fallback_rf ? `${rfPctStr} (ค่าสำรอง)` : rfPctStr;
  const topFxEl = document.getElementById('top-fx-rate');
  if (topFxEl && data.metadata.usd_thb_rate) {
    const fxStr = `${Number(data.metadata.usd_thb_rate).toFixed(2)} บาท/$`;
    topFxEl.innerText = data.metadata.is_fallback_fx ? `${fxStr} (ค่าสำรอง)` : fxStr;
  }
  const periodBadge = document.getElementById('analysis-period-badge');
  if (periodBadge) {
    periodBadge.innerText = `ข้อมูลจริง: ${data.metadata.start_date} ถึง ${data.metadata.end_date} (${data.metadata.trading_days} วันทำการ)`;
  }

  if (state.rebalanceMode === 'custom') {
    renderCustomHoldingsInputs();
  }

  renderActiveGoalView();
  renderDimeWealthOverview();
  renderNewsAndSignalSection();
  renderBacktestStressCard();
  renderPortfolioGrowthChart();
  renderStrategyCompareTable();
  renderEfficientFrontierPlot();
  renderAssetStatsTable();
  renderCorrelationAndGrowthPlots();
  recalculateGoalProjection();

  if (window.lucide) {
    lucide.createIcons();
  }
}

/**
 * CORE PRUDENT REBALANCE ENGINE
 * คำนวณยอดสั่งขาย (บาท) และยอดสั่งซื้อ (บาท) พร้อมจับคู่เม็ดเงิน (ขาย A กี่บาท -> ไปซื้อ B กี่บาท)
 */
function computeRebalancePlan(strat, data) {
  const tickers = data.metadata.tickers || [];
  const baseBudget = Number(data.metadata.budget) || 100000;
  const feeBufferOn = document.getElementById('fee-buffer-toggle')?.checked ?? true;
  const minThreshold = parseFloat(document.getElementById('min-trade-threshold')?.value || '100');
  const FEE_RATE = feeBufferOn ? 0.0020 : 0.0; // 0.20% prudent brokerage commission + VAT buffer

  // 1. Determine current holdings (Baht) per ticker & total portfolio value
  const currentMap = {};
  let cashInjection = 0;

  // If user is in 'equal_weight' baseline mode AND also selected 'equal_weight' as target goal,
  // compare against Min Volatility or treat as Equal Weight with clear notice
  let effectiveMode = state.rebalanceMode;

  if (effectiveMode === 'cash') {
    tickers.forEach(t => { currentMap[t] = 0; });
    cashInjection = baseBudget;
  } else if (effectiveMode === 'custom') {
    tickers.forEach(t => {
      currentMap[t] = Math.max(0, Number(state.customHoldings[t]) || 0);
    });
    cashInjection = Number(state.customCashInjection) || 0;
  } else {
    // 'equal_weight' baseline
    const eqVal = baseBudget / Math.max(1, tickers.length);
    tickers.forEach(t => {
      currentMap[t] = eqVal;
    });
    cashInjection = 0;
  }

  const totalCurrentHoldings = tickers.reduce((acc, t) => acc + currentMap[t], 0);
  const totalPortfolioBudget = Math.max(0, totalCurrentHoldings + cashInjection);

  // Price map in user's selected currency (Baht by default)
  const priceMap = {};
  const statMap = {};
  const fx = state.fxRate > 0 ? state.fxRate : 34.50;
  (data.asset_stats || []).forEach(s => {
    statMap[s.ticker] = s;
    const isThai = s.ticker.endsWith('.BK');
    if (state.currency === 'THB') {
      priceMap[s.ticker] = s.price_thb !== undefined
        ? Number(s.price_thb)
        : (isThai ? Number(s.native_price) : Number((s.native_price * fx).toFixed(2)));
    } else {
      priceMap[s.ticker] = s.price_usd !== undefined
        ? Number(s.price_usd)
        : (isThai ? Number((s.native_price / fx).toFixed(2)) : Number(s.native_price));
    }
  });

  // 2. Compute Raw Target & Raw Delta per asset
  const items = tickers.map(t => {
    const wTarget = Number(strat.weights[t] || 0);
    const currentVal = Number(currentMap[t].toFixed(2));
    const currentWeight = totalPortfolioBudget > 0 ? currentVal / totalPortfolioBudget : 0;
    const targetVal = Number((totalPortfolioBudget * wTarget).toFixed(2));
    const rawDelta = Number((targetVal - currentVal).toFixed(2));
    const price = priceMap[t] > 0 ? priceMap[t] : 0;
    const stat = statMap[t] || {};

    return {
      ticker: t,
      name: stat.name || t,
      native_currency: stat.native_currency || (t.endsWith('.BK') ? 'THB' : 'USD'),
      native_price: stat.native_price || price,
      price: price,
      current_value: currentVal,
      current_weight: currentWeight,
      target_weight: wTarget,
      target_value: targetVal,
      raw_delta: rawDelta
    };
  });

  // 3. Apply minimum trade filter & separate SELL vs BUY vs HOLD
  const sellOrders = [];
  const buyCandidates = [];
  const holdOrders = [];

  items.forEach(item => {
    const absDelta = Math.abs(item.raw_delta);
    if (effectiveMode !== 'cash' && absDelta < minThreshold) {
      item.action = 'HOLD';
      item.trade_amount = 0;
      item.final_value = item.current_value;
      holdOrders.push(item);
    } else if (item.raw_delta < 0 && effectiveMode !== 'cash') {
      const sellAmt = Number(Math.min(item.current_value, Math.abs(item.raw_delta)).toFixed(2));
      if (sellAmt < minThreshold) {
        item.action = 'HOLD';
        item.trade_amount = 0;
        item.final_value = item.current_value;
        holdOrders.push(item);
      } else {
        item.action = 'SELL';
        item.trade_amount = sellAmt;
        item.final_value = Number((item.current_value - sellAmt).toFixed(2));
        sellOrders.push(item);
      }
    } else if (item.raw_delta > 0) {
      if (item.raw_delta < minThreshold && item.target_weight <= 0.0005) {
        item.action = 'HOLD';
        item.trade_amount = 0;
        item.final_value = item.current_value;
        holdOrders.push(item);
      } else {
        item.action = 'BUY';
        item.raw_buy_need = item.raw_delta;
        buyCandidates.push(item);
      }
    } else {
      item.action = 'HOLD';
      item.trade_amount = 0;
      item.final_value = item.current_value;
      holdOrders.push(item);
    }
  });

  // Sort SELL descending by amount, BUY descending by amount
  sellOrders.sort((a, b) => b.trade_amount - a.trade_amount);
  buyCandidates.sort((a, b) => b.raw_buy_need - a.raw_buy_need);

  const totalSellGross = Number(sellOrders.reduce((acc, s) => acc + s.trade_amount, 0).toFixed(2));
  const netCashPool = totalSellGross + cashInjection;
  const withdrawalExceedsSells = cashInjection < 0 && netCashPool < 0;
  const rawCashAvailable = Math.max(0, netCashPool);

  // Reserve fee cushion so real execution never runs out of cash
  const feeReserve = Number((rawCashAvailable * FEE_RATE).toFixed(2));
  const netSpendableForBuys = Number(Math.max(0, rawCashAvailable - feeReserve).toFixed(2));

  const totalRawBuyNeed = buyCandidates.reduce((acc, b) => acc + b.raw_buy_need, 0);
  const buyOrders = [];

  buyCandidates.forEach(b => {
    let buyAmt = 0;
    if (totalRawBuyNeed > 0 && netSpendableForBuys > 0) {
      // Scale prudently so total buys never exceed netSpendableForBuys
      const scale = Math.min(1.0, netSpendableForBuys / totalRawBuyNeed);
      buyAmt = Number((b.raw_buy_need * scale).toFixed(2));
    }
    if (buyAmt >= Math.max(1, minThreshold)) {
      b.action = 'BUY';
      b.trade_amount = buyAmt;
      b.final_value = Number((b.current_value + buyAmt).toFixed(2));
      buyOrders.push(b);
    } else {
      b.action = 'HOLD';
      b.trade_amount = 0;
      b.final_value = b.current_value;
      holdOrders.push(b);
    }
  });

  // Compute exact shares & fractional shares for every item
  items.forEach(item => {
    const p = item.price > 0 ? item.price : 0;
    item.trade_shares_fractional = p > 0 ? Number((item.trade_amount / p).toFixed(4)) : 0;
    item.trade_shares_whole = p > 0 ? Math.floor((item.trade_amount / p) + 1e-9) : 0;
    item.target_shares_fractional = p > 0 ? Number((item.target_value / p).toFixed(4)) : 0;
    item.target_shares_whole = p > 0 ? Math.floor((item.target_value / p) + 1e-9) : 0;
  });

  const totalBuyNet = Number(buyOrders.reduce((acc, b) => acc + b.trade_amount, 0).toFixed(2));
  const leftoverCash = Number(Math.max(0, rawCashAvailable - totalBuyNet).toFixed(2));

  // 4. Build Direct Pairwise Cash-Flow Matching ("ขาย A กี่บาท -> ไปซื้อ B กี่บาท")
  const flowPairs = [];
  const sellQueue = sellOrders.map(s => ({ ...s, rem: s.trade_amount }));
  if (cashInjection > 0) {
    sellQueue.push({
      ticker: 'CASH',
      name: effectiveMode === 'cash' ? 'เงินสดตั้งต้น' : 'เงินสดเติมเพิ่ม',
      rem: cashInjection,
      isCash: true
    });
  }
  const buyQueue = buyOrders.map(b => ({ ...b, rem: b.trade_amount }));

  let sIdx = 0;
  let bIdx = 0;
  while (sIdx < sellQueue.length && bIdx < buyQueue.length) {
    const sItem = sellQueue[sIdx];
    const bItem = buyQueue[bIdx];
    if (sItem.rem <= 0.5) { sIdx++; continue; }
    if (bItem.rem <= 0.5) { bIdx++; continue; }

    // Match gross source to net buy (accounting for fee ratio if applicable)
    const matchedAmount = Number(Math.min(sItem.rem, bItem.rem).toFixed(2));
    if (matchedAmount >= 1) {
      flowPairs.push({
        fromTicker: sItem.ticker,
        fromName: sItem.name,
        fromIsCash: !!sItem.isCash,
        sellAmount: matchedAmount,
        sellShares: sItem.price > 0 ? Number((matchedAmount / sItem.price).toFixed(4)) : 0,
        toTicker: bItem.ticker,
        toName: bItem.name,
        buyAmount: matchedAmount,
        buyShares: bItem.price > 0 ? Number((matchedAmount / bItem.price).toFixed(4)) : 0
      });
    }
    sItem.rem -= matchedAmount;
    bItem.rem -= matchedAmount;
    if (sItem.rem <= 0.5) sIdx++;
    if (bItem.rem <= 0.5) bIdx++;
  }

  return {
    mode: effectiveMode,
    totalPortfolioBudget,
    totalCurrentHoldings,
    cashInjection,
    withdrawalExceedsSells,
    feeBufferOn,
    feeReserve,
    minThreshold,
    totalSellGross,
    totalBuyNet,
    leftoverCash,
    items,
    sellOrders,
    buyOrders,
    holdOrders,
    flowPairs
  };
}

// Render Top Executive KPI + Rebalance Action Plan + Buy/Sell Order Table
function renderActiveGoalView() {
  const data = state.optData;
  if (!data) return;

  const strat = data.strategies[state.activeGoal];
  if (!strat) return;

  const budget = data.metadata.budget;

  // Title & Tagline
  document.getElementById('active-goal-title').innerText = strat.name;
  document.getElementById('active-goal-desc').innerText = strat.tagline;

  // KPI 1: Expected Return + Profit in Baht
  const retPct = (strat.expected_return * 100).toFixed(2);
  const retSign = strat.expected_return >= 0 ? '+' : '';
  const kpiRetEl = document.getElementById('kpi-return');
  kpiRetEl.innerText = `${retSign}${retPct}%`;
  kpiRetEl.className = `text-2xl sm:text-3xl font-extrabold font-mono tracking-tight mt-1 ${strat.expected_return >= 0 ? 'text-emerald-600' : 'text-rose-600'}`;

  const estProfit = budget * strat.expected_return;
  const profitSign = estProfit >= 0 ? '+' : '-';
  document.getElementById('kpi-profit-money').innerText =
    `กำไรคาดหวังเฉลี่ย ${profitSign}${formatMoney(Math.abs(estProfit), 0, true)}/ปี`;

  // KPI 2: Volatility & Risk Badge
  const volPct = (strat.volatility * 100).toFixed(2);
  document.getElementById('kpi-volatility').innerText = `${volPct}%`;
  const riskBadge = document.getElementById('kpi-risk-badge');
  if (strat.volatility < 0.16) {
    riskBadge.innerText = 'ระดับความเสี่ยงต่ำ';
    riskBadge.className = 'inline-block text-[10px] font-semibold px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200';
  } else if (strat.volatility <= 0.28) {
    riskBadge.innerText = 'ระดับความเสี่ยงปานกลาง';
    riskBadge.className = 'inline-block text-[10px] font-semibold px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200';
  } else {
    riskBadge.innerText = 'ระดับความเสี่ยงสูง';
    riskBadge.className = 'inline-block text-[10px] font-semibold px-2 py-0.5 rounded bg-rose-50 text-rose-800 border border-rose-200';
  }

  // KPI 3: Historical Max Drawdown in BAHT (Requirement 1)
  const mddBaht = strat.max_drawdown_amount !== undefined
    ? strat.max_drawdown_amount
    : Math.abs(strat.max_drawdown) * budget;
  const minRemainingBaht = strat.min_capital_remaining !== undefined
    ? strat.min_capital_remaining
    : Math.max(0, budget - mddBaht);

  document.getElementById('kpi-mdd-baht').innerText = `-${formatMoney(mddBaht, 0, true)}`;
  document.getElementById('kpi-mdd').innerText = `(${(strat.max_drawdown * 100).toFixed(2)}%)`;
  document.getElementById('kpi-mdd-remaining').innerText = `เหลือต่ำสุด ${formatMoney(minRemainingBaht, 0, false)}`;

  // KPI 4: Sharpe Ratio
  document.getElementById('kpi-sharpe').innerText = strat.sharpe_ratio.toFixed(2);
  const srBadge = document.getElementById('kpi-sharpe-badge');
  if (strat.sharpe_ratio >= 1.5) {
    srBadge.innerText = 'คุ้มค่าความเสี่ยงดีเยี่ยม';
    srBadge.className = 'inline-block text-[10px] font-semibold px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200';
  } else if (strat.sharpe_ratio >= 1.0) {
    srBadge.innerText = 'คุ้มค่าความเสี่ยงดี';
    srBadge.className = 'inline-block text-[10px] font-semibold px-2 py-0.5 rounded bg-blue-50 text-blue-800 border border-blue-200';
  } else {
    srBadge.innerText = 'ความคุ้มค่าระดับปานกลาง';
    srBadge.className = 'inline-block text-[10px] font-semibold px-2 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200';
  }

  // Donut Chart of Portfolio Weights
  renderDonutAllocationChart(strat.weights, data.metadata.tickers);

  // Compute Prudent Rebalance Plan
  const plan = computeRebalancePlan(strat, data);
  state.lastRebalancePlan = plan;

  // Update 5-Tab Nav Trade Plan badge count
  const navTradeBadge = document.getElementById('nav-trade-count-badge');
  if (navTradeBadge) {
    const tradeCount = (plan.sellOrders?.length || 0) + (plan.buyOrders?.length || 0);
    if (tradeCount > 0) {
      navTradeBadge.innerText = `${tradeCount} รายการ`;
      navTradeBadge.classList.remove('hidden');
    } else {
      navTradeBadge.classList.add('hidden');
    }
  }

  // Update Summary KPI Box under Donut Chart
  document.getElementById('order-kpi-budget').innerText = formatMoney(plan.totalPortfolioBudget, 2, false);
  document.getElementById('order-kpi-total-sell').innerText = plan.totalSellGross > 0
    ? `+${formatMoney(plan.totalSellGross, 2, false)}`
    : formatMoney(0, 2, false);
  document.getElementById('order-kpi-total-buy').innerText = formatMoney(plan.totalBuyNet, 2, false);
  document.getElementById('order-kpi-leftover').innerText = formatMoney(plan.leftoverCash, 2, false);

  const prudentNote = document.getElementById('prudent-status-note');
  if (prudentNote) {
    if (plan.withdrawalExceedsSells) {
      prudentNote.innerHTML = `<i data-lucide="alert-triangle" class="w-3.5 h-3.5"></i><span>คำเตือน: ยอดถอนเงินสดมากกว่ายอดขายสินทรัพย์ ระบบงดสั่งซื้อเพิ่มเพื่อป้องกันเงินสดติดลบ</span>`;
      prudentNote.className = 'text-[11px] text-rose-700 font-bold flex items-center gap-1';
    } else if (plan.feeBufferOn) {
      prudentNote.innerHTML = `<i data-lucide="shield-check" class="w-3.5 h-3.5"></i><span>รอบคอบ: กันเงินสำรองเผื่อค่าธรรมเนียมซื้อขายแล้ว ${formatMoney(plan.feeReserve, 2, true)}</span>`;
      prudentNote.className = 'text-[11px] text-emerald-700 font-medium flex items-center gap-1';
    } else {
      prudentNote.innerHTML = `<i data-lucide="info" class="w-3.5 h-3.5"></i><span>คำนวณเต็มวงเงิน 100% (ไม่หักสำรองค่าธรรมเนียม)</span>`;
      prudentNote.className = 'text-[11px] text-slate-500 font-medium flex items-center gap-1';
    }
  }

  // Sync Rebalance mode button highlights
  const rebalBtnMap = {
    equal_weight: 'rebal-mode-equal',
    custom: 'rebal-mode-custom',
    cash: 'rebal-mode-cash'
  };
  Object.entries(rebalBtnMap).forEach(([k, id]) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', k === state.rebalanceMode);
  });

  // Render Existing Portfolio Audit vs Target Strategy (when in custom mode)
  renderExistingPortfolioAudit(plan, strat, data);

  // Render Step-by-Step Rebalance & Direct Cash-Flow Pairing Box (Requirement 2)
  renderRebalanceActionSummaryBox(plan, strat);

  // Render Full Rebalance & Buy/Sell Table
  renderRebalanceOrdersTable(plan, data);

  if (window.lucide) {
    lucide.createIcons();
  }
}

/**
 * Render the Step-by-Step Actionable Rebalance Summary Box
 * แสดงชัดเจนว่าต้อง "ขายสินทรัพย์ A กี่บาท แล้วนำไปซื้อสินทรัพย์ B กี่บาท"
 */
function renderRebalanceActionSummaryBox(plan, strat) {
  const box = document.getElementById('rebalance-action-summary-box');
  if (!box) return;

  // Case 1: Portfolio is already balanced (no trades needed)
  if (plan.sellOrders.length === 0 && plan.buyOrders.length === 0) {
    box.innerHTML = `
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div class="flex items-start gap-3">
          <div class="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0 mt-0.5">
            <i data-lucide="check-circle-2" class="w-5 h-5"></i>
          </div>
          <div>
            <h4 class="text-sm font-bold text-slate-900">พอร์ตปัจจุบันของคุณมีสัดส่วนตรงตามเป้าหมาย "${strat.short_name}" อยู่แล้ว</h4>
            <p class="text-xs text-slate-600 mt-0.5">
              ไม่จำเป็นต้องส่งคำสั่งซื้อหรือขายเพิ่มเติมในขณะนี้ เพื่อประหยัดค่าธรรมเนียมการซื้อขาย (หากต้องการดูยอดซื้อเริ่มต้นจากเงินสด กดปุ่ม <b>"ซื้อใหม่จากเงินสด 100%"</b> ด้านบน)
            </p>
          </div>
        </div>
        <button
          type="button"
          onclick="setRebalanceMode('cash')"
          class="px-3 py-1.5 text-xs font-semibold bg-slate-900 hover:bg-blue-700 text-white rounded-lg shrink-0 transition"
        >
          ดูคำสั่งซื้อกรณีเริ่มจากเงินสด
        </button>
      </div>
    `;
    return;
  }

  // Case 2: Rebalance Mode with both SELL & BUY orders ("ขาย A กี่บาท -> ไปซื้อ B กี่บาท")
  if (plan.sellOrders.length > 0) {
    const sellSummaryText = plan.sellOrders
      .map(s => `<b>${s.ticker}</b> (${formatMoney(s.trade_amount, 2, true)})`)
      .join(' + ');
    const buySummaryText = plan.buyOrders
      .map(b => `<b>${b.ticker}</b> (${formatMoney(b.trade_amount, 2, true)})`)
      .join(' + ');

    const pairRowsHtml = plan.flowPairs.map((pair, idx) => {
      const fromBadge = pair.fromIsCash
        ? `<span class="px-2 py-0.5 rounded bg-blue-100 text-blue-800 font-bold text-xs">${pair.fromName}</span>`
        : `<span class="px-2 py-0.5 rounded bg-rose-100 text-rose-800 font-mono font-bold text-xs">ขาย ${pair.fromTicker}</span>`;

      const fromSharesText = (!pair.fromIsCash && pair.sellShares > 0)
        ? `<span class="text-[11px] text-slate-500 font-mono ml-1">(~${pair.sellShares} หุ้น)</span>`
        : '';

      const toSharesText = pair.buyShares > 0
        ? `<span class="text-[11px] text-slate-500 font-mono ml-1">(~${pair.buyShares} หุ้น)</span>`
        : '';

      return `
        <div class="flow-pair-card px-3.5 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="w-5 h-5 rounded-full bg-slate-900 text-white text-[10px] font-bold flex items-center justify-center shrink-0">${idx + 1}</span>
            ${fromBadge}
            <span class="text-slate-700">เป็นเงิน</span>
            <span class="font-mono font-bold text-rose-700 text-sm">${formatMoney(pair.sellAmount, 2, true)}</span>
            ${fromSharesText}
          </div>

          <div class="flex items-center gap-2 text-slate-400 font-bold">
            <span>➔ นำเงินไป</span>
          </div>

          <div class="flex items-center gap-2 flex-wrap sm:justify-end">
            <span class="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-mono font-bold text-xs">ซื้อ ${pair.toTicker}</span>
            <span class="text-slate-700">เป็นเงิน</span>
            <span class="font-mono font-bold text-emerald-700 text-sm">${formatMoney(pair.buyAmount, 2, true)}</span>
            ${toSharesText}
          </div>
        </div>
      `;
    }).join('');

    box.innerHTML = `
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-200/80 pb-3">
        <div>
          <div class="flex items-center gap-2">
            <span class="w-2 h-2 rounded-full bg-blue-600"></span>
            <h4 class="text-sm font-bold text-slate-900">
              ขั้นตอนปฏิบัติการปรับพอร์ต (ทำตามลำดับทีละข้อได้ทันที ไม่ต้องคำนวณเอง)
            </h4>
          </div>
          <p class="text-xs text-slate-600 mt-1 leading-relaxed">
            สรุปภาพรวม: ให้สั่งขาย ${sellSummaryText} รวมได้เงินสด <b class="text-rose-700 font-mono">${formatMoney(plan.totalSellGross, 2, true)}</b>
            ${plan.cashInjection > 0 ? `(บวกเงินสดเติมเพิ่ม <b class="font-mono">${formatMoney(plan.cashInjection, 2, true)}</b>)` : ''}
            แล้วนำเงินไปสั่งซื้อ ${buySummaryText} รวมเป็นเงิน <b class="text-emerald-700 font-mono">${formatMoney(plan.totalBuyNet, 2, true)}</b>
          </p>
        </div>
      </div>

      <!-- Direct Pairwise Cash-Flow Matching List -->
      <div class="space-y-2">
        <div class="text-xs font-bold text-slate-800 flex items-center justify-between">
          <span>คู่คำสั่งซื้อ-ขายจับคู่เม็ดเงิน (ขายตัวไหนกี่บาท ➔ ไปซื้อตัวไหนกี่บาท):</span>
          <span class="text-[11px] font-normal text-slate-500">จับคู่ยอดเงินให้พอดีอัตโนมัติ</span>
        </div>
        <div class="space-y-2">
          ${pairRowsHtml}
        </div>
      </div>

      <!-- 2-Column Step Summary: Step 1 SELL All -> Step 2 BUY All -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
        <!-- Step 1: SELL Card -->
        <div class="bg-white rounded-lg border border-rose-200 p-3 space-y-2">
          <div class="flex items-center justify-between border-b border-rose-100 pb-2">
            <span class="text-xs font-bold text-rose-800 flex items-center gap-1.5">
              <span class="px-1.5 py-0.5 rounded bg-rose-600 text-white text-[10px]">ขั้นที่ 1</span>
              รายการที่ต้องสั่งขายก่อน (SELL)
            </span>
            <span class="font-mono text-xs font-bold text-rose-700">รับเงิน +${formatMoney(plan.totalSellGross, 2, true)}</span>
          </div>
          <div class="space-y-1.5">
            ${plan.sellOrders.map(s => `
              <div class="flex items-center justify-between text-xs py-1 border-b border-slate-100 last:border-0">
                <div>
                  <span class="font-mono font-bold text-slate-900">ขาย ${s.ticker}</span>
                  <span class="text-[11px] text-slate-500 ml-1">(${(s.current_weight * 100).toFixed(1)}% ➔ ${(s.target_weight * 100).toFixed(1)}%)</span>
                </div>
                <div class="text-right">
                  <div class="font-mono font-bold text-rose-700">ขาย ${formatMoney(s.trade_amount, 2, true)}</div>
                  <div class="text-[10px] font-mono text-slate-500">ประมาณ ${s.trade_shares_fractional} หุ้น</div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- Step 2: BUY Card -->
        <div class="bg-white rounded-lg border border-emerald-200 p-3 space-y-2">
          <div class="flex items-center justify-between border-b border-emerald-100 pb-2">
            <span class="text-xs font-bold text-emerald-800 flex items-center gap-1.5">
              <span class="px-1.5 py-0.5 rounded bg-emerald-600 text-white text-[10px]">ขั้นที่ 2</span>
              นำเงินที่ได้ไปสั่งซื้อ (BUY)
            </span>
            <span class="font-mono text-xs font-bold text-emerald-700">ใช้เงิน ${formatMoney(plan.totalBuyNet, 2, true)}</span>
          </div>
          <div class="space-y-1.5">
            ${plan.buyOrders.map(b => `
              <div class="flex items-center justify-between text-xs py-1 border-b border-slate-100 last:border-0">
                <div>
                  <span class="font-mono font-bold text-slate-900">ซื้อ ${b.ticker}</span>
                  <span class="text-[11px] text-slate-500 ml-1">(${(b.current_weight * 100).toFixed(1)}% ➔ ${(b.target_weight * 100).toFixed(1)}%)</span>
                </div>
                <div class="text-right">
                  <div class="font-mono font-bold text-emerald-700">ซื้อ ${formatMoney(b.trade_amount, 2, true)}</div>
                  <div class="text-[10px] font-mono text-slate-500">ประมาณ ${b.trade_shares_fractional} หุ้น</div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;
    return;
  }

  // Case 3: 100% Cash / Buy-Only Mode
  box.innerHTML = `
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-200/80 pb-3">
      <div>
        <div class="flex items-center gap-2">
          <span class="w-2 h-2 rounded-full bg-emerald-600"></span>
          <h4 class="text-sm font-bold text-slate-900">
            สรุปใบสั่งซื้อจากเงินสดตั้งต้น ${formatMoney(plan.totalPortfolioBudget, 2, true)} (ระบุยอดเงินบาทชัดเจน)
          </h4>
        </div>
        <p class="text-xs text-slate-600 mt-0.5">
          แบ่งเงินสดไปสั่งซื้อสินทรัพย์แต่ละตัวตามยอดเงินบาทด้านล่างนี้ได้ทันที (หักกันสำรองค่าธรรมเนียมไว้แล้ว ${formatMoney(plan.feeReserve, 2, true)})
        </p>
      </div>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
      ${plan.buyOrders.map((b, idx) => `
        <div class="bg-white rounded-lg border border-emerald-200 p-3 flex items-center justify-between gap-2">
          <div>
            <div class="flex items-center gap-1.5">
              <span class="w-4 h-4 rounded-full bg-emerald-600 text-white text-[10px] font-bold flex items-center justify-center">${idx + 1}</span>
              <span class="font-mono font-bold text-xs text-slate-900">ซื้อ ${b.ticker}</span>
              <span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 font-mono font-semibold">${(b.target_weight * 100).toFixed(1)}%</span>
            </div>
            <div class="text-[11px] text-slate-500 mt-0.5 truncate max-w-[140px]">${b.name}</div>
          </div>
          <div class="text-right">
            <div class="font-mono font-bold text-sm text-emerald-700">${formatMoney(b.trade_amount, 2, true)}</div>
            <div class="text-[10px] font-mono text-slate-500">
              ${b.trade_shares_whole > 0 ? `${b.trade_shares_whole} หุ้นเต็ม (${b.trade_shares_fractional} หน่วย)` : `${b.trade_shares_fractional} หน่วยย่อย`}
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

/**
 * Render the Full Rebalance & Buy/Sell Execution Table
 */
function renderRebalanceOrdersTable(plan, data) {
  const tbody = document.getElementById('orders-table-body');
  if (!tbody) return;

  // Sort: SELL first (largest sell first), then BUY (largest buy first), then HOLD
  const orderPriority = { SELL: 1, BUY: 2, HOLD: 3 };
  const sortedItems = [...plan.items].sort((a, b) => {
    const pDiff = (orderPriority[a.action] || 9) - (orderPriority[b.action] || 9);
    if (pDiff !== 0) return pDiff;
    return b.trade_amount - a.trade_amount || b.target_value - a.target_value;
  });

  const fx = state.fxRate > 0 ? state.fxRate : 34.50;
  const statMap = {};
  (data.asset_stats || []).forEach(s => { statMap[s.ticker] = s; });
  state.executedOrders = state.executedOrders || {};

  const actionableItems = sortedItems.filter(it => it.action === 'BUY' || it.action === 'SELL');
  let doneCount = 0;

  tbody.innerHTML = sortedItems.map(item => {
    const color = ASSET_COLORS[data.metadata.tickers.indexOf(item.ticker) % ASSET_COLORS.length];
    const wCurPct = (item.current_weight * 100).toFixed(1);
    const wTarPct = (item.target_weight * 100).toFixed(1);
    const stat = statMap[item.ticker] || {};
    const dec = stat.decision || {};
    const safeTicker = escapeHtmlText(item.ticker);
    const safeName = escapeHtmlText(item.name);
    const isActionable = item.action === 'BUY' || item.action === 'SELL';
    const isChecked = !!state.executedOrders[item.ticker];
    if (isActionable && isChecked) doneCount++;

    // Dual-currency display (shows both THB and USD clearly)
    const pThb = stat.price_thb !== undefined
      ? stat.price_thb
      : (item.native_currency === 'THB' ? item.native_price : Number((item.native_price * fx).toFixed(2)));
    const pUsd = stat.price_usd !== undefined
      ? stat.price_usd
      : (item.native_currency === 'USD' ? item.native_price : Number((item.native_price / fx).toFixed(2)));

    const companionPriceHtml = state.currency === 'THB'
      ? `<div class="text-[10px] text-slate-400 font-mono">($${pUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD)</div>`
      : `<div class="text-[10px] text-slate-400 font-mono">(฿${pThb.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} THB)</div>`;

    let signalMiniBadge = '';
    if (dec.signal_badge_th) {
      let sigCls = 'bg-slate-100 text-slate-700 border-slate-200';
      if (dec.signal_level === 'POSITIVE_BUY') sigCls = 'bg-emerald-50 text-emerald-800 border-emerald-200';
      else if (dec.signal_level === 'OVERBOUGHT_TRANCHE') sigCls = 'bg-amber-50 text-amber-800 border-amber-200';
      else if (dec.signal_level === 'CAUTIOUS_SHIELD') sigCls = 'bg-rose-50 text-rose-800 border-rose-200';
      signalMiniBadge = `<div class="mt-1"><span class="inline-block text-[10px] font-sans font-semibold px-1.5 py-0.5 rounded border ${sigCls}">${escapeHtmlText(dec.signal_badge_th)}</span></div>`;
    }

    let actionBadgeHtml = '';
    let sharesActionHtml = '';

    if (item.action === 'SELL') {
      actionBadgeHtml = `
        <div class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-rose-100 text-rose-800 border border-rose-200 font-sans font-bold text-xs">
          <span>สั่งขายออก</span>
        </div>
        <div class="font-mono font-bold text-rose-700 text-sm mt-0.5">-${formatMoney(item.trade_amount, 2, true)}</div>
      `;
      sharesActionHtml = item.trade_shares_whole > 0
        ? `<div class="font-sans font-bold text-rose-700">ขาย ${item.trade_shares_whole.toLocaleString()} หุ้น</div>
           <div class="text-[10px] text-slate-400 font-mono">(ละเอียด: ${item.trade_shares_fractional} หน่วย)</div>`
        : `<div class="font-sans font-bold text-rose-700">ขาย ${item.trade_shares_fractional} หน่วยย่อย</div>
           <div class="text-[10px] text-slate-400 font-sans">(ส่งคำสั่งแบบ Fractional)</div>`;
    } else if (item.action === 'BUY') {
      actionBadgeHtml = `
        <div class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-200 font-sans font-bold text-xs">
          <span>สั่งซื้อเพิ่ม</span>
        </div>
        <div class="font-mono font-bold text-emerald-700 text-sm mt-0.5">+${formatMoney(item.trade_amount, 2, true)}</div>
      `;
      sharesActionHtml = item.trade_shares_whole > 0
        ? `<div class="font-sans font-bold text-emerald-700">ซื้อ ${item.trade_shares_whole.toLocaleString()} หุ้น</div>
           <div class="text-[10px] text-slate-400 font-mono">(ละเอียด: ${item.trade_shares_fractional} หน่วย)</div>`
        : `<div class="font-sans font-bold text-blue-700">ซื้อ ${item.trade_shares_fractional} หน่วยย่อย</div>
           <div class="text-[10px] text-slate-400 font-sans">(ส่งคำสั่งแบบ Fractional)</div>`;
    } else {
      actionBadgeHtml = `
        <div class="inline-block px-2 py-0.5 rounded bg-slate-100 text-slate-600 font-sans font-semibold text-[11px]">
          ไม่ต้องซื้อขาย (คงเดิม)
        </div>
        <div class="text-[10px] text-slate-400 font-sans mt-0.5">ส่วนต่างน้อยหรือสัดส่วน 0%</div>
      `;
      sharesActionHtml = `<span class="text-slate-400 font-sans text-[11px]">ถือเท่าเดิม</span>`;
    }

    const rowClass = (isActionable && isChecked)
      ? 'order-row-done'
      : (item.action === 'HOLD' && item.target_weight <= 0.0005 ? 'bg-slate-50/60 text-slate-400' : '');

    return `
      <tr id="order-row-${safeTicker}" class="${rowClass}">
        <td class="py-3 px-2.5 text-center">
          ${isActionable
            ? `<input type="checkbox" class="qf-order-check" data-ticker="${safeTicker}" ${isChecked ? 'checked' : ''} onchange="toggleOrderExecution(this.dataset.ticker, this.checked)" title="ติ๊กเมื่อส่งคำสั่งจริงในโบรกเกอร์แล้ว" />`
            : `<span class="text-slate-300">-</span>`}
        </td>
        <td class="py-3 px-3 font-sans">
          <div class="flex items-center gap-2.5">
            ${renderStockLogoBadge(item.ticker, color, 32)}
            <div>
              <div class="font-mono font-bold text-slate-900">${safeTicker}</div>
              <div class="text-[10px] text-slate-500 truncate max-w-[130px]">${safeName}</div>
              ${signalMiniBadge}
            </div>
          </div>
        </td>
        <td class="py-3 px-3 text-right">
          <div class="font-semibold text-slate-800">${formatMoney(item.price, 2, false)}</div>
          ${companionPriceHtml}
        </td>
        <td class="py-3 px-3 text-right">
          <div class="text-[11px] text-slate-500">เดิม: ${formatMoney(item.current_value, 0, false)} (${wCurPct}%)</div>
          <div class="font-bold text-slate-900 mt-0.5">เป้า: ${formatMoney(item.target_value, 0, false)} (${wTarPct}%)</div>
        </td>
        <td class="py-3 px-3 text-right">${actionBadgeHtml}</td>
        <td class="py-3 px-3 text-right">${sharesActionHtml}</td>
      </tr>
    `;
  }).join('');

  renderOrderChecklistCards(sortedItems, data);
  updateOrderExecProgressBadge(doneCount, actionableItems.length);
}

function renderOrderChecklistCards(sortedItems, data) {
  const grid = document.getElementById('orders-checklist-cards-grid');
  if (!grid) return;

  const fx = state.fxRate > 0 ? state.fxRate : 34.50;
  const statMap = {};
  (data.asset_stats || []).forEach(s => { statMap[s.ticker] = s; });

  grid.innerHTML = sortedItems.map(item => {
    const color = ASSET_COLORS[data.metadata.tickers.indexOf(item.ticker) % ASSET_COLORS.length];
    const wCurPct = (item.current_weight * 100).toFixed(1);
    const wTarPct = (item.target_weight * 100).toFixed(1);
    const stat = statMap[item.ticker] || {};
    const dec = stat.decision || {};
    const safeTicker = escapeHtmlText(item.ticker);
    const safeName = escapeHtmlText(item.name);
    const isActionable = item.action === 'BUY' || item.action === 'SELL';
    const isChecked = !!state.executedOrders?.[item.ticker];

    const typeCls = item.action === 'SELL' ? 'is-sell' : (item.action === 'BUY' ? 'is-buy' : 'is-hold');
    const execCls = (isActionable && isChecked) ? 'executed' : '';

    const pThb = stat.price_thb !== undefined
      ? stat.price_thb
      : (item.native_currency === 'THB' ? item.native_price : Number((item.native_price * fx).toFixed(2)));
    const pUsd = stat.price_usd !== undefined
      ? stat.price_usd
      : (item.native_currency === 'USD' ? item.native_price : Number((item.native_price / fx).toFixed(2)));
    const companionShort = state.currency === 'THB'
      ? `$${pUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : `฿${pThb.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    let actionPill = '<span class="px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-600 font-semibold text-xs">ถือคงเดิม</span>';
    let amountText = '<div class="font-mono text-sm font-semibold text-slate-400">ไม่ต้องซื้อ-ขาย</div>';
    let sharesLine = '<span class="text-slate-400 text-xs">สัดส่วนใกล้เคียงเป้าหมายแล้ว</span>';

    if (item.action === 'SELL') {
      actionPill = '<span class="px-2.5 py-0.5 rounded-full bg-rose-100 text-rose-800 border border-rose-200 font-extrabold text-xs">สั่งขายออก</span>';
      amountText = `<div class="font-mono font-extrabold text-xl sm:text-2xl text-rose-600 tracking-tight">-${formatMoney(item.trade_amount, 2, true)}</div>`;
      sharesLine = item.trade_shares_whole > 0
        ? `<span class="text-slate-600">จำนวน:</span> <b class="text-rose-700 font-extrabold text-sm">${item.trade_shares_whole.toLocaleString()} หุ้น</b> <span class="text-slate-400 text-[11px]">(~${item.trade_shares_fractional})</span>`
        : `<span class="text-slate-600">จำนวน:</span> <b class="text-rose-700 font-extrabold text-sm">${item.trade_shares_fractional} หน่วยย่อย</b>`;
    } else if (item.action === 'BUY') {
      actionPill = '<span class="px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200 font-extrabold text-xs">สั่งซื้อเพิ่ม</span>';
      amountText = `<div class="font-mono font-extrabold text-xl sm:text-2xl text-emerald-600 tracking-tight">+${formatMoney(item.trade_amount, 2, true)}</div>`;
      sharesLine = item.trade_shares_whole > 0
        ? `<span class="text-slate-600">จำนวน:</span> <b class="text-emerald-700 font-extrabold text-sm">${item.trade_shares_whole.toLocaleString()} หุ้น</b> <span class="text-slate-400 text-[11px]">(~${item.trade_shares_fractional})</span>`
        : `<span class="text-slate-600">จำนวน:</span> <b class="text-blue-700 font-extrabold text-sm">${item.trade_shares_fractional} หน่วยย่อย</b>`;
    }

    let sigBadge = '';
    if (dec.signal_badge_th) {
      let sigCls = 'bg-slate-100 text-slate-700 border-slate-200';
      if (dec.signal_level === 'POSITIVE_BUY') sigCls = 'bg-emerald-50 text-emerald-800 border-emerald-200';
      else if (dec.signal_level === 'OVERBOUGHT_TRANCHE') sigCls = 'bg-amber-50 text-amber-800 border-amber-200';
      else if (dec.signal_level === 'CAUTIOUS_SHIELD') sigCls = 'bg-rose-50 text-rose-800 border-rose-200';
      sigBadge = `<span class="inline-block text-[11px] font-semibold px-2 py-0.5 rounded-md border ${sigCls}">${escapeHtmlText(dec.signal_badge_th)}</span>`;
    }

    return `
      <div id="order-card-${safeTicker}" class="qf-ticket-card ${typeCls} ${execCls} flex flex-col justify-between gap-3">
        <div class="flex items-start justify-between gap-3">
          <div class="flex items-start gap-2.5 min-w-0">
            ${isActionable
              ? `<input type="checkbox" class="qf-order-check mt-1.5 shrink-0" data-ticker="${safeTicker}" ${isChecked ? 'checked' : ''} onchange="toggleOrderExecution(this.dataset.ticker, this.checked)" title="ติ๊กเมื่อส่งคำสั่งจริงในโบรกเกอร์แล้ว" />`
              : `<span class="w-4 h-4 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center text-[10px] mt-1.5 shrink-0">-</span>`}
            ${renderStockLogoBadge(item.ticker, color, 36)}
            <div class="min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-mono font-extrabold text-base sm:text-lg text-slate-900 tracking-tight">${safeTicker}</span>
                ${actionPill}
              </div>
              <div class="text-xs text-slate-500 truncate mt-0.5">${safeName}</div>
            </div>
          </div>
          <div class="text-right shrink-0">
            ${amountText}
            <div class="text-[11px] font-mono text-slate-400 mt-0.5">ราคา ${formatMoney(item.price, 2, false)} <span class="text-slate-300">|</span> ${companionShort}</div>
          </div>
        </div>

        <div class="flex items-center justify-between gap-2 bg-slate-50/90 rounded-xl px-3.5 py-2 border border-slate-100 text-xs">
          <div class="font-mono text-slate-700">${sharesLine}</div>
          <div class="text-right font-mono text-slate-500 shrink-0">
            สัดส่วน <span class="text-slate-400">${wCurPct}%</span> ➔ <b class="text-slate-900 text-sm font-extrabold">${wTarPct}%</b>
          </div>
        </div>
        ${sigBadge ? `<div class="flex items-center justify-between pt-0.5">${sigBadge}<span class="text-[11px] text-slate-400">${isActionable ? 'ติ๊กช่องซ้ายบนเมื่อส่งคำสั่งแล้ว' : ''}</span></div>` : ''}
      </div>
    `;
  }).join('');
  renderDimeWealthOverview();
}

function updateOrderExecProgressBadge(doneCount, totalCount) {
  const badge = document.getElementById('order-exec-progress-badge');
  if (!badge) return;
  if (totalCount === 0) {
    badge.innerText = 'ไม่มีรายการที่ต้องซื้อ-ขาย';
    badge.className = 'text-[11px] font-semibold px-2 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200';
  } else if (doneCount >= totalCount) {
    badge.innerText = `ส่งคำสั่งครบแล้ว ${doneCount} / ${totalCount} รายการ ✓`;
    badge.className = 'text-[11px] font-bold px-2 py-0.5 rounded bg-emerald-600 text-white border border-emerald-700';
  } else {
    badge.innerText = `ส่งคำสั่งแล้ว ${doneCount} / ${totalCount} รายการ`;
    badge.className = 'text-[11px] font-semibold px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200';
  }
}

function toggleOrderExecution(ticker, isChecked) {
  state.executedOrders = state.executedOrders || {};
  state.executedOrders[ticker] = isChecked;

  document.querySelectorAll('.qf-order-check').forEach(cb => {
    if (cb.dataset.ticker === ticker) cb.checked = isChecked;
  });

  const row = document.getElementById(`order-row-${ticker}`);
  if (row) row.classList.toggle('order-row-done', isChecked);

  const card = document.getElementById(`order-card-${ticker}`);
  if (card) card.classList.toggle('executed', isChecked);

  const plan = state.lastRebalancePlan;
  if (plan && plan.items) {
    const actionable = plan.items.filter(it => it.action === 'BUY' || it.action === 'SELL');
    const done = actionable.filter(it => !!state.executedOrders[it.ticker]).length;
    updateOrderExecProgressBadge(done, actionable.length);
  }
}

function renderDonutAllocationChart(weights, allTickers) {
  const container = document.getElementById('allocation-donut-chart');
  const entries = Object.entries(weights)
    .filter(([_, w]) => w > 0.001)
    .sort((a, b) => b[1] - a[1]);

  const labels = entries.map(([t]) => t);
  const values = entries.map(([_, w]) => Number((w * 100).toFixed(2)));
  const colors = labels.map(t => ASSET_COLORS[allTickers.indexOf(t) % ASSET_COLORS.length]);

  const ct = getChartThemeTokens();
  const trace = {
    labels: labels,
    values: values,
    type: 'pie',
    hole: 0.58,
    marker: {
      colors: colors,
      line: { color: ct.donutBorder, width: 2.5 }
    },
    textinfo: 'label+percent',
    textposition: 'outside',
    textfont: { family: 'Plus Jakarta Sans, Anuphan, sans-serif', size: 11, color: ct.donutLabel },
    hovertemplate: '<b>%{label}</b><br>สัดส่วนเป้าหมาย: %{value:.2f}%<extra></extra>'
  };

  const layout = {
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    margin: { l: 20, r: 20, t: 20, b: 20 },
    showlegend: false,
    annotations: [
      {
        font: { size: 11, color: ct.donutSub, family: 'Plus Jakarta Sans, Anuphan, sans-serif' },
        showarrow: false,
        text: 'พอร์ตเป้าหมาย',
        x: 0.5,
        y: 0.5
      }
    ]
  };

  Plotly.newPlot(container, [trace], layout, { responsive: true, displayModeBar: false });
}

/**
 * REQUIREMENT 1: Render Backtest Stress Test & Max Drawdown in Baht Card
 */
function renderBacktestStressCard() {
  const data = state.optData;
  if (!data) return;

  const strat = data.strategies[state.activeGoal];
  if (!strat) return;

  const budget = Number(data.metadata.budget) || 100000;
  const dd = strat.drawdown_details || {};
  const lossBaht = strat.max_drawdown_amount !== undefined
    ? strat.max_drawdown_amount
    : Number((Math.abs(strat.max_drawdown) * budget).toFixed(2));
  const remainingBaht = strat.min_capital_remaining !== undefined
    ? strat.min_capital_remaining
    : Number(Math.max(0, budget - lossBaht).toFixed(2));

  const mddPctAbs = Math.abs(strat.max_drawdown * 100).toFixed(2);
  const keepPct = Math.max(0, Math.min(100, 100 - Math.abs(strat.max_drawdown * 100))).toFixed(1);

  document.getElementById('bt-dd-initial-budget').innerText = formatMoney(budget, 2, true);
  document.getElementById('bt-dd-loss-baht').innerText = `-${formatMoney(lossBaht, 2, true)}`;
  document.getElementById('bt-dd-loss-pct').innerText = `คิดเป็น Max Drawdown -${mddPctAbs}% ของเงินต้น`;
  document.getElementById('bt-dd-remaining-baht').innerText = formatMoney(remainingBaht, 2, true);

  const periodEl = document.getElementById('bt-dd-period');
  const recEl = document.getElementById('bt-dd-recovery');
  if (dd.peak_date && dd.trough_date) {
    periodEl.innerText = `${dd.peak_date} ➔ ${dd.trough_date}`;
    if (dd.recovery_days !== null && dd.recovery_days !== undefined) {
      recEl.innerText = `ฟื้นตัวกลับจุดสูงสุดเดิมใน ${dd.recovery_days.toLocaleString()} วัน (${dd.recovery_date})`;
    } else {
      recEl.innerText = `จุดย่อตัวลึกสุดในรอบข้อมูลที่เลือก`;
    }
  } else {
    periodEl.innerText = `${data.metadata.start_date} ➔ ${data.metadata.end_date}`;
    recEl.innerText = `อ้างอิงข้อมูลราคาปิดจริง`;
  }

  document.getElementById('bt-bar-keep-label').innerText = `${formatMoney(remainingBaht, 0, true)} (${keepPct}%)`;
  document.getElementById('bt-bar-lose-label').innerText = `-${formatMoney(lossBaht, 0, true)} (-${mddPctAbs}%)`;
  document.getElementById('bt-bar-keep-fill').style.width = `${keepPct}%`;
  document.getElementById('bt-bar-lose-fill').style.width = `${100 - Number(keepPct)}%`;
}

function switchBacktestChartMode(mode) {
  state.backtestChartMode = mode;
  const btnWealth = document.getElementById('btn-bt-chart-wealth');
  const btnDd = document.getElementById('btn-bt-chart-drawdown');

  if (btnWealth && btnDd) {
    if (mode === 'wealth') {
      btnWealth.className = 'px-3.5 py-1.5 rounded-lg bg-[#00D084] text-[#0A0D12] font-extrabold transition cursor-pointer';
      btnDd.className = 'px-3.5 py-1.5 rounded-lg text-slate-600 hover:text-slate-900 font-semibold transition cursor-pointer';
    } else {
      btnDd.className = 'px-3.5 py-1.5 rounded-lg bg-[#FF5A5F] text-white font-extrabold transition cursor-pointer';
      btnWealth.className = 'px-3.5 py-1.5 rounded-lg text-slate-600 hover:text-slate-900 font-semibold transition cursor-pointer';
    }
  }

  renderPortfolioGrowthChart();
}

// Tab 1: Portfolio Growth Simulation OR Drawdown in Baht Chart
function renderPortfolioGrowthChart() {
  const data = state.optData;
  if (!data || !data.portfolio_growth) return;

  const container = document.getElementById('portfolio-growth-chart');
  const pg = data.portfolio_growth;
  const sym = state.currencySymbol;
  const unit = state.currencyUnitText;

  const namesMap = {
    max_sharpe: 'Max Sharpe (คุ้มความเสี่ยงสูงสุด)',
    min_volatility: 'Min Volatility (ผันผวนต่ำ)',
    hrp: 'Risk Parity (กระจายสมดุล)',
    equal_weight: 'Equal Weight (เท่ากัน 1/N)'
  };

  const isDrawdownMode = state.backtestChartMode === 'drawdown' && pg.drawdown_amount_series;
  const sourceSeries = isDrawdownMode ? pg.drawdown_amount_series : pg.series;

  const traces = Object.keys(sourceSeries).map(key => {
    const isSelected = key === state.activeGoal;
    return {
      x: pg.dates,
      y: sourceSeries[key],
      mode: 'lines',
      fill: isDrawdownMode && isSelected ? 'tozeroy' : 'none',
      fillcolor: isDrawdownMode && isSelected ? 'rgba(225, 29, 72, 0.10)' : undefined,
      name: namesMap[key] || key,
      line: {
        color: STRATEGY_COLORS[key],
        width: isSelected ? 3 : 1.75,
        dash: key === 'equal_weight' ? 'dot' : 'solid'
      },
      opacity: isSelected ? 1.0 : 0.7,
      hovertemplate: isDrawdownMode
        ? `<b>${namesMap[key]}</b><br>เงินที่หายไปจากจุดพีค (เทียบเงินต้น): %{y:,.2f} ${unit}<extra></extra>`
        : `<b>${namesMap[key]}</b><br>มูลค่าพอร์ต: ${sym}%{y:,.2f} (${unit})<extra></extra>`
    };
  });

  const ct = getChartThemeTokens();
  // Walk-Forward Out-of-Sample Rebalanced overlay (if available in Wealth view)
  const wf = data.walk_forward_backtest;
  if (!isDrawdownMode && wf && Array.isArray(wf.dates) && Array.isArray(wf.strategy_series) && wf.dates.length > 0) {
    const wfBudgetScale = (Number(data.metadata?.budget) || 100000) / Math.max(1, wf.strategy_series[0]);
    traces.push({
      x: wf.dates,
      y: wf.strategy_series.map(v => Number((v * wfBudgetScale).toFixed(2))),
      mode: 'lines',
      name: 'Walk-Forward OOS (ปรับพอร์ตรายไตรมาส + หักค่าธรรมเนียม)',
      line: { color: ct.wfLine, width: 2.2, dash: 'dashdot' },
      hovertemplate: `<b>Walk-Forward OOS</b><br>มูลค่าพอร์ตจริงนอกตัวอย่าง: ${sym}%{y:,.2f} (${unit})<extra></extra>`
    });
  }

  const layout = {
    paper_bgcolor: 'transparent',
    plot_bgcolor: ct.plotBg,
    margin: { l: 75, r: 20, t: 28, b: 40 },
    xaxis: {
      gridcolor: ct.grid,
      linecolor: ct.line,
      color: ct.axisText
    },
    yaxis: {
      title: isDrawdownMode ? `จำนวนเงินที่หายไป (${unit})` : `มูลค่าพอร์ต (${unit})`,
      gridcolor: ct.grid,
      linecolor: ct.line,
      color: isDrawdownMode ? '#FF6B70' : ct.axisText,
      tickprefix: sym
    },
    legend: {
      orientation: 'h',
      x: 0,
      y: 1.12,
      font: { size: 11, color: ct.legendText }
    },
    hovermode: 'x unified'
  };

  Plotly.newPlot(container, traces, layout, { responsive: true, displayModeBar: false });
}

function renderStrategyCompareTable() {
  const data = state.optData;
  if (!data) return;

  const tbody = document.getElementById('strategy-compare-table-body');
  const budget = Number(data.metadata.budget) || 100000;
  const order = ['max_sharpe', 'min_volatility', 'hrp', 'equal_weight'];

  tbody.innerHTML = order.map(key => {
    const s = data.strategies[key];
    const isSelected = key === state.activeGoal;
    const rowBg = isSelected ? 'bg-blue-50/70' : '';
    const mddBaht = s.max_drawdown_amount !== undefined
      ? s.max_drawdown_amount
      : Math.abs(s.max_drawdown) * budget;
    const minRemBaht = s.min_capital_remaining !== undefined
      ? s.min_capital_remaining
      : Math.max(0, budget - mddBaht);

    return `
      <tr class="${rowBg}">
        <td class="py-3.5 px-3.5 font-sans">
          <div class="flex items-center gap-2">
            <span class="w-2.5 h-2.5 rounded-full" style="background-color: ${STRATEGY_COLORS[key]}"></span>
            <span class="font-bold text-slate-900">${s.short_name}</span>
            ${isSelected ? `<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-[#00D084] text-[#0A0D12]">กำลังเลือก</span>` : ''}
          </div>
        </td>
        <td class="py-3.5 px-3.5 text-right tabular-nums">
          <div class="font-bold ${s.expected_return >= 0 ? 'text-emerald-700' : 'text-rose-700'}">${(s.expected_return * 100).toFixed(2)}%</div>
          <div class="text-[10px] text-slate-500">~${formatMoney(budget * s.expected_return, 0, true)}/ปี</div>
        </td>
        <td class="py-3.5 px-3.5 text-right text-slate-700 font-semibold tabular-nums">${(s.volatility * 100).toFixed(2)}%</td>
        <td class="py-3.5 px-3.5 text-right bg-rose-50/35 tabular-nums">
          <div class="font-bold text-rose-700">-${formatMoney(mddBaht, 2, true)}</div>
          <div class="text-[10px] text-rose-600">(${(s.max_drawdown * 100).toFixed(2)}% | เหลือต่ำสุด ${formatMoney(minRemBaht, 0, false)})</div>
        </td>
        <td class="py-3.5 px-3.5 text-right font-bold text-blue-700 tabular-nums">${s.sharpe_ratio.toFixed(2)}</td>
        <td class="py-3.5 px-3.5 text-right font-bold text-slate-900 tabular-nums">${formatMoney(s.final_historical_value, 2, false)}</td>
        <td class="py-3.5 px-3.5 text-center font-sans">
          ${isSelected
            ? `<span class="dime-pill-up">แสดงผลอยู่</span>`
            : `<button onclick="selectGoal('${key}')" class="px-3 py-1.5 text-xs font-bold bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 rounded-xl transition cursor-pointer">เลือกพอร์ตนี้</button>`
          }
        </td>
      </tr>
    `;
  }).join('');
}

// Tab 2: Clean Efficient Frontier Plot
function renderEfficientFrontierPlot() {
  const data = state.optData;
  if (!data) return;

  const container = document.getElementById('frontier-plot-container');
  const ef = data.efficient_frontier;
  const strats = data.strategies;

  const traces = [
    {
      x: ef.monte_carlo.map(p => p.vol),
      y: ef.monte_carlo.map(p => p.ret),
      mode: 'markers',
      name: 'พอร์ตสุ่มเปรียบเทียบ',
      marker: {
        size: 4,
        color: ef.monte_carlo.map(p => p.sharpe),
        colorscale: 'Blues',
        opacity: 0.35
      },
      hovertemplate: 'ความผันผวน: %{x:.2%}<br>ผลตอบแทน: %{y:.2%}<extra></extra>'
    }
  ];

  if (ef.curve && ef.curve.length > 0) {
    traces.push({
      x: ef.curve.map(p => p.vol),
      y: ef.curve.map(p => p.ret),
      mode: 'lines',
      name: 'เส้นพอร์ตที่มีประสิทธิภาพสูงสุด (Efficient Frontier)',
      line: { color: '#00D084', width: 2.8 },
      hoverinfo: 'skip'
    });
  }

  const ct = getChartThemeTokens();
  traces.push({
    x: data.asset_stats.map(a => a.volatility),
    y: data.asset_stats.map(a => a.expected_return),
    mode: 'markers+text',
    name: 'ถือหุ้นรายตัวเดี่ยวๆ',
    text: data.asset_stats.map(a => a.ticker),
    textposition: 'top center',
    textfont: { color: ct.legendText, size: 11, family: 'Plus Jakarta Sans, Anuphan, sans-serif' },
    marker: { size: 9, color: '#94A3B8', line: { color: ct.legendText, width: 1.5 } },
    hovertemplate: '<b>หุ้น %{text}</b><br>ความผันผวน: %{x:.2%}<br>ผลตอบแทนคาดหวัง: %{y:.2%}<extra></extra>'
  });

  const markerConfigs = [
    { key: 'max_sharpe', label: 'Max Sharpe', color: '#00D084', symbol: 'star', size: 16 },
    { key: 'min_volatility', label: 'Min Volatility', color: '#38BDF8', symbol: 'diamond', size: 13 },
    { key: 'hrp', label: 'Risk Parity (HRP)', color: '#A78BFA', symbol: 'circle', size: 13 },
    { key: 'equal_weight', label: 'Equal Weight (1/N)', color: '#FBBF24', symbol: 'square', size: 11 }
  ];

  markerConfigs.forEach(cfg => {
    const s = strats[cfg.key];
    traces.push({
      x: [s.volatility],
      y: [s.expected_return],
      mode: 'markers+text',
      name: cfg.label,
      text: [cfg.label],
      textposition: 'bottom center',
      textfont: { color: cfg.color, size: 11, family: 'Plus Jakarta Sans, Anuphan, sans-serif' },
      marker: {
        symbol: cfg.symbol,
        size: cfg.size,
        color: cfg.color,
        line: { color: ct.donutBorder, width: 2 }
      },
      hovertemplate: `<b>${cfg.label}</b><br>ความผันผวน: %{x:.2%}<br>ผลตอบแทนคาดหวัง: %{y:.2%}<br>Sharpe Ratio: ${s.sharpe_ratio.toFixed(2)}<extra></extra>`
    });
  });

  const layout = {
    paper_bgcolor: 'transparent',
    plot_bgcolor: ct.plotBg,
    margin: { l: 60, r: 20, t: 25, b: 50 },
    xaxis: {
      title: 'ความผันผวนต่อปี (ความเสี่ยง — ยิ่งซ้ายยิ่งแกว่งน้อย)',
      tickformat: '.0%',
      gridcolor: ct.grid,
      linecolor: ct.line,
      color: ct.axisText
    },
    yaxis: {
      title: 'ผลตอบแทนคาดหวังเฉลี่ยต่อปี (CAGR)',
      tickformat: '.0%',
      gridcolor: ct.grid,
      linecolor: ct.line,
      color: ct.axisText
    },
    legend: {
      orientation: 'h',
      x: 0,
      y: 1.1,
      font: { size: 11, color: ct.legendText }
    },
    hovermode: 'closest'
  };

  Plotly.newPlot(container, traces, layout, { responsive: true, displayModeBar: false });
}

// Tab 3: Individual Asset Stats Table & Correlation Matrix
function renderAssetStatsTable() {
  const data = state.optData;
  if (!data) return;

  const tbody = document.getElementById('asset-stats-table-body');
  const activeStrat = data.strategies[state.activeGoal];
  const budget = Number(data.metadata.budget) || 100000;
  const isTHB = getCurrentCurrency() === 'THB';
  const fx = Number(data.metadata?.usd_thb_rate || state.fxRate || 34.50);

  tbody.innerHTML = data.asset_stats.map(stat => {
    const t = stat.ticker;
    const color = ASSET_COLORS[data.metadata.tickers.indexOf(t) % ASSET_COLORS.length];
    const w = ((activeStrat.weights[t] || 0) * 100).toFixed(1);
    const mddBaht = stat.max_drawdown_amount !== undefined
      ? stat.max_drawdown_amount
      : Math.abs(stat.max_drawdown) * budget;
    const minRemBaht = stat.min_capital_remaining !== undefined
      ? stat.min_capital_remaining
      : Math.max(0, budget - mddBaht);

    const priceThb = stat.price_thb !== undefined ? stat.price_thb : (isTHB ? stat.latest_price : stat.latest_price * fx);
    const priceUsd = stat.price_usd !== undefined ? stat.price_usd : (isTHB ? stat.latest_price / fx : stat.latest_price);
    const companionPriceHtml = isTHB
      ? `<div class="text-[10px] text-slate-400 font-mono">($${Number(priceUsd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD)</div>`
      : `<div class="text-[10px] text-slate-400 font-mono">(฿${Number(priceThb).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} THB)</div>`;

    return `
      <tr>
        <td class="py-2.5 px-3 font-sans">
          <div class="flex items-center gap-2.5">
            ${renderStockLogoBadge(t, color, 28)}
            <span class="font-mono font-bold text-slate-900">${escapeHtmlText(t)}</span>
            <span class="text-xs text-slate-500 truncate">${stat.name !== t ? escapeHtmlText(stat.name) : ''}</span>
          </div>
        </td>
        <td class="py-2.5 px-3 text-right font-semibold text-slate-800">
          <div>${formatMoney(stat.latest_price, 2, false)}</div>
          ${companionPriceHtml}
        </td>
        <td class="py-2.5 px-3 text-right font-bold ${stat.expected_return >= 0 ? 'text-emerald-700' : 'text-rose-700'}">
          ${(stat.expected_return * 100).toFixed(2)}%
        </td>
        <td class="py-2.5 px-3 text-right text-slate-700">${(stat.volatility * 100).toFixed(2)}%</td>
        <td class="py-2.5 px-3 text-right bg-rose-50/35">
          <div class="font-bold text-rose-700">-${formatMoney(mddBaht, 2, true)}</div>
          <div class="text-[10px] text-rose-600">(${(stat.max_drawdown * 100).toFixed(2)}% | เหลือต่ำสุด ${formatMoney(minRemBaht, 0, false)})</div>
        </td>
        <td class="py-2.5 px-3 text-right font-bold ${Number(w) > 0 ? 'text-blue-700' : 'text-slate-400'}">${w}%</td>
      </tr>
    `;
  }).join('');
}

function renderCorrelationAndGrowthPlots() {
  const data = state.optData;
  if (!data) return;

  const corrContainer = document.getElementById('correlation-plot-container');
  const corr = data.correlation;

  const ct = getChartThemeTokens();
  const corrTrace = {
    z: corr.matrix,
    x: corr.tickers,
    y: corr.tickers,
    text: corr.matrix.map(row => row.map(v => v.toFixed(2))),
    texttemplate: '%{text}',
    textfont: { family: 'Plus Jakarta Sans, Anuphan, sans-serif', size: 11, color: ct.corrText },
    type: 'heatmap',
    colorscale: ct.corrScale,
    zmin: -0.2,
    zmax: 1.0,
    showscale: false,
    hovertemplate: '<b>%{x} vs %{y}</b><br>ความสัมพันธ์: %{z:.2f}<extra></extra>'
  };

  const corrLayout = {
    paper_bgcolor: 'transparent',
    plot_bgcolor: ct.plotBg,
    margin: { l: 55, r: 15, t: 15, b: 40 },
    xaxis: { color: ct.axisText, tickfont: { family: 'Plus Jakarta Sans, Anuphan, sans-serif', size: 11, color: ct.axisText } },
    yaxis: { color: ct.axisText, tickfont: { family: 'Plus Jakarta Sans, Anuphan, sans-serif', size: 11, color: ct.axisText }, autorange: 'reversed' }
  };

  Plotly.newPlot(corrContainer, [corrTrace], corrLayout, { responsive: true, displayModeBar: false });

  renderGrowth100Plot();
}

function renderGrowth100Plot() {
  const data = state.optData;
  if (!data) return;

  const ct = getChartThemeTokens();
  const container = document.getElementById('growth-plot-container');
  const growth = data.growth_100;
  const tickers = data.metadata.tickers;

  const traces = tickers.map((t, idx) => ({
    x: growth.dates,
    y: growth.series[t],
    mode: 'lines',
    name: t,
    line: { color: ASSET_COLORS[idx % ASSET_COLORS.length], width: 2 },
    hovertemplate: `<b>${t}</b>: %{y:,.1f}<extra></extra>`
  }));

  const layout = {
    paper_bgcolor: 'transparent',
    plot_bgcolor: ct.plotBg,
    margin: { l: 50, r: 15, t: 20, b: 40 },
    xaxis: { gridcolor: ct.grid, linecolor: ct.line, color: ct.axisText },
    yaxis: {
      type: state.growthLogScale ? 'log' : 'linear',
      gridcolor: ct.grid,
      linecolor: ct.line,
      color: ct.axisText
    },
    legend: {
      orientation: 'h',
      x: 0,
      y: 1.14,
      font: { size: 10, color: ct.legendText }
    },
    hovermode: 'x unified'
  };

  Plotly.newPlot(container, traces, layout, { responsive: true, displayModeBar: false });
}

function toggleGrowthScale(isLog) {
  state.growthLogScale = isLog;
  document.getElementById('btn-scale-log').className = isLog
    ? 'px-2.5 py-1 rounded-lg bg-[#00D084] text-[#0A0D12] font-extrabold cursor-pointer'
    : 'px-2.5 py-1 rounded-lg text-slate-600 font-semibold cursor-pointer';
  document.getElementById('btn-scale-linear').className = !isLog
    ? 'px-2.5 py-1 rounded-lg bg-[#00D084] text-[#0A0D12] font-extrabold cursor-pointer'
    : 'px-2.5 py-1 rounded-lg text-slate-600 font-semibold cursor-pointer';

  renderGrowth100Plot();
}

// Copy & Export Rebalance Order Sheet
function copyOrderSheet() {
  if (!state.optData || !state.lastRebalancePlan) return;
  const strat = state.optData.strategies[state.activeGoal];
  const plan = state.lastRebalancePlan;
  const mddBaht = strat.max_drawdown_amount || Math.abs(strat.max_drawdown) * plan.totalPortfolioBudget;

  let text = `สรุปแผนการปรับพอร์ตและคำสั่งซื้อ-ขาย — QuantFolio Wealth Analytics\n`;
  text += `กลยุทธ์เป้าหมาย: ${strat.name}\n`;
  text += `มูลค่าพอร์ตรวมที่ใช้คำนวณ: ${formatMoney(plan.totalPortfolioBudget, 2, true)}\n`;
  text += `ผลตอบแทนคาดหวัง: ${(strat.expected_return * 100).toFixed(2)}% ต่อปี | ความผันผวน: ${(strat.volatility * 100).toFixed(2)}%\n`;
  text += `จุดขาดทุนสูงสุดในอดีต (Max Drawdown): -${formatMoney(mddBaht, 2, true)} (${(strat.max_drawdown * 100).toFixed(2)}%)\n`;
  text += `==================================================\n`;

  if (plan.flowPairs.length > 0 && plan.sellOrders.length > 0) {
    text += `[สรุปคู่คำสั่งโยกย้ายเม็ดเงิน]\n`;
    plan.flowPairs.forEach((p, i) => {
      const fromText = p.fromIsCash ? `${p.fromName}` : `สั่งขาย ${p.fromTicker}`;
      text += `${i + 1}. ${fromText} เป็นเงิน ${formatMoney(p.sellAmount, 2, true)} ➔ นำไปสั่งซื้อ ${p.toTicker} เป็นเงิน ${formatMoney(p.buyAmount, 2, true)}\n`;
    });
    text += `--------------------------------------------------\n`;
  }

  if (plan.sellOrders.length > 0) {
    text += `[ขั้นตอนที่ 1: รายการสั่งขาย (SELL) เพื่อให้ได้เงินสด]\n`;
    plan.sellOrders.forEach(s => {
      text += `- ขาย ${s.ticker} (${s.name}): เป็นเงิน ${formatMoney(s.trade_amount, 2, true)} (ประมาณ ${s.trade_shares_fractional} หุ้น)\n`;
    });
    text += `รวมรับเงินจากการขาย: +${formatMoney(plan.totalSellGross, 2, true)}\n`;
    text += `--------------------------------------------------\n`;
  }

  if (plan.buyOrders.length > 0) {
    text += `[ขั้นตอนที่ 2: รายการสั่งซื้อ (BUY)]\n`;
    plan.buyOrders.forEach(b => {
      text += `- ซื้อ ${b.ticker} (${b.name}): เป็นเงิน ${formatMoney(b.trade_amount, 2, true)} (ประมาณ ${b.trade_shares_fractional} หุ้น @ ${formatMoney(b.price, 2, false)})\n`;
    });
    text += `รวมใช้เงินซื้อสุทธิ: ${formatMoney(plan.totalBuyNet, 2, true)} | เงินสดสำรองคงเหลือ: ${formatMoney(plan.leftoverCash, 2, true)}\n`;
  }

  const msg = 'คัดลอกคำสั่งซื้อ-ขายปรับพอร์ตเรียบร้อยแล้ว นำไปวางส่งคำสั่งได้ทันที';
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => showPortfolioToastApp(msg)).catch(() => showPortfolioToastApp(msg));
  } else {
    showPortfolioToastApp(msg);
  }
}

function downloadOrderCSV() {
  if (!state.optData || !state.lastRebalancePlan) return;
  const plan = state.lastRebalancePlan;

  let csv = '\uFEFFSymbol,CompanyName,Action,CurrentPrice,CurrentValue,TargetWeightPct,TargetValue,NetOrderAmount,WholeSharesToTrade,FractionalSharesToTrade\n';
  plan.items.forEach(item => {
    const signedAmt = item.action === 'SELL' ? -item.trade_amount : item.trade_amount;
    csv += `"${item.ticker}","${item.name}","${item.action}",${item.price},${item.current_value},${(item.target_weight * 100).toFixed(2)},${item.target_value},${signedAmt},${item.trade_shares_whole},${item.trade_shares_fractional}\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `QuantFolio_${state.activeGoal}_RebalancePlan.csv`);
  link.click();
}

// Switch Bottom Analytics Tabs (Dime! Segmented Pill Sub-Tabs)
function switchTab(tabId) {
  document.querySelectorAll('.tab-pane').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.className = 'tab-btn min-h-[40px] px-3.5 py-1.5 rounded-xl text-xs font-semibold text-slate-500 hover:text-slate-900 whitespace-nowrap transition cursor-pointer';
  });

  const pane = document.getElementById(`tab-content-${tabId}`);
  const btn = document.getElementById(`tab-btn-${tabId}`);
  if (pane) pane.classList.remove('hidden');
  if (btn) {
    btn.className = 'tab-btn min-h-[40px] px-3.5 py-1.5 rounded-xl text-xs font-extrabold bg-[#00D084] text-[#0A0D12] whitespace-nowrap transition cursor-pointer';
  }

  setTimeout(() => {
    ['portfolio-growth-chart', 'frontier-plot-container', 'correlation-plot-container', 'growth-plot-container'].forEach(id => {
      const el = document.getElementById(id);
      if (el && el.data && window.Plotly?.Plots?.resize) {
        try { Plotly.Plots.resize(el); } catch (e) {}
      }
    });
    window.dispatchEvent(new Event('resize'));
  }, 50);
}

// UI Helpers
function showLoading(show) {
  const card = document.getElementById('loading-card');
  const btn = document.getElementById('run-optimize-btn');
  if (show) {
    if (card) card.classList.remove('hidden');
    if (btn) {
      btn.disabled = true;
      btn.classList.add('opacity-60', 'cursor-not-allowed');
    }
  } else {
    if (card) card.classList.add('hidden');
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('opacity-60', 'cursor-not-allowed');
    }
  }
}

function showError(msg) {
  document.getElementById('error-message').innerText = msg;
  document.getElementById('error-banner').classList.remove('hidden');
}

function hideError() {
  document.getElementById('error-banner').classList.add('hidden');
}

// =========================================================================
// EXISTING PORTFOLIO AUDIT & DIAGNOSTIC ENGINE (MODE 2)
// =========================================================================
function renderExistingPortfolioAudit(plan, strat, data) {
  const auditBox = document.getElementById('existing-portfolio-audit-box');
  if (!auditBox) return;

  if (state.rebalanceMode !== 'custom' || !plan || plan.totalPortfolioBudget <= 0) {
    auditBox.classList.add('hidden');
    return;
  }

  const totalAssetsOnly = plan.items.reduce((acc, it) => acc + it.current_value, 0);
  if (totalAssetsOnly <= 0) {
    auditBox.classList.add('hidden');
    return;
  }

  auditBox.classList.remove('hidden');

  const tickers = data.metadata.tickers;
  const statsMap = {};
  data.asset_stats.forEach(s => { statsMap[s.ticker] = s; });

  // Current weights across total portfolio budget (including extra cash as 0-vol, rf-return)
  const totalBudget = plan.totalPortfolioBudget;
  const rf = Number(data.metadata.risk_free_rate) || 0.025;
  const wVec = tickers.map(t => {
    const val = Number(state.customHoldings[t]) || 0;
    return totalBudget > 0 ? (val / totalBudget) : 0;
  });
  const cashWeight = Math.max(0, 1 - wVec.reduce((a, b) => a + b, 0));

  // Expected Return of Current Portfolio
  let currReturn = cashWeight * rf;
  let weightedMdd = 0;
  let maxSingleWeight = 0;
  let maxSingleTicker = '-';

  tickers.forEach((t, idx) => {
    const w = wVec[idx];
    const st = statsMap[t];
    if (st) {
      currReturn += w * st.expected_return;
      weightedMdd += w * Math.abs(st.max_drawdown || 0.20);
    }
    if (w > maxSingleWeight) {
      maxSingleWeight = w;
      maxSingleTicker = t;
    }
  });

  // Portfolio Volatility using Covariance matrix if available
  let currVariance = 0;
  const covMatrix = data.covariance?.matrix;
  if (Array.isArray(covMatrix) && covMatrix.length === tickers.length) {
    for (let i = 0; i < tickers.length; i++) {
      for (let j = 0; j < tickers.length; j++) {
        currVariance += wVec[i] * wVec[j] * (Number(covMatrix[i][j]) || 0);
      }
    }
  } else {
    tickers.forEach((t, i) => {
      const vol = statsMap[t]?.volatility || 0.20;
      currVariance += (wVec[i] * vol) ** 2;
    });
  }
  const currVol = Math.sqrt(Math.max(0.0001, currVariance));
  const currSharpe = currVol > 1e-5 ? (currReturn - rf) / currVol : 0;
  const currMddAmt = weightedMdd * totalBudget;

  const targetReturn = strat.expected_return;
  const targetVol = strat.volatility;
  const targetSharpe = Number(strat.sharpe_ratio ?? strat.sharpe ?? 0);
  const targetMddPct = Math.abs(strat.max_drawdown);
  const targetMddAmt = strat.max_drawdown_amount || (targetMddPct * totalBudget);

  const sharpeDiff = targetSharpe - currSharpe;
  const returnDiffPct = (targetReturn - currReturn) * 100;
  const volDiffPct = (targetVol - currVol) * 100;

  let diagnosisBadges = [];
  if (maxSingleWeight > 0.45) {
    diagnosisBadges.push(`<span class="px-2 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300 text-[11px] font-bold">กระจุกตัวสูง: ${maxSingleTicker} คิดเป็น ${(maxSingleWeight * 100).toFixed(1)}% ของพอร์ต</span>`);
  } else {
    diagnosisBadges.push(`<span class="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-300 text-[11px] font-bold">การกระจายความเสี่ยงเริ่มต้นอยู่ในเกณฑ์สมดุล</span>`);
  }

  if (sharpeDiff > 0.05) {
    diagnosisBadges.push(`<span class="px-2 py-0.5 rounded bg-blue-100 text-blue-800 border border-blue-300 text-[11px] font-bold">การปรับพอร์ตช่วยเพิ่ม Sharpe Ratio +${sharpeDiff.toFixed(2)}</span>`);
  }

  auditBox.innerHTML = `
    <div class="flex flex-col md:flex-row md:items-center justify-between gap-2 pb-2.5 mb-3 border-b border-slate-200">
      <div>
        <div class="text-xs font-extrabold text-slate-900 uppercase tracking-wider">ผลตรวจสุขภาพพอร์ตปัจจุบันของคุณ เทียบกับพอร์ตเป้าหมาย (${strat.name})</div>
        <p class="text-[11px] text-slate-600 mt-0.5">เปรียบเทียบพอร์ตที่คุณถืออยู่จริง ณ ปัจจุบัน กับสัดส่วนพอร์ตเป้าหมายตามทฤษฎีเชิงปริมาณ</p>
      </div>
      <div class="flex flex-wrap gap-1.5">${diagnosisBadges.join('')}</div>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 text-xs">
      <div class="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
        <div class="text-[10px] font-bold text-slate-500 uppercase">ผลตอบแทนคาดหวัง/ปี</div>
        <div class="mt-1 flex items-baseline justify-between">
          <span class="text-slate-600">พอร์ตเดิม: <strong class="font-mono text-slate-900">${(currReturn * 100).toFixed(2)}%</strong></span>
          <span class="text-emerald-700 font-bold font-mono">➔ ${(targetReturn * 100).toFixed(2)}%</span>
        </div>
        <div class="text-[10px] mt-1 ${returnDiffPct >= 0 ? 'text-emerald-700' : 'text-slate-500'} font-semibold">
          ${returnDiffPct >= 0 ? `เพิ่มขึ้น +${returnDiffPct.toFixed(2)}% ต่อปี` : `ลดลง ${returnDiffPct.toFixed(2)}% เพื่อลดความเสี่ยง`}
        </div>
      </div>

      <div class="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
        <div class="text-[10px] font-bold text-slate-500 uppercase">ความผันผวนต่อปี (Risk)</div>
        <div class="mt-1 flex items-baseline justify-between">
          <span class="text-slate-600">พอร์ตเดิม: <strong class="font-mono text-slate-900">${(currVol * 100).toFixed(2)}%</strong></span>
          <span class="text-blue-700 font-bold font-mono">➔ ${(targetVol * 100).toFixed(2)}%</span>
        </div>
        <div class="text-[10px] mt-1 ${volDiffPct <= 0 ? 'text-emerald-700' : 'text-amber-700'} font-semibold">
          ${volDiffPct <= 0 ? `ความผันผวนลดลง ${volDiffPct.toFixed(2)}%` : `ความผันผวนเปลี่ยน +${volDiffPct.toFixed(2)}%`}
        </div>
      </div>

      <div class="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
        <div class="text-[10px] font-bold text-slate-500 uppercase">ความคุ้มค่า (Sharpe Ratio)</div>
        <div class="mt-1 flex items-baseline justify-between">
          <span class="text-slate-600">พอร์ตเดิม: <strong class="font-mono text-slate-900">${currSharpe.toFixed(2)}</strong></span>
          <span class="text-indigo-700 font-bold font-mono">➔ ${targetSharpe.toFixed(2)}</span>
        </div>
        <div class="text-[10px] mt-1 text-indigo-700 font-semibold">
          ${sharpeDiff >= 0 ? `ประสิทธิภาพดีขึ้น +${sharpeDiff.toFixed(2)} เท่า` : `เน้นกระจายความเสี่ยงตามโครงสร้าง`}
        </div>
      </div>

      <div class="p-2.5 rounded-lg bg-rose-50/60 border border-rose-200">
        <div class="text-[10px] font-bold text-rose-800 uppercase">จุดขาดทุนสูงสุดประเมิน</div>
        <div class="mt-1 flex items-baseline justify-between">
          <span class="text-rose-700 font-mono">-${formatMoney(currMddAmt, 0, true)}</span>
          <span class="text-rose-900 font-bold font-mono">➔ -${formatMoney(targetMddAmt, 0, true)}</span>
        </div>
        <div class="text-[10px] mt-1 text-rose-700 font-semibold">
          เป้าหมายคุม Drawdown ที่ -${(targetMddPct * 100).toFixed(1)}%
        </div>
      </div>
    </div>
  `;
}

// =========================================================================
// MARKET NEWS SENTIMENT & QUANTITATIVE BUY SIGNAL ENGINE
// =========================================================================
function toggleNewsSignalAdjustment(enable) {
  state.useNewsAdjustment = Boolean(enable);

  const cb = document.getElementById('news-signal-toggle') || document.getElementById('use-news-adjustment-checkbox');
  if (cb) cb.checked = state.useNewsAdjustment;

  const btnOn = document.getElementById('btn-news-adj-on');
  const btnOff = document.getElementById('btn-news-adj-off');
  if (btnOn && btnOff) {
    if (state.useNewsAdjustment) {
      btnOn.className = 'px-3.5 py-1.5 rounded-lg font-extrabold bg-[#00D084] text-[#0A0D12] transition cursor-pointer';
      btnOff.className = 'px-3.5 py-1.5 rounded-lg font-semibold text-slate-600 hover:text-slate-900 transition cursor-pointer';
    } else {
      btnOn.className = 'px-3.5 py-1.5 rounded-lg font-semibold text-slate-600 hover:text-slate-900 transition cursor-pointer';
      btnOff.className = 'px-3.5 py-1.5 rounded-lg font-extrabold bg-[#00D084] text-[#0A0D12] transition cursor-pointer';
    }
  }

  refreshAdvancedSummaryLabel();
  if (!state.optData) return;

  const budget = Number(state.optData.metadata?.budget) || 100000;

  // Instant switch using pre-computed historical_weights vs news_adjusted_weights
  Object.keys(state.optData.strategies).forEach(stratKey => {
    const strat = state.optData.strategies[stratKey];
    if (state.useNewsAdjustment && strat.news_adjusted_weights && strat.news_adjusted_metrics) {
      strat.weights = strat.news_adjusted_weights;
      Object.assign(strat, strat.news_adjusted_metrics);
      strat.expected_annual_profit = Number((strat.expected_return * budget).toFixed(2));
      strat.news_adjusted = true;
    } else if (!state.useNewsAdjustment && strat.historical_weights && strat.historical_metrics) {
      strat.weights = strat.historical_weights;
      Object.assign(strat, strat.historical_metrics);
      strat.expected_annual_profit = Number((strat.expected_return * budget).toFixed(2));
      strat.news_adjusted = false;
    }
  });

  state.optData.metadata.use_news_adjustment = state.useNewsAdjustment;
  renderAllViews();
}

function renderNewsAndSignalSection() {
  const data = state.optData;
  if (!data) return;

  const intel = data.market_intelligence || {};
  const assetIntelMap = intel.assets || {};
  const articles = intel.articles || [];
  const activeStrat = data.strategies[state.activeGoal];
  const isTHB = getCurrentCurrency() === 'THB';
  const fx = Number(data.metadata?.usd_thb_rate || state.fxRate || 34.50);

  // Sync toggle buttons & checkbox
  const cb = document.getElementById('news-signal-toggle') || document.getElementById('use-news-adjustment-checkbox');
  if (cb) cb.checked = state.useNewsAdjustment;

  const btnOn = document.getElementById('btn-news-adj-on');
  const btnOff = document.getElementById('btn-news-adj-off');
  if (btnOn && btnOff) {
    if (state.useNewsAdjustment) {
      btnOn.className = 'px-3 py-1.5 rounded-md font-bold bg-blue-600 text-white transition';
      btnOff.className = 'px-3 py-1.5 rounded-md font-semibold text-slate-600 hover:text-slate-900 transition';
    } else {
      btnOn.className = 'px-3 py-1.5 rounded-md font-semibold text-slate-600 hover:text-slate-900 transition';
      btnOff.className = 'px-3 py-1.5 rounded-md font-bold bg-slate-800 text-white transition';
    }
  }

  // Update news count badge
  const countBadge = document.getElementById('news-count-badge');
  if (countBadge) {
    countBadge.innerText = articles.length > 0
      ? `วิเคราะห์ข่าวตลาดจริงแล้ว ${articles.length} ข่าว (จาก Yahoo Finance & Google News)`
      : `ใช้สัญญาณแนวโน้มราคา (RSI-14 & SMA 50/200) เป็นตัวช่วยตัดสินใจ`;
  }

  // 1. Render Asset Signal & Entry Guidance Table
  const signalTbody = document.getElementById('news-signal-table-body');
  if (signalTbody) {
    signalTbody.innerHTML = data.asset_stats.map(stat => {
      const t = stat.ticker;
      const tech = stat.technical || assetIntelMap[t]?.technical || {};
      const newsObj = stat.news || {};
      const dec = stat.decision || assetIntelMap[t] || {};
      const histW = ((activeStrat.historical_weights?.[t] ?? activeStrat.weights[t] ?? 0) * 100).toFixed(1);
      const newsW = ((activeStrat.news_adjusted_weights?.[t] ?? activeStrat.weights[t] ?? 0) * 100).toFixed(1);
      const weightDiff = (Number(newsW) - Number(histW)).toFixed(1);

      const priceThb = stat.price_thb !== undefined ? stat.price_thb : (isTHB ? stat.latest_price : stat.latest_price * fx);
      const priceUsd = stat.price_usd !== undefined ? stat.price_usd : (isTHB ? stat.latest_price / fx : stat.latest_price);

      const sentScore = Number(dec.news_sentiment_score ?? newsObj.news_sentiment_score ?? 0);
      const sentBadge = sentScore > 0.12
        ? `<span class="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-300 text-[10px] font-bold">เชิงบวก (+${sentScore.toFixed(2)})</span>`
        : sentScore < -0.12
        ? `<span class="px-2 py-0.5 rounded bg-rose-100 text-rose-800 border border-rose-300 text-[10px] font-bold">ระมัดระวัง (${sentScore.toFixed(2)})</span>`
        : `<span class="px-2 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-300 text-[10px] font-bold">เป็นกลาง (${sentScore.toFixed(2)})</span>`;

      const signalLevel = dec.signal_level || 'NEUTRAL_ACCUMULATE';
      let actionBadgeClass = 'bg-blue-100 text-blue-800 border-blue-300';
      if (signalLevel === 'POSITIVE_BUY') actionBadgeClass = 'bg-emerald-100 text-emerald-900 border-emerald-300';
      else if (signalLevel === 'OVERBOUGHT_TRANCHE') actionBadgeClass = 'bg-amber-100 text-amber-900 border-amber-300';
      else if (signalLevel === 'CAUTIOUS_SHIELD') actionBadgeClass = 'bg-rose-100 text-rose-900 border-rose-300';

      const diffHtml = Number(weightDiff) > 0
        ? `<span class="text-emerald-700 font-bold">(+${weightDiff}%)</span>`
        : Number(weightDiff) < 0
        ? `<span class="text-rose-700 font-bold">(${weightDiff}%)</span>`
        : `<span class="text-slate-400">(0.0%)</span>`;

      const mom1mPct = tech.momentum_1m !== undefined ? (tech.momentum_1m * 100) : 0;
      const newsCount = (newsObj.articles ? newsObj.articles.length : 0);

      return `
        <tr class="hover:bg-slate-50/90 transition">
          <td class="py-2.5 px-3 font-sans">
            <div class="flex items-center gap-2.5">
              ${renderStockLogoBadge(t, ASSET_COLORS[data.metadata.tickers.indexOf(t) % ASSET_COLORS.length], 30)}
              <div>
                <div class="font-mono font-bold text-slate-900">${escapeHtmlText(t)}</div>
                <div class="text-[11px] text-slate-500 truncate max-w-[140px]">${escapeHtmlText(stat.name)}</div>
              </div>
            </div>
          </td>
          <td class="py-2.5 px-3 text-right font-mono">
            <div class="font-bold text-slate-900">฿${Number(priceThb).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
            <div class="text-[11px] text-blue-700 font-semibold">$${Number(priceUsd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD</div>
          </td>
          <td class="py-2.5 px-3 text-center font-sans">
            <div class="text-xs font-bold text-slate-800">${escapeHtmlText(tech.trend_label_th || 'ทรงตัว')}</div>
            <div class="text-[10px] text-slate-500 font-mono">RSI(14): ${tech.rsi_14 !== undefined ? tech.rsi_14.toFixed(1) : '50.0'} | 1M: ${mom1mPct >= 0 ? '+' : ''}${mom1mPct.toFixed(1)}%</div>
          </td>
          <td class="py-2.5 px-3 text-center font-sans">
            <div>${sentBadge}</div>
            <div class="text-[10px] text-slate-500 mt-0.5">ข่าวที่วิเคราะห์: ${newsCount} ข่าว</div>
          </td>
          <td class="py-2.5 px-3 text-right font-mono">
            <div class="text-slate-600">${histW}% ➔ <strong class="text-slate-900">${newsW}%</strong></div>
            <div class="text-[10px]">${diffHtml}</div>
          </td>
          <td class="py-2.5 px-3 font-sans">
            <span class="inline-block px-2 py-0.5 rounded border text-[10px] font-bold ${actionBadgeClass}">
              ${escapeHtmlText(dec.signal_badge_th || 'สมดุล/สะสมตามแผน')} — ${escapeHtmlText(dec.execution_tactic_th || 'จัดสรรตามสัดส่วนมาตรฐาน')}
            </span>
            <p class="text-[11px] text-slate-600 mt-1 leading-relaxed">${escapeHtmlText(dec.decision_reason_th || '-')}</p>
          </td>
        </tr>
      `;
    }).join('');
  }

  // 2. Render Live Market News Articles Grid
  const newsGrid = document.getElementById('market-news-articles-grid');
  if (newsGrid) {
    if (!articles || articles.length === 0) {
      newsGrid.innerHTML = `
        <div class="col-span-2 p-4 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-500 text-center">
          ไม่พบหัวข้อข่าวล่าสุดในช่วงเวลานี้ ระบบใช้สัญญาณแนวโน้มราคา (Technical Trend & RSI) เป็นตัวช่วยตัดสินใจหลัก
        </div>
      `;
    } else {
      newsGrid.innerHTML = articles.slice(0, 8).map((art, idx) => {
        const sent = (art.sentiment || art.sentiment_label || 'neutral').toLowerCase();
        const sentPillCls = sent === 'positive'
          ? 'dime-pill-up'
          : sent === 'negative'
          ? 'dime-pill-down'
          : 'px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200 text-[11px] font-bold';
        const safeHref = sanitizeExternalUrl(art.link);
        const safeTicker = escapeHtmlText(art.ticker);
        const safePublisher = escapeHtmlText(art.publisher || 'Financial News');
        const safeSentiment = escapeHtmlText(art.sentiment_label_th || 'เป็นกลาง');
        const safeTitle = escapeHtmlText(art.title);
        const safePubAt = escapeHtmlText(art.published_at || 'ล่าสุด');
        const tickerIdx = Math.max(0, (data.metadata?.tickers || []).indexOf(art.ticker));
        const logoHtml = renderStockLogoBadge(art.ticker, ASSET_COLORS[(tickerIdx >= 0 ? tickerIdx : idx) % ASSET_COLORS.length], 36);

        return `
          <a href="${safeHref}" target="_blank" rel="noopener noreferrer"
            class="dime-holding-row !items-start flex-col gap-2.5 group">
            <div class="w-full flex items-center justify-between gap-2">
              <div class="flex items-center gap-2.5 min-w-0">
                ${logoHtml}
                <div class="min-w-0">
                  <div class="font-mono text-xs font-extrabold text-slate-900">${safeTicker}</div>
                  <div class="dime-label-12 truncate max-w-[170px]">${safePublisher}</div>
                </div>
              </div>
              <span class="${sentPillCls} shrink-0">${safeSentiment}</span>
            </div>
            <div class="w-full text-sm font-bold text-slate-900 group-hover:text-[#00A86B] leading-snug line-clamp-2">${safeTitle}</div>
            <div class="w-full pt-1 border-t border-slate-100 flex items-center justify-between dime-label-12">
              <span>เผยแพร่: ${safePubAt}</span>
              <span class="text-[#00A86B] font-bold group-hover:underline">อ่านข่าวต้นฉบับ ➔</span>
            </div>
          </a>
        `;
      }).join('');
    }
  }
}

async function refreshLiveMarketNews() {
  if (!state.tickers || state.tickers.length === 0) return;
  const newsGrid = document.getElementById('market-news-articles-grid');
  if (newsGrid) {
    newsGrid.innerHTML = `<div class="col-span-2 p-4 text-center text-xs text-slate-500">กำลังดึงข้อมูลข่าวสารตลาดล่าสุดจาก Yahoo Finance และ Google News...</div>`;
  }
  try {
    const q = encodeURIComponent(state.tickers.join(','));
    const res = await fetch(`/api/market-news?tickers=${q}`);
    if (!res.ok) throw new Error('ไม่สามารถดึงข่าวตลาดได้');
    const newsData = await res.json();
    if (state.optData && state.optData.market_intelligence) {
      state.optData.market_intelligence.articles = newsData.articles || [];
      renderNewsAndSignalSection();
    }
  } catch (err) {
    console.warn('News refresh error:', err);
    if (state.optData) renderNewsAndSignalSection();
  }
}

// =========================================================================
// AUTOMATED SYSTEM VERIFICATION & SELF-TEST SUITE
// =========================================================================
async function runSystemVerificationModal() {
  const panel = document.getElementById('system-verify-panel');
  const grid = document.getElementById('system-verify-results') || document.getElementById('system-verify-results-grid');
  if (!panel || !grid) return;

  panel.classList.remove('hidden');
  grid.innerHTML = `
    <div class="col-span-full p-4 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 font-medium">
      กำลังรันชุดทดสอบความถูกต้องของระบบ (Real-time Market Feed, Dual Currency THB/USD, Portfolio Solver, Rebalance Engine, Market News Signal)...
    </div>
  `;

  try {
    const res = await fetch('/api/system/verify');
    const data = await res.json();
    const checks = data.checks || [];

    // Also verify client-side Rebalance Cash Conservation
    if (state.lastRebalancePlan) {
      const plan = state.lastRebalancePlan;
      const diff = Math.abs((plan.totalBuyNet + plan.leftoverCash) - (plan.totalSellGross + (Number(plan.cashInjection) || 0)));
      const clientPass = diff <= 1.0 && plan.totalPortfolioBudget > 0;
      checks.push({
        id: 'client_rebalance_integrity',
        name: 'ตรวจสอบสมการใบสั่งซื้อ-ขายปรับพอร์ต (Client Rebalance Audit)',
        passed: clientPass,
        detail: `งบพอร์ตรวม ${formatMoney(plan.totalPortfolioBudget, 2, true)} | ซื้อสุทธิ ${formatMoney(plan.totalBuyNet, 2, true)} | เงินสดคงเหลือ ${formatMoney(plan.leftoverCash, 2, true)}`
      });
    }

    grid.innerHTML = checks.map(c => `
      <div class="p-3 rounded-lg border ${c.passed ? 'bg-emerald-50/70 border-emerald-200' : 'bg-rose-50/70 border-rose-200'}">
        <div class="flex items-center justify-between gap-2 mb-1">
          <span class="text-xs font-bold ${c.passed ? 'text-emerald-950' : 'text-rose-950'}">${escapeHtmlText(c.name)}</span>
          <span class="px-2 py-0.5 rounded text-[10px] font-extrabold uppercase ${c.passed ? 'bg-emerald-600 text-white' : 'bg-rose-600 text-white'}">
            ${c.passed ? 'PASSED' : 'CHECK'}
          </span>
        </div>
        <p class="text-[11px] text-slate-600 leading-relaxed font-mono">${escapeHtmlText(c.detail)}</p>
      </div>
    `).join('');
  } catch (err) {
    grid.innerHTML = `
      <div class="col-span-full p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800">
        เกิดข้อผิดพลาดในการเชื่อมต่อชุดทดสอบระบบ: ${escapeHtmlText(err.message)}
      </div>
    `;
  }
}

// =========================================================================
// GOAL-BASED PORTFOLIO BUILDER, DCA SIMULATOR & ONE-PAGE REPORT ENGINE
// =========================================================================
const GOAL_TEMPLATES = {
  retirement: {
    key: 'retirement',
    name: 'พอร์ตเกษียณมั่นคงระยะยาว',
    category: 'retirement',
    label: 'พอร์ตเกษียณมั่นคง',
    target_thb: 2000000,
    target_usd: 60000,
    budget_thb: 100000,
    budget_usd: 3000,
    dca_thb: 5000,
    dca_usd: 150,
    years: 10,
    strategy: 'max_sharpe',
    tickers: ['SPY', 'QQQ', 'AAPL', 'MSFT', 'GLD', 'PTT.BK', 'BDMS.BK']
  },
  dividend: {
    key: 'dividend',
    name: 'พอร์ตสร้างกระแสเงินสดและเงินปันผล',
    category: 'dividend',
    label: 'พอร์ตสร้างเงินปันผล',
    target_thb: 1000000,
    target_usd: 30000,
    budget_thb: 100000,
    budget_usd: 3000,
    dca_thb: 4000,
    dca_usd: 120,
    years: 7,
    strategy: 'min_volatility',
    tickers: ['PTT.BK', 'ADVANC.BK', 'SCB.BK', 'KBANK.BK', 'JNJ', 'KO', 'PG']
  },
  growth: {
    key: 'growth',
    name: 'พอร์ตปั้นเงินล้านเติบโตเร่งด่วน',
    category: 'growth',
    label: 'พอร์ตเติบโตสูง',
    target_thb: 1000000,
    target_usd: 30000,
    budget_thb: 100000,
    budget_usd: 3000,
    dca_thb: 6000,
    dca_usd: 180,
    years: 5,
    strategy: 'max_sharpe',
    tickers: ['NVDA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'BTC-USD']
  },
  preservation: {
    key: 'preservation',
    name: 'พอร์ตพักเงินปลอดภัยชนะเงินเฟ้อ',
    category: 'preservation',
    label: 'พอร์ตพักเงินปลอดภัย',
    target_thb: 500000,
    target_usd: 15000,
    budget_thb: 100000,
    budget_usd: 3000,
    dca_thb: 3000,
    dca_usd: 100,
    years: 5,
    strategy: 'hrp',
    tickers: ['GLD', 'TLT', 'SPY', 'BDMS.BK', 'CPALL.BK']
  }
};

function scrollToSectionById(sectionId) {
  const el = document.getElementById(sectionId);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function switchAppTab(tabKey) {
  const validTabs = ['setup', 'trade-plan', 'insights', 'backtest', 'goals'];
  const nextTab = validTabs.includes(tabKey) ? tabKey : 'setup';
  state.activeTab = nextTab;

  validTabs.forEach(k => {
    const viewEl = document.getElementById(`tab-view-${k}`);
    if (viewEl) viewEl.classList.toggle('hidden', k !== nextTab);

    const btnEl = document.getElementById(`main-tab-${k}`);
    if (btnEl) btnEl.classList.toggle('active', k === nextTab);
  });

  const stripEl = document.getElementById('global-result-strip');
  if (stripEl) {
    if (nextTab !== 'setup' && state.optData) {
      stripEl.classList.remove('hidden');
    } else {
      stripEl.classList.add('hidden');
    }
  }

  setTimeout(() => {
    if (nextTab === 'trade-plan' && state.optData) {
      const strat = state.optData.strategies?.[state.activeGoal];
      if (strat) renderDonutAllocationChart(strat.weights, state.optData.metadata?.tickers || []);
    } else if (nextTab === 'backtest' && state.optData) {
      renderPortfolioGrowthChart();
      renderEfficientFrontierPlot();
      renderCorrelationAndGrowthPlots();
    } else if (nextTab === 'goals') {
      recalculateGoalProjection();
    }
    ['allocation-donut-chart', 'portfolio-growth-chart', 'frontier-plot-container', 'correlation-plot-container', 'growth-plot-container', 'goal-projection-chart'].forEach(id => {
      const chartEl = document.getElementById(id);
      if (chartEl && chartEl.data && window.Plotly?.Plots?.resize) {
        try { Plotly.Plots.resize(chartEl); } catch (e) {}
      }
    });
    window.dispatchEvent(new Event('resize'));
  }, 60);

  if (window.lucide) {
    lucide.createIcons();
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toggleBalancePrivacy() {
  state.balancePrivacyHidden = !state.balancePrivacyHidden;
  const iconEl = document.getElementById('balance-privacy-icon');
  if (iconEl) {
    iconEl.setAttribute('data-lucide', state.balancePrivacyHidden ? 'eye-off' : 'eye');
    if (window.lucide) lucide.createIcons();
  }
  renderDimeWealthOverview();
}

function renderDimeWealthOverview() {
  const netWorthEl = document.getElementById('dime-total-net-worth');
  if (!netWorthEl) return;

  const fx = state.fxRate > 0 ? state.fxRate : 34.50;
  const isThb = state.currency === 'THB';
  const budget = parseNumericInput(document.getElementById('budget-input')?.value) || (isThb ? 100000 : 3000);
  const totalThb = isThb ? budget : budget * fx;
  const totalUsd = isThb ? (budget / fx) : budget;

  const data = state.optData;
  const strat = data?.strategies?.[state.activeGoal] || null;
  const allTickers = data?.metadata?.tickers || state.tickers || [];

  const expRet = strat ? Number(strat.expected_return || 0) : 0.2485;
  const expProfit = Number((budget * expRet).toFixed(2));
  const isPos = expRet >= 0;
  const retSign = isPos ? '+' : '-';

  const subEl = document.getElementById('dime-total-net-worth-sub');
  const badgeEl = document.getElementById('dime-daily-return-badge');
  const stratLabelEl = document.getElementById('dime-active-strat-label');
  const modeLabelEl = document.getElementById('dime-alloc-mode-label');

  if (stratLabelEl) {
    if (strat) {
      stratLabelEl.innerText = `กลยุทธ์: ${strat.name} • ความผันผวน ${(strat.volatility * 100).toFixed(1)}% • Sharpe ${strat.sharpe_ratio.toFixed(2)}`;
    } else {
      stratLabelEl.innerText = 'กำลังคำนวณผลตอบแทนคาดหวังจากข้อมูลราคาจริง...';
    }
  }
  if (modeLabelEl && strat) {
    modeLabelEl.innerText = `${allTickers.length} สินทรัพย์ในพอร์ต (รวม 100%)`;
  }

  if (state.balancePrivacyHidden) {
    netWorthEl.innerText = `${state.currencySymbol} ••••••••`;
    if (subEl) subEl.innerText = isThb ? '≈ $ •••••• USD' : '≈ ฿ •••••••• THB';
    if (badgeEl) {
      badgeEl.className = isPos ? 'dime-pill-up tabular-nums' : 'dime-pill-down tabular-nums';
      badgeEl.innerText = `${retSign}${state.currencySymbol} ••••••/ปี (${retSign}${(Math.abs(expRet) * 100).toFixed(2)}%)`;
    }
  } else {
    netWorthEl.innerText = formatMoney(budget, 2, false);
    if (subEl) {
      subEl.innerText = isThb
        ? `≈ $${totalUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`
        : `≈ ฿${totalThb.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} THB`;
    }
    if (badgeEl) {
      badgeEl.className = isPos ? 'dime-pill-up tabular-nums' : 'dime-pill-down tabular-nums';
      badgeEl.innerText = `${retSign}${formatMoney(Math.abs(expProfit), 2, false)}/ปี (${retSign}${(Math.abs(expRet) * 100).toFixed(2)}%)`;
    }
  }

  // Build sorted list of portfolio stocks with their real calculated weights
  const statMap = {};
  (data?.asset_stats || []).forEach(s => { statMap[s.ticker] = s; });

  const eqWeight = allTickers.length > 0 ? (1.0 / allTickers.length) : 0;
  const stockItems = allTickers.map((t, idx) => {
    const w = strat && strat.weights && strat.weights[t] !== undefined
      ? Number(strat.weights[t])
      : eqWeight;
    const stat = statMap[t] || {};
    const q = state.tickerQuotes[t] || {};
    const color = ASSET_COLORS[idx % ASSET_COLORS.length];
    return {
      ticker: t,
      name: stat.name || q.name || t,
      weight: w,
      color,
      stat,
      quote: q
    };
  }).sort((a, b) => b.weight - a.weight);

  // 1. Render Stacked Allocation Bar & Legend Grid from real stock weights
  const barEl = document.getElementById('dime-alloc-stacked-bar');
  const legendEl = document.getElementById('dime-alloc-legend-grid');
  const activeWeighted = stockItems.filter(it => it.weight > 0.001);
  const displayWeighted = activeWeighted.length > 0 ? activeWeighted : stockItems;

  if (barEl) {
    barEl.innerHTML = displayWeighted.map((it, idx) => {
      const pct = Math.max(1.5, Number((it.weight * 100).toFixed(1)));
      const radiusCls = idx === 0
        ? 'rounded-l-full'
        : (idx === displayWeighted.length - 1 ? 'rounded-r-full' : '');
      return `<div style="width: ${pct}%; background-color: ${it.color};" class="h-full ${radiusCls} transition-all duration-300" title="${escapeHtmlText(it.ticker)}: ${(it.weight * 100).toFixed(1)}%"></div>`;
    }).join('');
  }

  if (legendEl) {
    legendEl.innerHTML = stockItems.map(it => {
      const wPct = (it.weight * 100).toFixed(1);
      const allocAmt = budget * it.weight;
      const amtText = state.balancePrivacyHidden ? `${state.currencySymbol}••••` : formatMoney(allocAmt, 0, false);
      return `
        <div class="p-2.5 rounded-xl bg-[#F8F9FA] border border-[#ECEEF1]">
          <div class="flex items-center justify-between gap-1">
            <span class="inline-flex items-center gap-1.5 min-w-0">
              ${renderStockLogoBadge(it.ticker, it.color, 20)}
              <span class="text-xs font-bold text-[#1A1D1F] font-mono truncate">${escapeHtmlText(it.ticker)}</span>
            </span>
            <span class="text-xs font-extrabold text-[#1A1D1F] tabular-nums">${wPct}%</span>
          </div>
          <div class="dime-label-12 mt-0.5 tabular-nums truncate">${amtText}</div>
        </div>
      `;
    }).join('');
  }

  // 2. Render Right Card: Real Portfolio Stocks & Calculated Target Allocation
  const listEl = document.getElementById('dime-holdings-card-list');
  if (!listEl) return;

  if (stockItems.length === 0) {
    listEl.innerHTML = `<div class="p-4 text-center dime-label-12">กรุณาเลือกหุ้นในพอร์ตอย่างน้อย 2 รายการ</div>`;
    return;
  }

  listEl.innerHTML = stockItems.map(it => {
    const safeTicker = escapeHtmlText(it.ticker);
    const safeName = escapeHtmlText(it.name !== it.ticker ? it.name : (it.ticker.endsWith('.BK') ? 'หุ้นไทย (SET)' : 'Global Equity'));
    const shortCode = safeTicker.replace('.BK', '').replace('-USD', '').slice(0, 4);
    const wPct = (it.weight * 100).toFixed(1);
    const targetValCurrent = budget * it.weight;
    const targetValThb = isThb ? targetValCurrent : targetValCurrent * fx;
    const targetValUsd = isThb ? (targetValCurrent / fx) : targetValCurrent;

    // Price per share in current currency to show estimated share count
    const isThai = it.ticker.endsWith('.BK');
    let unitPriceCurrent = Number(it.stat.latest_price || 0);
    if (!unitPriceCurrent && it.quote.price) {
      unitPriceCurrent = isThb
        ? (isThai ? it.quote.price : it.quote.price * fx)
        : (isThai ? it.quote.price / fx : it.quote.price);
    }
    const estShares = (unitPriceCurrent > 0 && targetValCurrent > 0)
      ? (targetValCurrent / unitPriceCurrent).toFixed(2)
      : '0.00';

    const assetRet = it.stat.expected_return !== undefined
      ? Number(it.stat.expected_return)
      : ((it.quote.change_pct || 0) / 100);
    const assetRetPct = (Math.abs(assetRet) * 100).toFixed(2);
    const assetIsUp = assetRet >= 0;
    const retLabel = it.stat.expected_return !== undefined
      ? `${assetIsUp ? '+' : '-'}${assetRetPct}% / ปี`
      : `${assetIsUp ? '+' : '-'}${assetRetPct}% วันนี้`;

    const primaryStr = isThb
      ? `฿${targetValThb.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : `$${targetValUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const secondaryStr = isThb
      ? `($${targetValUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`
      : `(฿${targetValThb.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })})`;

    const valDisplay = state.balancePrivacyHidden
      ? `${state.currencySymbol} ••••••`
      : `${primaryStr} <span class="text-xs font-normal text-[#6C757D]">${secondaryStr}</span>`;

    return `
      <div class="dime-holding-row cursor-pointer" onclick="syncHoldingsWithQuantPlan()">
        <div class="flex items-center gap-3 min-w-0">
          ${renderStockLogoBadge(it.ticker, it.color, 42)}
          <div class="min-w-0">
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="font-bold text-sm text-[#1A1D1F] font-mono">${safeTicker}</span>
              <span class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-[#E6FBF3] text-[#008A57] tabular-nums">สัดส่วน ${wPct}%</span>
            </div>
            <div class="dime-label-12 truncate">${safeName} • ~${estShares} หุ้น</div>
          </div>
        </div>
        <div class="text-right shrink-0">
          <div class="font-bold text-sm text-[#1A1D1F] tabular-nums">${valDisplay}</div>
          <div class="mt-1"><span class="${assetIsUp ? 'dime-pill-up' : 'dime-pill-down'}">${retLabel}</span></div>
        </div>
      </div>
    `;
  }).join('');
}

function syncHoldingsWithQuantPlan() {
  if (state.activeTab !== 'trade-plan') {
    switchAppTab('trade-plan');
  }
  const execCard = document.getElementById('step-3-execution-card');
  if (execCard) {
    execCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function toggleTradePlanViewMode(mode) {
  const nextMode = mode === 'table' ? 'table' : 'cards';
  state.tradePlanViewMode = nextMode;

  const cardsWrap = document.getElementById('orders-checklist-cards-wrapper');
  const tableWrap = document.getElementById('orders-table-wrapper');
  const btnCards = document.getElementById('tp-view-btn-cards');
  const btnTable = document.getElementById('tp-view-btn-table');

  if (cardsWrap) cardsWrap.classList.toggle('hidden', nextMode !== 'cards');
  if (tableWrap) tableWrap.classList.toggle('hidden', nextMode !== 'table');

  if (btnCards) {
    btnCards.className = nextMode === 'cards'
      ? 'px-2.5 py-1 rounded-md font-bold bg-slate-900 text-white transition cursor-pointer'
      : 'px-2.5 py-1 rounded-md font-semibold text-slate-600 hover:text-slate-900 transition cursor-pointer';
  }
  if (btnTable) {
    btnTable.className = nextMode === 'table'
      ? 'px-2.5 py-1 rounded-md font-bold bg-slate-900 text-white transition cursor-pointer'
      : 'px-2.5 py-1 rounded-md font-semibold text-slate-600 hover:text-slate-900 transition cursor-pointer';
  }
}

function toggleSetupAdvancedDrawer() {
  const drawer = document.getElementById('setup-advanced-drawer');
  const chevron = document.getElementById('setup-advanced-chevron');
  if (!drawer) return;
  const isNowHidden = drawer.classList.toggle('hidden');
  if (chevron) {
    chevron.classList.toggle('rotate-180', !isNowHidden);
  }
}

function refreshAdvancedSummaryLabel() {
  const el = document.getElementById('setup-advanced-summary');
  if (!el) return;
  const fxVal = parseNumericInput(document.getElementById('fx-rate-input')?.value) || state.fxRate || 34.50;
  const maxW = parseInt(document.getElementById('max-weight-slider')?.value || '100', 10);
  const startVal = document.getElementById('start-date-input')?.value || '';
  const endVal = document.getElementById('end-date-input')?.value || '';
  const yearsText = (startVal && endVal && endVal.length >= 4 && startVal.length >= 4)
    ? `${startVal.slice(0, 4)}-${endVal.slice(0, 4)}`
    : '3 ปี';
  const weightText = maxW >= 100 ? 'ไม่จำกัดเพดาน' : `เพดาน ${maxW}%`;
  const newsText = state.useNewsAdjustment ? 'ข่าว: เปิด' : 'ข่าว: ปิด';
  el.innerText = `FX ${fxVal.toFixed(2)} • ${yearsText} • ${weightText} • ${newsText}`;
}

function openHelpGuideModal() {
  const modal = document.getElementById('help-guide-modal');
  if (modal) {
    modal.classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
  }
}

function switchMainCategory(catKey, shouldScroll = false) {
  const tabMap = {
    orders: 'trade-plan',
    news: 'insights',
    backtest: 'backtest',
    goals: 'goals'
  };
  switchAppTab(tabMap[catKey] || 'trade-plan');
}

function scrollToGoalBuilderSection() {
  switchAppTab('goals');
}

function applyGoalBasedTemplate(templateKey, shouldScroll = false) {
  const tpl = GOAL_TEMPLATES[templateKey];
  if (!tpl) return;

  const isThb = state.currency === 'THB';
  const nameEl = document.getElementById('save-portfolio-name');
  const catEl = document.getElementById('save-goal-category');
  const targetEl = document.getElementById('save-target-amount');
  const dcaEl = document.getElementById('save-monthly-dca');
  const yearsEl = document.getElementById('save-period-years');
  const budgetEl = document.getElementById('budget-input');
  const stripBudgetEl = document.getElementById('strip-budget-input');

  const formattedBudget = formatNumberWithCommas(isThb ? tpl.budget_thb : tpl.budget_usd, 0);
  if (nameEl) nameEl.value = tpl.name;
  if (catEl) catEl.value = tpl.category;
  if (targetEl) targetEl.value = formatNumberWithCommas(isThb ? tpl.target_thb : tpl.target_usd, 0);
  if (dcaEl) dcaEl.value = formatNumberWithCommas(isThb ? tpl.dca_thb : tpl.dca_usd, 0);
  if (yearsEl) yearsEl.value = tpl.years;
  if (budgetEl) budgetEl.value = formattedBudget;
  if (stripBudgetEl) stripBudgetEl.value = formattedBudget;

  // Highlight active template card
  ['retirement', 'dividend', 'growth', 'preservation'].forEach(k => {
    const card = document.getElementById(`goal-preset-card-${k}`);
    if (card) {
      card.className = k === templateKey
        ? 'goal-preset-card active text-left p-4 space-y-1.5'
        : 'goal-preset-card text-left p-4 space-y-1.5';
    }
  });

  state.activeGoal = tpl.strategy;
  const applyTickersToggle = document.getElementById('goal-template-apply-tickers');
  const shouldApplyTickers = applyTickersToggle ? applyTickersToggle.checked : true;

  if (shouldApplyTickers && Array.isArray(tpl.tickers) && tpl.tickers.length >= 2) {
    state.tickers = [...tpl.tickers];
    renderTickersList();
    updateMaxWeightLabel(document.getElementById('max-weight-slider')?.value || 100);
    fetchLiveQuotesForTickers();
    selectGoal(tpl.strategy);
    runOptimization(false);
  } else {
    selectGoal(tpl.strategy);
    handleBudgetQuickUpdate();
    recalculateGoalProjection();
  }

  if (shouldScroll) {
    switchAppTab('goals');
  }
}

function computeGoalProjectionMetrics() {
  const initialBudget = parseNumericInput(document.getElementById('budget-input')?.value) || 100000;
  const targetAmount = parseNumericInput(document.getElementById('save-target-amount')?.value) || 1000000;
  const monthlyDca = parseNumericInput(document.getElementById('save-monthly-dca')?.value) || 0;
  const years = Math.max(1, Math.min(50, parseInt(document.getElementById('save-period-years')?.value, 10) || 5));
  const goalCategory = document.getElementById('save-goal-category')?.value || 'retirement';
  const goalCategoryLabels = {
    retirement: 'พอร์ตเกษียณมั่นคง',
    dividend: 'พอร์ตสร้างเงินปันผล',
    growth: 'พอร์ตเติบโตสูง',
    preservation: 'พอร์ตพักเงินปลอดภัย',
    custom: 'กำหนดเป้าหมายเอง'
  };

  let rawExpectedReturn = 0.12;
  let annualVol = 0.16;
  let divYield = 0.02;
  let strategyName = 'Max Sharpe Ratio';

  if (state.optData && state.optData.strategies && state.optData.strategies[state.activeGoal]) {
    const strat = state.optData.strategies[state.activeGoal];
    rawExpectedReturn = Number(strat.expected_return || 0.12);
    annualVol = Number(strat.volatility || 0.16);
    divYield = Number(strat.dividend_yield !== undefined ? strat.dividend_yield : 0.018);
    strategyName = strat.short_name || strat.name || state.activeGoal;
  }

  // Prudent long-term compounding cap (prevent extreme multi-year distortion while preserving strategy differences)
  const effectiveAnnualReturn = Math.max(0.02, Math.min(0.28, rawExpectedReturn));
  const bullAnnualReturn = Math.min(0.36, effectiveAnnualReturn + 0.25 * annualVol);
  const conservativeAnnualReturn = Math.max(0.015, effectiveAnnualReturn - 0.30 * annualVol);

  const yearsAxis = [];
  const principalSeries = [];
  const baseWealthSeries = [];
  const bullWealthSeries = [];
  const consWealthSeries = [];

  let curPrincipal = initialBudget;
  let curBase = initialBudget;
  let curBull = initialBudget;
  let curCons = initialBudget;

  const rBaseMonth = Math.pow(1 + effectiveAnnualReturn, 1 / 12) - 1;
  const rBullMonth = Math.pow(1 + bullAnnualReturn, 1 / 12) - 1;
  const rConsMonth = Math.pow(1 + conservativeAnnualReturn, 1 / 12) - 1;

  for (let y = 0; y <= years; y++) {
    yearsAxis.push(`ปีที่ ${y}`);
    principalSeries.push(Math.round(curPrincipal));
    baseWealthSeries.push(Math.round(curBase));
    bullWealthSeries.push(Math.round(curBull));
    consWealthSeries.push(Math.round(curCons));

    if (y < years) {
      for (let m = 0; m < 12; m++) {
        curPrincipal += monthlyDca;
        curBase = curBase * (1 + rBaseMonth) + monthlyDca;
        curBull = curBull * (1 + rBullMonth) + monthlyDca;
        curCons = curCons * (1 + rConsMonth) + monthlyDca;
      }
    }
  }

  const totalPrincipal = principalSeries[principalSeries.length - 1];
  const projectedFinalWealth = baseWealthSeries[baseWealthSeries.length - 1];
  const netProfit = Math.max(0, projectedFinalWealth - totalPrincipal);
  const achievementPct = targetAmount > 0 ? Number(((projectedFinalWealth / targetAmount) * 100).toFixed(1)) : 100;
  const gapAmount = projectedFinalWealth - targetAmount;
  const estAnnualDividendAtEnd = Math.round(projectedFinalWealth * divYield);
  const estMonthlyDividendAtEnd = Math.round(estAnnualDividendAtEnd / 12);

  // Calculate required monthly DCA to reach targetAmount if currently below target
  const totalMonths = years * 12;
  const fvInitial = initialBudget * Math.pow(1 + rBaseMonth, totalMonths);
  const annuityFactor = rBaseMonth > 0 ? ((Math.pow(1 + rBaseMonth, totalMonths) - 1) / rBaseMonth) : totalMonths;
  const requiredMonthlyDca = Math.max(0, Math.ceil((targetAmount - fvInitial) / Math.max(1, annuityFactor)));

  return {
    initialBudget,
    targetAmount,
    monthlyDca,
    years,
    goalCategory,
    goalLabel: goalCategoryLabels[goalCategory] || 'พอร์ตตามเป้าหมาย',
    strategyName,
    rawExpectedReturn,
    effectiveAnnualReturn,
    annualVol,
    divYield,
    totalPrincipal,
    projectedFinalWealth,
    netProfit,
    achievementPct,
    gapAmount,
    estAnnualDividendAtEnd,
    estMonthlyDividendAtEnd,
    requiredMonthlyDca,
    yearsAxis,
    principalSeries,
    baseWealthSeries,
    bullWealthSeries,
    consWealthSeries
  };
}

function recalculateGoalProjection() {
  const m = computeGoalProjectionMetrics();
  window.lastGoalProjection = m;

  const subEl = document.getElementById('goal-projection-subtitle');
  if (subEl) {
    const wasCapped = m.rawExpectedReturn > 0.28 || m.rawExpectedReturn < 0.02;
    const capNote = wasCapped ? ' (คุมเพดานทบต้นอย่างรอบคอบ 2%-28%/ปี)' : '';
    subEl.innerText = `กลยุทธ์ที่เลือก: ${m.strategyName} | อัตราผลตอบแทนทบต้นที่ใช้จำลอง ${(m.effectiveAnnualReturn * 100).toFixed(2)}%/ปี${capNote} | อัตราเงินปันผลเฉลี่ย ${(m.divYield * 100).toFixed(2)}%/ปี`;
  }

  const totalPrinEl = document.getElementById('goal-proj-total-principal');
  const prinBreakEl = document.getElementById('goal-proj-principal-breakdown');
  if (totalPrinEl) totalPrinEl.innerText = formatMoney(m.totalPrincipal, 0, true);
  if (prinBreakEl) {
    const dcaTotal = m.monthlyDca * 12 * m.years;
    prinBreakEl.innerText = `ก้อนแรก ${formatMoney(m.initialBudget, 0, false)} + ออมสะสม ${formatMoney(dcaTotal, 0, false)}`;
  }

  const finalWealthEl = document.getElementById('goal-proj-final-wealth');
  const netProfitEl = document.getElementById('goal-proj-net-profit');
  if (finalWealthEl) finalWealthEl.innerText = formatMoney(m.projectedFinalWealth, 0, true);
  if (netProfitEl) netProfitEl.innerText = `กำไรทบต้นสุทธิ +${formatMoney(m.netProfit, 0, true)}`;

  const annDivEl = document.getElementById('goal-proj-annual-dividend');
  const monDivEl = document.getElementById('goal-proj-monthly-dividend');
  if (annDivEl) annDivEl.innerText = `${formatMoney(m.estAnnualDividendAtEnd, 0, true)} / ปี`;
  if (monDivEl) {
    monDivEl.innerText = `เฉลี่ยเดือนละ ${formatMoney(m.estMonthlyDividendAtEnd, 0, true)} (Yield ${(m.divYield * 100).toFixed(2)}%)`;
  }

  const pctEl = document.getElementById('goal-proj-achievement-pct');
  const gapEl = document.getElementById('goal-proj-gap-text');
  const barEl = document.getElementById('goal-proj-progress-bar');
  const statusBadge = document.getElementById('goal-feasibility-status-badge');
  const adviceBox = document.getElementById('goal-smart-advice-box');

  if (pctEl) pctEl.innerText = `${m.achievementPct}%`;
  if (barEl) {
    const barW = Math.max(4, Math.min(100, m.achievementPct));
    barEl.style.width = `${barW}%`;
    barEl.className = m.achievementPct >= 100
      ? 'h-full bg-emerald-600 rounded-full transition-all duration-300'
      : 'h-full bg-amber-500 rounded-full transition-all duration-300';
  }

  if (m.achievementPct >= 100) {
    if (gapEl) {
      gapEl.innerText = `เกินเป้า +${formatMoney(Math.abs(m.gapAmount), 0, false)}`;
      gapEl.className = 'text-[10px] font-bold text-emerald-700';
    }
    if (statusBadge) {
      statusBadge.innerText = `บรรลุเป้าหมาย (${m.achievementPct}%)`;
      statusBadge.className = 'px-2.5 py-1 rounded-md text-xs font-bold bg-emerald-100 text-emerald-800 border border-emerald-300 self-start sm:self-center';
    }
    if (adviceBox) {
      adviceBox.innerHTML = `
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <b class="text-emerald-900">สรุปแผนพิชิตเป้าหมาย: มีความเป็นไปได้สูงที่จะบรรลุเป้าหมาย ${formatMoney(m.targetAmount, 0, true)} ภายใน ${m.years} ปี</b>
            <div class="text-[11px] text-slate-600 mt-0.5">
              จากการเริ่มต้นด้วยเงินก้อนแรก <b>${formatMoney(m.initialBudget, 0, true)}</b> และออมเพิ่มเดือนละ <b>${formatMoney(m.monthlyDca, 0, true)}</b> ในกลยุทธ์ <b>${m.strategyName}</b> คาดว่าพอร์ตจะเติบโตเป็น <b>${formatMoney(m.projectedFinalWealth, 0, true)}</b> (สร้างกระแสเงินปันผลราว <b>${formatMoney(m.estMonthlyDividendAtEnd, 0, true)}/เดือน</b>)
            </div>
          </div>
        </div>
      `;
    }
  } else {
    const extraDcaNeeded = Math.max(0, m.requiredMonthlyDca - m.monthlyDca);
    if (gapEl) {
      gapEl.innerText = `ขาดอีก ${formatMoney(Math.abs(m.gapAmount), 0, false)}`;
      gapEl.className = 'text-[10px] font-bold text-amber-700';
    }
    if (statusBadge) {
      statusBadge.innerText = `คาดว่าจะได้ ${m.achievementPct}% ของเป้าหมาย`;
      statusBadge.className = 'px-2.5 py-1 rounded-md text-xs font-bold bg-amber-100 text-amber-900 border border-amber-300 self-start sm:self-center';
    }
    if (adviceBox) {
      adviceBox.innerHTML = `
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <b class="text-amber-900">คำแนะนำเพื่อพิชิตเป้าหมาย ${formatMoney(m.targetAmount, 0, true)} ให้สำเร็จ 100% ภายใน ${m.years} ปี:</b>
            <div class="text-[11px] text-slate-700 mt-0.5">
              ปัจจุบันพอร์ตคาดว่าจะโตไปที่ <b>${formatMoney(m.projectedFinalWealth, 0, true)}</b> (ยังขาดอีก <b>${formatMoney(Math.abs(m.gapAmount), 0, true)}</b>) แนะนำให้ปรับเพิ่มเงินออมรายเดือน (DCA) อีก <b>+${formatMoney(extraDcaNeeded, 0, true)}/เดือน</b> (รวมออมเดือนละ <b>${formatMoney(m.requiredMonthlyDca, 0, true)}</b>)
            </div>
          </div>
          <button
            type="button"
            onclick="document.getElementById('save-monthly-dca').value='${formatNumberWithCommas(m.requiredMonthlyDca, 0)}'; recalculateGoalProjection();"
            class="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-bold shrink-0 transition"
          >
            ปรับค่า DCA เป็น ${formatMoney(m.requiredMonthlyDca, 0, false)}/เดือน ทันที
          </button>
        </div>
      `;
    }
  }

  renderGoalProjectionChart(m);
}

function renderGoalProjectionChart(m) {
  const chartEl = document.getElementById('goal-projection-chart');
  if (!chartEl || typeof Plotly === 'undefined') return;

  const sym = state.currencySymbol;
  const traceBull = {
    x: m.yearsAxis,
    y: m.bullWealthSeries,
    name: 'กรณีตลาดดี (Bull Case)',
    type: 'scatter',
    mode: 'lines',
    line: { color: '#10b981', width: 1.5, dash: 'dot' },
    hovertemplate: `%{x}: ${sym}%{y:,.0f}<extra>กรณีตลาดดี</extra>`
  };

  const traceBase = {
    x: m.yearsAxis,
    y: m.baseWealthSeries,
    name: 'มูลค่าพอร์ตคาดการณ์ (Base Case)',
    type: 'scatter',
    mode: 'lines+markers',
    marker: { size: 6, color: '#00D084' },
    line: { color: '#00D084', width: 3 },
    fill: 'tonexty',
    fillcolor: 'rgba(0, 208, 132, 0.12)',
    hovertemplate: `%{x}: ${sym}%{y:,.0f}<extra>พอร์ตคาดการณ์</extra>`
  };

  const traceConservative = {
    x: m.yearsAxis,
    y: m.consWealthSeries,
    name: 'กรณีตลาดซบเซา (Conservative)',
    type: 'scatter',
    mode: 'lines',
    line: { color: '#FF5A5F', width: 1.8, dash: 'dot' },
    hovertemplate: `%{x}: ${sym}%{y:,.0f}<extra>กรณีตลาดซบเซา</extra>`
  };

  const tracePrincipal = {
    x: m.yearsAxis,
    y: m.principalSeries,
    name: 'เงินต้นสะสมที่ใส่จริง (ก้อนแรก + DCA)',
    type: 'scatter',
    mode: 'lines+markers',
    marker: { size: 4, color: '#94A3B8' },
    line: { color: '#94A3B8', width: 2, dash: 'dash' },
    hovertemplate: `%{x}: ${sym}%{y:,.0f}<extra>เงินต้นสะสม</extra>`
  };

  const traceTarget = {
    x: m.yearsAxis,
    y: m.yearsAxis.map(() => m.targetAmount),
    name: `เป้าหมาย (${formatMoney(m.targetAmount, 0, false)})`,
    type: 'scatter',
    mode: 'lines',
    line: { color: '#FBBF24', width: 2, dash: 'dashdot' },
    hovertemplate: `เป้าหมาย: ${sym}%{y:,.0f}<extra></extra>`
  };

  const ct = getChartThemeTokens();
  const layout = {
    margin: { t: 15, r: 20, b: 35, l: 65 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: ct.plotBg,
    font: { family: 'Plus Jakarta Sans, Anuphan, sans-serif', size: 11, color: ct.axisText },
    xaxis: { gridcolor: ct.grid, linecolor: ct.line, color: ct.axisText },
    yaxis: { gridcolor: ct.grid, linecolor: ct.line, color: ct.axisText, tickprefix: sym, separatethousands: true },
    legend: { orientation: 'h', y: 1.18, x: 0, font: { size: 10, color: ct.legendText } },
    hovermode: 'x unified'
  };

  Plotly.react(chartEl, [tracePrincipal, traceConservative, traceBase, traceBull, traceTarget], layout, {
    responsive: true,
    displayModeBar: false
  });
}

function openPrintableGoalReport() {
  const m = computeGoalProjectionMetrics();
  const rawPortfolioName = (document.getElementById('save-portfolio-name')?.value || 'แผนพอร์ตการลงทุนตามเป้าหมาย').trim();
  const portfolioName = escapeHtmlText(rawPortfolioName);
  const strat = (state.optData && state.optData.strategies && state.optData.strategies[state.activeGoal]) || null;
  const weights = strat ? strat.weights : {};

  const weightRowsHtml = Object.entries(weights)
    .filter(([, w]) => w > 0.0005)
    .sort((a, b) => b[1] - a[1])
    .map(([ticker, w]) => {
      const pct = (w * 100).toFixed(2);
      const amt = formatMoney(m.initialBudget * w, 2, true);
      return `<tr>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-weight:700;">${escapeHtmlText(ticker)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:right;">${pct}%</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:600;">${amt}</td>
      </tr>`;
    }).join('');

  const win = window.open('', '_blank', 'width=900,height=780');
  if (!win) {
    alert('กรุณาอนุญาตให้เปิดหน้าต่าง Pop-up เพื่อพิมพ์ใบสรุปแผนการลงทุน');
    return;
  }

  const todayStr = new Date().toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' });
  win.document.write(`
    <!DOCTYPE html>
    <html lang="th">
    <head>
      <meta charset="UTF-8">
      <title>ใบสรุปแผนการลงทุน - ${portfolioName}</title>
      <style>
        body { font-family: 'Segoe UI', Tahoma, sans-serif; color: #0f172a; margin: 28px; line-height: 1.5; }
        .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #1e293b; padding-bottom: 14px; margin-bottom: 18px; }
        .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 18px; }
        .card { border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px; background: #f8fafc; }
        .label { font-size: 11px; color: #475569; font-weight: 600; }
        .val { font-size: 16px; font-weight: 800; color: #0f172a; margin-top: 4px; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
        th { background: #f1f5f9; text-align: left; padding: 8px 10px; border-bottom: 2px solid #cbd5e1; }
        @media print { .no-print { display: none; } body { margin: 12px; } }
      </style>
    </head>
    <body>
      <div class="no-print" style="margin-bottom:16px;text-align:right;">
        <button onclick="window.print()" style="padding:8px 16px;background:#4f46e5;color:#fff;border:none;border-radius:6px;font-weight:700;cursor:pointer;">สั่งพิมพ์ / บันทึกเป็น PDF</button>
      </div>
      <div class="header">
        <div>
          <div style="font-size:12px;font-weight:700;color:#4f46e5;text-transform:uppercase;">QuantFolio Wealth Analytics — Executive Investment Plan</div>
          <h1 style="margin:4px 0 2px;font-size:22px;">${portfolioName} (${m.goalLabel})</h1>
          <div style="font-size:12px;color:#64748b;">กลยุทธ์: ${m.strategyName} | วันที่ออกรายงาน: ${todayStr}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:12px;color:#475569;">เป้าหมายการเงิน (${m.years} ปี)</div>
          <div style="font-size:20px;font-weight:800;color:#4f46e5;">${formatMoney(m.targetAmount, 0, true)}</div>
        </div>
      </div>

      <div class="grid">
        <div class="card">
          <div class="label">1. เงินลงทุนก้อนแรก + DCA/เดือน</div>
          <div class="val">${formatMoney(m.initialBudget, 0, false)}</div>
          <div style="font-size:11px;color:#475569;">ออมเพิ่ม ${formatMoney(m.monthlyDca, 0, false)}/เดือน (รวมต้น ${formatMoney(m.totalPrincipal, 0, false)})</div>
        </div>
        <div class="card">
          <div class="label">2. มูลค่าพอร์ตคาดการณ์ (${m.years} ปี)</div>
          <div class="val" style="color:#4f46e5;">${formatMoney(m.projectedFinalWealth, 0, false)}</div>
          <div style="font-size:11px;color:#059669;font-weight:700;">กำไรทบต้น +${formatMoney(m.netProfit, 0, false)} (${m.achievementPct}% ของเป้า)</div>
        </div>
        <div class="card">
          <div class="label">3. ผลตอบแทนคาดหวัง / ปันผล</div>
          <div class="val" style="color:#059669;">${(m.effectiveAnnualReturn * 100).toFixed(2)}% / ปี</div>
          <div style="font-size:11px;color:#475569;">ปันผลเมื่อครบกำหนด ~${formatMoney(m.estMonthlyDividendAtEnd, 0, false)}/เดือน</div>
        </div>
        <div class="card">
          <div class="label">4. ความผันผวน / Max Drawdown</div>
          <div class="val" style="color:#dc2626;">${strat ? (strat.max_drawdown * 100).toFixed(2) + '%' : '--'}</div>
          <div style="font-size:11px;color:#475569;">ความผันผวน ${(m.annualVol * 100).toFixed(2)}%/ปี</div>
        </div>
      </div>

      <h3 style="font-size:15px;margin:18px 0 6px;">สัดส่วนการกระจายการลงทุนตามกลยุทธ์ (${m.strategyName})</h3>
      <table>
        <thead>
          <tr>
            <th>สินทรัพย์ (Ticker)</th>
            <th style="text-align:right;">สัดส่วนเป้าหมาย (%)</th>
            <th style="text-align:right;">เม็ดเงินจัดสรรก้อนแรก</th>
          </tr>
        </thead>
        <tbody>
          ${weightRowsHtml}
        </tbody>
      </table>

      <div style="margin-top:22px;padding:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;font-size:11px;color:#64748b;">
        หมายเหตุ: รายงานนี้คำนวณด้วยโมเดลคณิตศาสตร์การเงิน (Markowitz Mean-Variance & Hierarchical Risk Parity) จากข้อมูลสถิติจริงบน Yahoo Finance เพื่อใช้ประกอบการวางแผนการลงทุนอย่างเป็นระบบ
      </div>
    </body>
    </html>
  `);
  win.document.close();
}

function showPortfolioToastApp(message) {
  const toastEl = document.getElementById('portfolio-toast');
  if (!toastEl) return;
  const msgEl = document.getElementById('portfolio-toast-text');
  if (msgEl) {
    msgEl.innerText = message;
  } else {
    toastEl.innerHTML = `<div class="flex items-center gap-2"><div class="w-2 h-2 rounded-full bg-emerald-400"></div><span id="portfolio-toast-text">${escapeHtmlText(message)}</span></div>`;
  }
  toastEl.classList.remove('hidden');
  clearTimeout(window.__portfolioToastTimeout);
  window.__portfolioToastTimeout = setTimeout(() => {
    toastEl.classList.add('hidden');
  }, 3500);
}
window.__appShowPortfolioToast = showPortfolioToastApp;

if (typeof window !== 'undefined') {
  window.QuantFolioCalc = {
    getAssetPriceInCurrentCurrency,
    computeRebalancePlan,
    computeGoalProjectionMetrics,
    escapeHtmlText,
    sanitizeExternalUrl
  };
}
