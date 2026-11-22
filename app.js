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
  resultStatus: 'idle', // 'idle' | 'loading' | 'ready' | 'stale' | 'error'
  staleReason: '',
  lastErrorMessage: '',
  growthLogScale: true,
  backtestChartMode: 'wealth', // 'wealth' | 'drawdown'
  goalInflationRate: 0,        // 0 | 2.5 | 3.0 (% per year for real purchasing-power comparison)
  pendingPdfPortfolioId: null, // optional saved portfolio id when opening PDF modal from vault card
  pdfCustomLogoDataUrl: '',    // optional white-label logo data URL for licensed IC/IP/IFA PDF exports
  currency: 'THB',
  currencySymbol: '฿',
  currencyUnitText: 'บาท',
  budget: 100000,
  fxRate: 34.50,
  fxIsManual: false,
  ratesMeta: null,
  isFallbackFx: false,
  isFallbackRf: false,
  primaryMode: 'new_capital',    // 'new_capital' | 'existing_portfolio' | 'goal_based'
  rebalanceMode: 'cash',         // 'cash' | 'equal_weight' | 'custom'
  holdingsInputUnit: 'money',    // 'money' | 'shares'
  executionUnitMode: 'fractional', // 'fractional' | 'whole'
  commissionPct: 0.15,
  customHoldings: {},            // { ticker: netCurrentValueInCurrency }
  customCost: {},                // { ticker: originalCostBasisInCurrency }
  customPnl: {},                 // { ticker: signedUnrealizedPnlInCurrency (+/-) }
  customShares: {},              // { ticker: shareCount }
  customCashInjection: 0,
  executedOrders: {},
  useNewsAdjustment: false,
  blConfidence: 0.50,
  blViews: null,
  blDebounceTimer: null,
  lastRebalancePlan: null,
  searchDebounceTimer: null,
  budgetDebounceTimer: null,
  goalChartDebounceTimer: null,
  customInputDebounceTimer: null,
  loadingStepTimers: [],
  loadingElapsedTimer: null,
  loadingStartTime: 0,
  quotesLoading: false,
  quotesError: false,
  searchRequestId: 0,
  activeTab: 'setup',
  appView: 'landing', // 'landing' | 'workspace'
  landingPreviewTab: 'allocation',
  landingSelectedPreset: 'colab_original',
  viewDepth: 'simple',
  theme: 'light',
  tradePlanViewMode: 'cards',
  insightsNewsExpanded: false,
  balancePrivacyHidden: false,
  strategyCompareMetric: 'return', // 'return' | 'volatility' | 'sharpe'
  fxRoundTripAnchor: null,
  stripMobileExpandedTabs: {},
  holdingsListExpanded: false,
  optRequestId: 0
};
window.state = state;

function maskIfPrivate(formattedText, withUnit = false) {
  if (!state.balancePrivacyHidden) return formattedText;
  return withUnit ? `•••••• ${state.currencyUnitText}` : `${state.currencySymbol} ••••••`;
}

function getActiveUserTierInfo() {
  if (typeof window !== 'undefined' && typeof window.getUserTierInfo === 'function') {
    return window.getUserTierInfo();
  }
  return {
    planTier: 'guest',
    isAdmin: false,
    labelTh: 'โหมดทดลองใช้ (Guest)',
    badgeText: 'GUEST',
    maxAssets: 5,
    maxSavedPortfolios: 1,
    canViewNews: false,
    canDownloadSimPdf: false,
    canCustomizeBlViews: false,
    canWhitelabelAdvisorPdf: false,
    safeBlConfidenceCap: 0.35
  };
}

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
  us_gold_mix: {
    label: 'พอร์ตผสมสหรัฐฯ+ทองคำ',
    tickers: ['SPY', 'QQQ', 'MSFT', 'GLD', 'TLT'],
    get start() { return getDefaultDateRange(3).start; },
    get end() { return getDefaultDateRange(3).end; },
    currency: 'THB',
    budget: 100000
  },
  thai_dividend: {
    label: 'พอร์ตหุ้นไทยปันผล',
    tickers: ['PTT.BK', 'ADVANC.BK', 'BDMS.BK', 'SCB.BK', 'CPALL.BK'],
    get start() { return getDefaultDateRange(3).start; },
    get end() { return getDefaultDateRange(3).end; },
    currency: 'THB',
    budget: 100000
  },
  colab_original: {
    label: 'US Tech + BTC',
    tickers: ['NVDA', 'TSLA', 'AMZN', 'BTC-USD', 'AAPL'],
    get start() { return getDefaultDateRange(3).start; },
    get end() { return getDefaultDateRange(3).end; },
    currency: 'THB',
    budget: 100000
  },
  tech_titans: {
    label: 'Top 7 หุ้นสหรัฐฯ',
    tickers: ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA'],
    get start() { return getDefaultDateRange(3).start; },
    get end() { return getDefaultDateRange(3).end; },
    currency: 'THB',
    budget: 100000
  },
  all_weather: {
    label: 'All-Weather',
    tickers: ['SPY', 'QQQ', 'GLD', 'TLT', 'DBC'],
    get start() { return getDefaultDateRange(3).start; },
    get end() { return getDefaultDateRange(3).end; },
    currency: 'THB',
    budget: 100000
  },
  thai_set50: {
    label: 'หุ้นไทย SET50',
    tickers: ['DELTA.BK', 'PTT.BK', 'ADVANC.BK', 'GULF.BK', 'AOT.BK'],
    get start() { return getDefaultDateRange(3).start; },
    get end() { return getDefaultDateRange(3).end; },
    currency: 'THB',
    budget: 100000
  }
};

// Institutional Wealth Asset Color Palette (25 composed tones — first 4 match Landing Page MSFT/NVDA/GLD/TLT, zero neon/hot-pink)
const ASSET_COLORS = [
  '#059669', '#2563EB', '#D97706', '#64748B', '#4F46E5',
  '#0D9488', '#BE123C', '#0284C7', '#7C3AED', '#CA8A04',
  '#0891B2', '#475569', '#15803D', '#1D4ED8', '#B45309',
  '#4338CA', '#0F766E', '#9F1239', '#0369A1', '#6D28D9',
  '#A16207', '#0E7490', '#334155', '#166534', '#1E40AF'
];

const STRATEGY_COLORS = {
  max_sharpe: '#059669',
  min_volatility: '#2563EB',
  hrp: '#6366F1',
  equal_weight: '#64748B'
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

// Instant Vector SVG Data-URIs for Gold, Bonds, Index ETFs, and Major Crypto (Zero network latency, crisp in Dark & Light modes)
const CUSTOM_ASSET_SVG_MAP = {
  'BTC-USD': `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#F7931A"/><text x="32" y="43" text-anchor="middle" fill="#FFFFFF" font-family="Plus Jakarta Sans,sans-serif" font-weight="800" font-size="34">₿</text></svg>')}`,
  'ETH-USD': `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#627EEA"/><polygon points="32,12 19,33 32,40 45,33" fill="#FFFFFF" opacity="0.95"/><polygon points="32,43 19,36 32,53 45,36" fill="#FFFFFF" opacity="0.8"/></svg>')}`,
  'SOL-USD': `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#14F195"/><rect x="16" y="19" width="32" height="6" rx="3" fill="#0A0D12"/><rect x="16" y="29" width="32" height="6" rx="3" fill="#0A0D12"/><rect x="16" y="39" width="32" height="6" rx="3" fill="#0A0D12"/></svg>')}`,
  'GLD': `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#F59E0B"/><polygon points="20,42 26,24 38,24 44,42" fill="#FEF3C7"/><text x="32" y="38" text-anchor="middle" fill="#92400E" font-family="Plus Jakarta Sans,sans-serif" font-weight="800" font-size="11">GOLD</text></svg>')}`,
  'IAU': `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#D97706"/><text x="32" y="37" text-anchor="middle" fill="#FFFFFF" font-family="Plus Jakarta Sans,sans-serif" font-weight="800" font-size="15">GOLD</text></svg>')}`,
  'TLT': `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#0284C7"/><text x="32" y="30" text-anchor="middle" fill="#E0F2FE" font-family="Plus Jakarta Sans,sans-serif" font-weight="700" font-size="11">US 20Y</text><text x="32" y="44" text-anchor="middle" fill="#FFFFFF" font-family="Plus Jakarta Sans,sans-serif" font-weight="800" font-size="14">BOND</text></svg>')}`,
  'SPY': `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#00A86B"/><text x="32" y="30" text-anchor="middle" fill="#D1FAE5" font-family="Plus Jakarta Sans,sans-serif" font-weight="700" font-size="11">S&amp;P</text><text x="32" y="45" text-anchor="middle" fill="#FFFFFF" font-family="Plus Jakarta Sans,sans-serif" font-weight="800" font-size="16">500</text></svg>')}`,
  'VOO': `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#991B1B"/><text x="32" y="30" text-anchor="middle" fill="#FEE2E2" font-family="Plus Jakarta Sans,sans-serif" font-weight="700" font-size="11">S&amp;P</text><text x="32" y="45" text-anchor="middle" fill="#FFFFFF" font-family="Plus Jakarta Sans,sans-serif" font-weight="800" font-size="15">VOO</text></svg>')}`,
  'QQQ': `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#1D4ED8"/><text x="32" y="30" text-anchor="middle" fill="#DBEAFE" font-family="Plus Jakarta Sans,sans-serif" font-weight="700" font-size="10">NASDAQ</text><text x="32" y="45" text-anchor="middle" fill="#FFFFFF" font-family="Plus Jakarta Sans,sans-serif" font-weight="800" font-size="15">100</text></svg>')}`
};

function getAssetLogoUrls(ticker) {
  const sym = String(ticker || '').trim().toUpperCase();
  if (CUSTOM_ASSET_SVG_MAP[sym]) {
    return { primary: CUSTOM_ASSET_SVG_MAP[sym], secondary: '', isCustomSvg: true };
  }

  const domain = STOCK_DOMAIN_MAP[sym];
  const domainFavicon = domain ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128` : '';

  if (sym.endsWith('.BK')) {
    const fmpBk = `https://financialmodelingprep.com/image-stock/${encodeURIComponent(sym)}.png`;
    return {
      primary: domainFavicon || fmpBk,
      secondary: domainFavicon ? fmpBk : '',
      isCustomSvg: false
    };
  }

  if (sym.endsWith('-USD')) {
    const baseCoin = sym.replace('-USD', '');
    const fmpCrypto = `https://financialmodelingprep.com/image-stock/${encodeURIComponent(baseCoin + 'USD')}.png`;
    return {
      primary: fmpCrypto,
      secondary: domainFavicon || `https://assets.parqet.com/logos/symbol/${encodeURIComponent(baseCoin)}?format=png`,
      isCustomSvg: false
    };
  }

  const fmpStock = `https://financialmodelingprep.com/image-stock/${encodeURIComponent(sym)}.png`;
  return {
    primary: fmpStock,
    secondary: domainFavicon || `https://assets.parqet.com/logos/symbol/${encodeURIComponent(sym)}?format=png`,
    isCustomSvg: false
  };
}

function handleStockLogoLoad(imgEl) {
  if (!imgEl) return;
  const isCustom = imgEl.getAttribute('data-custom-svg') === '1';
  if (!isCustom && imgEl.naturalWidth > 0 && imgEl.naturalWidth <= 16) {
    // Reject generic 16x16 globe fallback icon and try secondary or monogram badge
    handleStockLogoError(imgEl);
    return;
  }
  imgEl.style.opacity = '1';
  if (imgEl.parentElement) {
    imgEl.parentElement.classList.add('has-loaded-logo');
  }
}

function handleStockLogoError(imgEl) {
  if (!imgEl) return;
  const fallback = imgEl.getAttribute('data-fallback');
  if (fallback && imgEl.src !== fallback) {
    imgEl.removeAttribute('data-fallback');
    imgEl.src = fallback;
  } else {
    imgEl.style.opacity = '0';
    imgEl.style.display = 'none';
  }
}

function renderStockLogoBadge(ticker, fallbackColor = '#334155', sizePx = 36) {
  const clean = String(ticker || '').trim().toUpperCase();
  const safeTicker = escapeHtmlText(clean);
  const shortCode = escapeHtmlText(clean.replace('.BK', '').replace('-USD', '').slice(0, 4));
  const { primary, secondary, isCustomSvg } = getAssetLogoUrls(clean);
  const fontSize = sizePx <= 30 ? '9.5px' : '10.5px';
  const imgPadClass = isCustomSvg ? 'p-0' : 'p-1.5';

  return `
    <div class="qf-stock-logo-wrap relative rounded-full overflow-hidden flex items-center justify-center shrink-0 bg-slate-100 border border-slate-200/90 text-slate-700" style="width:${sizePx}px;height:${sizePx}px;">
      <span class="qf-stock-logo-monogram font-mono font-bold select-none tracking-tight" style="font-size:${fontSize};">${shortCode}</span>
      <img
        src="${primary}"
        data-fallback="${secondary}"
        data-custom-svg="${isCustomSvg ? '1' : '0'}"
        alt="${safeTicker}"
        loading="lazy"
        onload="handleStockLogoLoad(this)"
        onerror="handleStockLogoError(this)"
        style="opacity:${isCustomSvg ? '1' : '0'};transition:opacity 0.18s ease;"
        class="qf-stock-logo-img absolute inset-0 w-full h-full object-contain ${imgPadClass} rounded-full"
      />
    </div>
  `;
}

function convertNativePrice(nativePrice, nativeCurrency, targetCurrency = state.currency, fxRate = state.fxRate) {
  const p = Number(nativePrice);
  if (!Number.isFinite(p) || p <= 0) return 0;
  const fx = Number(fxRate) > 0 ? Number(fxRate) : 34.50;
  const nat = String(nativeCurrency || 'USD').trim().toUpperCase();
  const tgt = String(targetCurrency || 'THB').trim().toUpperCase();
  if (nat === tgt) return Number(p.toFixed(2));
  if (nat === 'USD' && tgt === 'THB') return Number((p * fx).toFixed(2));
  if (nat === 'THB' && tgt === 'USD') return Number((p / fx).toFixed(2));
  return Number(p.toFixed(2));
}

function getEffectiveAssetPrice(ticker, targetCurrency = state.currency, fxRate = state.fxRate) {
  const fx = Number(fxRate) > 0 ? Number(fxRate) : 34.50;
  const isThai = String(ticker || '').toUpperCase().endsWith('.BK');
  const nativeCurr = isThai ? 'THB' : 'USD';
  const stat = (state.optData?.asset_stats || []).find(a => a.ticker === ticker);
  if (stat && Number(stat.native_price) > 0) {
    return convertNativePrice(stat.native_price, stat.native_currency || nativeCurr, targetCurrency, fx);
  }
  const q = state.tickerQuotes[ticker];
  if (q && Number(q.price) > 0) {
    return convertNativePrice(q.price, q.currency || nativeCurr, targetCurrency, fx);
  }
  return 0;
}

function toggleHeaderUtilityMenu(forceOpen) {
  const menu = document.getElementById('header-utility-menu');
  const btn = document.getElementById('header-utility-menu-btn');
  if (!menu) return;
  const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !shouldOpen);
  if (btn) btn.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
}

document.addEventListener('click', (e) => {
  const menu = document.getElementById('header-utility-menu');
  const btn = document.getElementById('header-utility-menu-btn');
  if (menu && !menu.classList.contains('hidden') && !menu.contains(e.target) && (!btn || !btn.contains(e.target))) {
    toggleHeaderUtilityMenu(false);
  }
});

function updateMarketDataStatusPill() {
  const pill = document.getElementById('market-data-status-pill');
  const warnPill = document.getElementById('stale-market-warning');
  const data = state.optData;
  const meta = data?.metadata || {};

  // Gather equity closing dates vs BTC/FX fetch time
  const eqDates = [];
  let cryptoTimeIso = null;
  let anyQuoteStale = false;

  (data?.asset_stats || []).forEach(s => {
    const dt = s.latest_price_date || meta.data_as_of;
    if (s.market_type === 'crypto' || String(s.ticker).endsWith('-USD')) {
      cryptoTimeIso = meta.fetched_at || cryptoTimeIso;
    } else if (dt) {
      eqDates.push(dt);
    }
  });

  Object.values(state.tickerQuotes || {}).forEach(q => {
    if (!q || q.error) return;
    if (q.is_stale) anyQuoteStale = true;
    if (q.market_type === 'crypto') {
      cryptoTimeIso = q.fetched_at || cryptoTimeIso;
    } else if (q.as_of_date) {
      eqDates.push(q.as_of_date);
    }
  });

  const fxTimeIso = state.ratesMeta?.fx_updated_at || meta.fx_updated_at || cryptoTimeIso;
  const latestEqDate = eqDates.length > 0 ? [...eqDates].sort().slice(-1)[0] : (meta.data_as_of || null);
  let timeText = '';
  if (fxTimeIso) {
    try {
      const d = new Date(fxTimeIso);
      if (!isNaN(d.getTime())) {
        timeText = d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
      }
    } catch (_) {}
  }

  // Age checks (>3 business days ~ 5 cal days for equity; >2 hours for FX/BTC)
  let isDataOld = anyQuoteStale;
  const nowMs = Date.now();
  if (latestEqDate) {
    const eqMs = Date.parse(latestEqDate);
    if (!isNaN(eqMs) && (nowMs - eqMs) > 5 * 86400 * 1000) isDataOld = true;
  }
  if (fxTimeIso) {
    const fxMs = Date.parse(fxTimeIso);
    if (!isNaN(fxMs) && (nowMs - fxMs) > 2 * 3600 * 1000) isDataOld = true;
  }
  const hasFallback = Boolean(state.isFallbackFx || state.isFallbackRf || meta.is_fallback_fx || meta.is_fallback_rf || meta.fx_is_daily_history_fallback);

  if (pill) {
    if (state.resultStatus === 'stale') {
      pill.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0"></span><span>รอกดคำนวณใหม่</span>`;
      pill.title = `ผลล้าสมัย (${state.staleReason || 'แก้ไขพอร์ตแล้ว'}) • กดคำนวณเพื่ออัปเดตผลลัพธ์`;
      pill.className = 'hidden sm:inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 whitespace-nowrap tabular-nums';
    } else if (state.resultStatus === 'ready' && data) {
      const dateStr = latestEqDate || meta.end_date || '--';
      const livePart = timeText ? ` • อัปเดต ${timeText}` : '';
      pill.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-600 shrink-0"></span><span>ข้อมูล ณ ${escapeHtmlText(dateStr)}</span>`;
      pill.title = `ราคาปิด ณ ${dateStr}${livePart} • แหล่งข้อมูล Yahoo Finance`;
      pill.className = 'hidden sm:inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 whitespace-nowrap tabular-nums';
    } else if (state.resultStatus === 'loading') {
      pill.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-slate-500 animate-pulse shrink-0"></span><span>กำลังคำนวณ...</span>`;
      pill.title = 'กำลังดึงราคาตลาดและคำนวณพอร์ต...';
      pill.className = 'hidden sm:inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 whitespace-nowrap tabular-nums';
    } else {
      const datePart = latestEqDate ? `ข้อมูล ณ ${escapeHtmlText(latestEqDate)}` : 'พร้อมคำนวณ';
      pill.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-600 shrink-0"></span><span>${datePart}</span>`;
      pill.title = latestEqDate ? `ราคาปิดล่าสุด ${latestEqDate} • พร้อมคำนวณ` : 'พร้อมดึงราคาตลาด • กดคำนวณเพื่อดูผล';
      pill.className = 'hidden sm:inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 whitespace-nowrap tabular-nums';
    }
  }

  if (warnPill) {
    const showWarn = Boolean(isDataOld || hasFallback);
    warnPill.classList.toggle('hidden', !showWarn);
    warnPill.classList.toggle('inline-flex', showWarn);
    if (showWarn) {
      const reasons = [];
      if (state.isFallbackFx || meta.is_fallback_fx) reasons.push('FX ค่าสำรอง');
      if (state.isFallbackRf || meta.is_fallback_rf) reasons.push('Rf ค่าสำรอง');
      if (meta.fx_is_daily_history_fallback) reasons.push('FX ย้อนหลังใช้ค่าคงที่');
      if (isDataOld) reasons.push('ราคา/FX อาจเก่ากว่ากำหนด');
      warnPill.title = reasons.join(' • ');
      const spanTxt = warnPill.querySelector('span');
      if (spanTxt) spanTxt.innerText = hasFallback ? 'ใช้ค่าสำรอง' : 'ข้อมูลเก่า';
    }
  }
}

function showDroppedTickersBanner(droppedTickers = [], validCount = 0) {
  const banner = document.getElementById('dropped-tickers-banner');
  const txt = document.getElementById('dropped-tickers-banner-text');
  if (!banner || !txt) return;
  const list = Array.isArray(droppedTickers) ? droppedTickers.filter(Boolean) : [];
  if (list.length === 0) {
    banner.classList.add('hidden');
    return;
  }
  txt.innerHTML = `ไม่พบข้อมูลราคาตลาดสำหรับ <strong class="font-mono text-amber-950">${escapeHtmlText(list.join(', '))}</strong> ระบบจึงตัดออกและคำนวณจาก <strong>${validCount} สินทรัพย์</strong>ที่มีข้อมูลจริง (หากเป็นหุ้นไทยกรุณาเติม <code>.BK</code> เช่น <code>PTT.BK</code>)`;
  banner.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function dismissDroppedTickersBanner() {
  const banner = document.getElementById('dropped-tickers-banner');
  if (banner) banner.classList.add('hidden');
}

function syncGlobalResultStripMobileMode() {
  const stripEl = document.getElementById('global-result-strip');
  if (!stripEl) return;
  const tab = state.activeTab || 'setup';
  const compactDefaultTabs = ['insights', 'backtest', 'goals'];
  const shouldCollapse = compactDefaultTabs.includes(tab) && !state.stripMobileExpandedTabs?.[tab];
  stripEl.classList.toggle('qf-strip-mobile-collapsed', shouldCollapse);
}

function toggleGlobalResultStripMobile(expand) {
  const tab = state.activeTab || 'setup';
  state.stripMobileExpandedTabs = state.stripMobileExpandedTabs || {};
  state.stripMobileExpandedTabs[tab] = Boolean(expand);
  syncGlobalResultStripMobileMode();
}

function roundWeightsToOneDecimalSum100(items = []) {
  const map = new Map();
  const active = items.filter(it => Number(it.weight || 0) > 0.0005);
  if (active.length === 0) return map;
  const rawSum = active.reduce((acc, it) => acc + Number(it.weight || 0), 0);
  if (rawSum <= 0) return map;
  const scaled = active.map(it => {
    const exactTenths = (Number(it.weight || 0) / rawSum) * 1000;
    const floored = Math.floor(exactTenths);
    return { ticker: it.ticker, floored, rem: exactTenths - floored };
  });
  let remainder = 1000 - scaled.reduce((acc, s) => acc + s.floored, 0);
  const byRem = [...scaled].sort((a, b) => b.rem - a.rem);
  for (let i = 0; i < byRem.length && remainder > 0; i++, remainder--) {
    byRem[i].floored += 1;
  }
  scaled.forEach(s => map.set(s.ticker, (s.floored / 10).toFixed(1)));
  return map;
}

function renderTabStateBanners() {
  const status = state.resultStatus || 'idle';
  const navTradeBadge = document.getElementById('nav-trade-count-badge');
  const stripEl = document.getElementById('global-result-strip');

  if (status !== 'ready') {
    if (navTradeBadge) {
      navTradeBadge.innerText = '';
      navTradeBadge.classList.add('hidden');
    }
  }

  if (stripEl) {
    const showStrip = Boolean(state.optData && (status === 'ready' || status === 'stale' || status === 'loading') && state.activeTab !== 'setup');
    stripEl.classList.toggle('hidden', !showStrip);
    stripEl.classList.toggle('qf-stale-dimmed', status === 'stale');
    syncGlobalResultStripMobileMode();
  }

  const tabs = ['trade-plan', 'insights', 'backtest', 'goals'];
  tabs.forEach(tabKey => {
    const bannerEl = document.getElementById(`tab-state-banner-${tabKey}`);
    const bodyEl = document.getElementById(`tab-body-${tabKey}`);
    if (!bannerEl || !bodyEl) return;

    if (status === 'ready') {
      bannerEl.innerHTML = '';
      bannerEl.classList.add('hidden');
      bodyEl.classList.remove('hidden', 'qf-stale-dimmed');
      return;
    }

    if (status === 'loading' && state.optData) {
      bannerEl.classList.remove('hidden');
      bannerEl.innerHTML = `
        <div class="fin-card px-4 py-3 bg-emerald-50/80 border border-[#00D084]/45 flex items-center justify-between gap-3">
          <div class="flex items-center gap-2.5 min-w-0">
            <div class="w-4 h-4 rounded-full border-2 border-[#008A57]/30 border-t-[#008A57] animate-spin shrink-0"></div>
            <span class="text-xs sm:text-[13px] font-semibold text-emerald-950 truncate">กำลังอัปเดตสัดส่วนและตัวเลขพอร์ตตามเงื่อนไขล่าสุด...</span>
          </div>
          <span class="text-[11px] font-mono font-semibold text-emerald-700 shrink-0">อัปเดตแบบต่อเนื่อง</span>
        </div>
      `;
      bodyEl.classList.remove('hidden', 'qf-stale-dimmed');
      return;
    }

    if (status === 'stale' && state.optData) {
      bannerEl.classList.remove('hidden');
      bannerEl.innerHTML = `
        <div class="fin-card p-4 sm:p-5 bg-amber-50/95 border border-amber-300 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div class="flex items-start gap-3">
            <div class="w-9 h-9 rounded-xl bg-amber-100 text-amber-800 border border-amber-300 flex items-center justify-center shrink-0">
              <i data-lucide="alert-triangle" class="w-5 h-5"></i>
            </div>
            <div>
              <h3 class="text-sm sm:text-base font-semibold text-amber-950">ผลนี้ล้าสมัย (${escapeHtmlText(state.staleReason || 'แก้ไขข้อมูลพอร์ตแล้ว')}) — กดคำนวณใหม่</h3>
              <p class="text-[13px] text-amber-800 mt-0.5">ตัวเลขด้านล่างเป็นของรอบคำนวณก่อนหน้าและอาจไม่ตรงกับพอร์ตหรือสกุลเงินล่าสุด</p>
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <button type="button" onclick="runOptimization(false)" class="px-4 py-2 rounded-xl bg-[#00D084] hover:bg-[#00B874] text-[#0A0D12] text-[13px] font-semibold shadow-sm transition cursor-pointer">
              คำนวณใหม่ตอนนี้
            </button>
            <button type="button" onclick="switchAppTab('setup')" class="px-3 py-2 rounded-xl bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 text-[13px] font-medium transition cursor-pointer">
              ไปตั้งค่า
            </button>
          </div>
        </div>
      `;
      bodyEl.classList.remove('hidden');
      bodyEl.classList.add('qf-stale-dimmed');
      return;
    }

    // 'idle' | 'loading' | 'error' without valid ready data
    bannerEl.classList.remove('hidden');
    const isErr = status === 'error';
    const isLoading = status === 'loading';
    const headline = isLoading
      ? 'กำลังคำนวณพอร์ตและดึงข้อมูลตลาด...'
      : (isErr ? `คำนวณไม่สำเร็จ: ${escapeHtmlText(state.lastErrorMessage || 'กรุณาตรวจสอบข้อมูลแล้วลองใหม่')}` : 'ยังไม่ได้คำนวณผลพอร์ต');
    const desc = isLoading
      ? 'โปรดรอสักครู่ ระบบกำลังจัดแนวข้อมูลราคาและคำนวณสัดส่วนทุกกลยุทธ์'
      : 'เลือกสินทรัพย์อย่างน้อย 2 รายการและงบลงทุนที่หน้าตั้งค่าพอร์ต แล้วกด "คำนวณพอร์ต & ดูผลลัพธ์" เพื่อแสดงผลข้อมูลจริง';

    bannerEl.innerHTML = `
      <div class="fin-card p-6 sm:p-8 text-center space-y-4 ${isErr ? 'border-rose-300 bg-rose-50/40' : 'bg-white'}">
        <div class="w-12 h-12 rounded-2xl mx-auto flex items-center justify-center ${isErr ? 'bg-rose-100 text-rose-700' : 'bg-[#E6FBF3] text-[#008A57] border border-[#00D084]/40'}">
          <i data-lucide="${isErr ? 'alert-octagon' : (isLoading ? 'loader' : 'calculator')}" class="w-6 h-6"></i>
        </div>
        <div class="space-y-1 max-w-lg mx-auto">
          <h3 class="text-base sm:text-lg font-semibold text-slate-900">${headline}</h3>
          <p class="text-[13px] text-slate-500 leading-relaxed">${desc}</p>
        </div>
        <div class="flex flex-wrap items-center justify-center gap-2.5">
          <button type="button" onclick="runOptimization(false)" class="px-5 py-2.5 rounded-xl bg-[#00D084] hover:bg-[#00B874] text-[#0A0D12] text-sm font-semibold shadow-sm transition cursor-pointer">
            คำนวณพอร์ต &amp; ดูผลลัพธ์
          </button>
          <button type="button" onclick="switchAppTab('setup')" class="px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200/80 text-slate-700 border border-slate-200 text-sm font-medium transition cursor-pointer">
            กลับไปตั้งค่าพอร์ต
          </button>
        </div>
      </div>
    `;
    // Keep saved portfolios accessible in Goals tab if desired, or hide projection body strictly while idle
    bodyEl.classList.add('hidden');
  });

  if (window.lucide) lucide.createIcons();
}

function setResultStatus(status, reason = '') {
  state.resultStatus = status;
  state.staleReason = status === 'stale' ? reason : '';
  if (status === 'error') {
    state.lastErrorMessage = reason;
  }
  const resumeBtn = document.getElementById('landing-resume-results-btn');
  if (resumeBtn) {
    resumeBtn.classList.toggle('hidden', status !== 'ready');
  }
  renderTabStateBanners();
  updateMarketDataStatusPill();
}

function markResultsStale(reason = 'มีการแก้ไขการตั้งค่าพอร์ต') {
  if (state.optData || state.resultStatus === 'ready') {
    setResultStatus('stale', reason);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  let savedTheme = 'light';
  try {
    savedTheme = localStorage.getItem('qf_theme_v2') || 'light';
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

  state.budget = parseNumericInput(document.getElementById('budget-input')?.value) || 100000;
  const initNewsCb = document.getElementById('news-signal-toggle') || document.getElementById('use-news-adjustment-checkbox');
  if (initNewsCb) initNewsCb.checked = state.useNewsAdjustment;
  syncCurrencyToggleButtons();
  updateMaxWeightLabel(document.getElementById('max-weight-slider')?.value || 100);
  refreshAdvancedSummaryLabel();
  setResultStatus('idle');
  const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const initialRiskParam = urlParams?.get('risk') || 'balanced';
  selectLandingRiskProfile(initialRiskParam);
  setAppView(urlParams?.get('view') === 'workspace' ? 'workspace' : 'landing', false);
  selectLandingPreset(state.landingSelectedPreset);
  selectLandingPreviewTab('allocation');
  if (urlParams?.get('view') === 'workspace' && urlParams?.get('risk')) {
    enterWorkspaceWithRiskProfile(initialRiskParam);
  }
  renderDimeWealthOverview();
  hydratePopularAssetsFromCache();
  fetchLiveMarketRates();
  renderTickersList();
  updateSetupReadinessUI();
  if (state.appView === 'workspace') {
    fetchLiveQuotesForTickers();
    fetchDynamicPopularAssets();
  }
});

function isDarkTheme() {
  return document.body.classList.contains('theme-dark');
}

function isMobileViewport() {
  return typeof window !== 'undefined' && window.innerWidth < 768;
}

function getPlotlyConfig() {
  return {
    responsive: true,
    displayModeBar: false,
    scrollZoom: false
  };
}

function toggleMobileChartBox(chartId, btnEl) {
  const el = document.getElementById(chartId);
  if (!el) return;
  const willOpen = !el.classList.contains('qf-chart-open');
  el.classList.toggle('qf-chart-open', willOpen);
  if (btnEl) {
    btnEl.innerHTML = willOpen
      ? '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg><span>ซ่อนกราฟ</span>'
      : '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" x2="18" y1="20" y2="10"/><line x1="12" x2="12" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="14"/></svg><span>แสดงกราฟ</span>';
  }
  if (willOpen) {
    setTimeout(() => {
      if (chartId === 'portfolio-growth-chart' && state.optData) {
        renderPortfolioGrowthChart();
      } else if (chartId === 'goal-projection-chart' && window.lastGoalProjection) {
        renderGoalProjectionChart(window.lastGoalProjection);
      }
      if (window.Plotly?.Plots?.resize) {
        try { Plotly.Plots.resize(el); } catch (e) {}
      }
    }, 30);
  }
}

function getChartThemeTokens() {
  const dark = isDarkTheme();
  return {
    dark,
    primary: dark ? '#10B981' : '#059669',
    plotBg: dark ? 'rgba(17, 22, 32, 0.55)' : '#FFFFFF',
    grid: dark ? '#222B3B' : '#F1F5F9',
    line: dark ? '#2D374B' : '#E2E8F0',
    axisText: dark ? '#CBD5E1' : '#475569',
    legendText: dark ? '#E2E8F0' : '#334155',
    donutBorder: dark ? '#131822' : '#FFFFFF',
    donutLabel: dark ? '#E2E8F0' : '#1E293B',
    donutSub: dark ? '#CBD5E1' : '#475569',
    wfLine: dark ? '#FBBF24' : '#0F172A',
    corrScale: dark
      ? [[0.0, '#161D2B'], [0.5, '#0F4C5C'], [1.0, '#10B981']]
      : [[0.0, '#EFF6FF'], [0.5, '#DBEAFE'], [1.0, '#059669']],
    corrText: dark ? '#F8FAFC' : '#0F172A',
    hoverLabel: {
      bgcolor: dark ? '#0F172A' : '#FFFFFF',
      bordercolor: dark ? '#334155' : '#CBD5E1',
      font: { color: dark ? '#F8FAFC' : '#0F172A', family: 'Plus Jakarta Sans, Anuphan, sans-serif', size: 11.5 }
    }
  };
}

function applyAppTheme(mode, reRenderCharts = true) {
  const dark = mode === 'dark';
  state.theme = dark ? 'dark' : 'light';
  document.body.classList.toggle('theme-dark', dark);
  try {
    localStorage.setItem('qf_theme_v2', state.theme);
  } catch (e) {}

  const activeCls = 'qf-seg-btn qf-seg-active inline-flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-semibold rounded-md transition cursor-pointer';
  const inactiveCls = 'qf-seg-btn qf-seg-inactive inline-flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium rounded-md transition cursor-pointer';
  const btnLight = document.getElementById('theme-btn-light');
  const btnDark = document.getElementById('theme-btn-dark');
  if (btnLight && btnDark) {
    btnLight.className = !dark ? activeCls : inactiveCls;
    btnDark.className = dark ? activeCls : inactiveCls;
  }

  const landingThemeBtn = document.getElementById('header-landing-theme-btn');
  if (landingThemeBtn) {
    landingThemeBtn.title = dark ? 'สลับเป็นโหมดสว่าง' : 'สลับเป็นโหมดมืด';
    landingThemeBtn.setAttribute('aria-label', dark ? 'สลับเป็นโหมดสว่าง' : 'สลับเป็นโหมดมืด');
    landingThemeBtn.innerHTML = `<i id="header-landing-theme-icon" data-lucide="${dark ? 'sun' : 'moon'}" class="w-4 h-4"></i>`;
  }
  const workspaceThemeBtn = document.getElementById('header-workspace-theme-btn');
  if (workspaceThemeBtn) {
    workspaceThemeBtn.title = dark ? 'สลับเป็นโหมดสว่าง' : 'สลับเป็นโหมดมืด';
    workspaceThemeBtn.setAttribute('aria-label', dark ? 'สลับเป็นโหมดสว่าง' : 'สลับเป็นโหมดมืด');
    workspaceThemeBtn.innerHTML = `<i id="header-workspace-theme-icon" data-lucide="${dark ? 'sun' : 'moon'}" class="w-4 h-4"></i>`;
  }

  if (window.lucide) {
    lucide.createIcons();
  }

  if (reRenderCharts && state.optData) {
    const redrawAllThemeCharts = () => {
      if (!state.optData) return;
      const strat = state.optData.strategies?.[state.activeGoal];
      if (strat) renderDonutAllocationChart(strat.weights, state.optData.metadata?.tickers || []);
      renderDimeWealthOverview();
      renderPortfolioGrowthChart();
      renderEfficientFrontierPlot();
      renderCorrelationAndGrowthPlots();
      recalculateGoalProjection();
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(redrawAllThemeCharts);
    } else {
      redrawAllThemeCharts();
    }
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
    const res = await fetch(`/api/rf?currency=${encodeURIComponent(state.currency || 'THB')}`);
    if (res.ok) {
      const data = await res.json();
      state.ratesMeta = data;
      state.isFallbackRf = !!data.is_fallback_rf;
      state.isFallbackFx = !!data.is_fallback_fx;
      const rfEl = document.getElementById('top-rf-rate');
      if (rfEl && data.percentage) {
        rfEl.innerText = data.is_fallback_rf ? `${data.percentage} (สำรอง)` : data.percentage;
        const rfMetaParts = [data.rf_source, data.rf_tenor, data.rf_date ? `ณ ${data.rf_date}` : null].filter(Boolean);
        rfEl.title = rfMetaParts.join(' • ');
      }
      if (data.usd_thb_rate && !state.fxIsManual) {
        state.fxRate = Number(data.usd_thb_rate);
        const fxInput = document.getElementById('fx-rate-input');
        if (fxInput) fxInput.value = state.fxRate.toFixed(2);
        const topFx = document.getElementById('top-fx-rate');
        if (topFx) {
          topFx.innerText = data.is_fallback_fx
            ? `${state.fxRate.toFixed(2)} บาท/$ (สำรอง)`
            : `${state.fxRate.toFixed(2)} บาท/$`;
          topFx.title = data.fx_date ? `อัตราแลกเปลี่ยน ณ ${data.fx_date}` : 'อัตราแลกเปลี่ยนตลาด';
        }
        refreshAdvancedSummaryLabel();
      }
      updateMarketDataStatusPill();
    }
  } catch (e) {
    console.warn('Market rate fetch notice:', e);
  }
}

function handleFxRateChange() {
  const val = parseNumericInput(document.getElementById('fx-rate-input').value);
  if (val && val >= 15 && val <= 100) {
    state.fxRate = val;
    state.fxIsManual = true;
    const topFx = document.getElementById('top-fx-rate');
    if (topFx) topFx.innerText = `${state.fxRate.toFixed(2)} บาท/$ (กำหนดเอง)`;
    refreshAdvancedSummaryLabel();
    renderTickersList();
    markResultsStale(`ปรับเรท FX เป็น ${state.fxRate.toFixed(2)} ฿/$`);
  }
}

function syncAllBudgetInputs(formattedValue, sourceId = '') {
  ['budget-input', 'strip-budget-input', 'landing-budget-input', 'save-initial-budget'].forEach(id => {
    if (id === sourceId) return;
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) {
      el.value = formattedValue;
    }
  });
}

function syncGoalInitialBudgetToMain() {
  const goalInitEl = document.getElementById('save-initial-budget');
  if (!goalInitEl) return;
  const rawVal = goalInitEl.value;
  const numeric = parseNumericInput(rawVal);
  if (numeric >= 10) {
    const mainEl = document.getElementById('budget-input');
    if (mainEl) mainEl.value = rawVal;
    syncAllBudgetInputs(rawVal, 'save-initial-budget');
    handleBudgetQuickUpdate();
  } else {
    recalculateGoalProjection();
  }
}

function syncLandingBudgetToWorkspace(rawVal) {
  const numeric = parseNumericInput(rawVal);
  if (numeric > 0) {
    state.budget = numeric;
  }
  syncAllBudgetInputs(rawVal, 'landing-budget-input');
}

function setLandingQuickBudget(amount) {
  const targetAmt = state.currency === 'USD'
    ? Math.max(100, Math.round(amount / (state.fxRate > 0 ? state.fxRate : 34.5)))
    : amount;
  const formatted = formatNumberWithCommas(targetAmt, 0);
  const landingIn = document.getElementById('landing-budget-input');
  if (landingIn) landingIn.value = formatted;
  state.budget = targetAmt;
  syncAllBudgetInputs(formatted, 'landing-budget-input');

  document.querySelectorAll('.qf-landing-chip').forEach(btn => {
    const isMatch = btn.getAttribute('onclick')?.includes(`(${amount})`);
    btn.className = isMatch
      ? 'qf-landing-chip px-2 py-0.5 rounded-lg bg-[#E6FBF3] text-[#008A57] text-[11px] font-bold transition cursor-pointer'
      : 'qf-landing-chip px-2 py-0.5 rounded-lg bg-slate-100 hover:bg-slate-200/80 text-[11px] font-semibold text-slate-700 transition cursor-pointer';
  });
  handleBudgetQuickUpdate();
}

function syncStripBudgetToMain(rawVal) {
  const mainInput = document.getElementById('budget-input');
  if (mainInput) mainInput.value = rawVal;
  syncAllBudgetInputs(rawVal, 'strip-budget-input');
  handleBudgetQuickUpdate();
}

function setQuickBudget(amount) {
  const input = document.getElementById('budget-input');
  const formatted = formatNumberWithCommas(amount, 0);
  if (input) input.value = formatted;
  syncAllBudgetInputs(formatted, 'budget-input');
  handleBudgetQuickUpdate();
}

function handleBudgetQuickUpdate() {
  const mainEl = document.getElementById('budget-input');
  const budget = parseNumericInput(mainEl?.value) || 100000;
  state.budget = budget;
  setCanonicalFxField('budget', budget, state.currency);
  if (mainEl) {
    syncAllBudgetInputs(mainEl.value, 'budget-input');
  }
  updateQuickBudgetHighlights(budget);
  updateSetupReadinessUI();
  if (!state.optData || budget < 10) {
    renderDimeWealthOverview();
    return;
  }

  const oldBudget = state.optData.metadata.budget || 100000;
  const ratio = oldBudget > 0 ? budget / oldBudget : 1;

  state.optData.metadata.budget = budget;

  // Scale all monetary metrics proportionally using ratio so Peak-to-Trough invariant holds strictly
  Object.keys(state.optData.strategies).forEach(k => {
    const s = state.optData.strategies[k];
    s.expected_annual_profit = Number((s.expected_return * budget).toFixed(2));
    s.expected_annual_dividend = Number(((s.dividend_yield || 0) * budget).toFixed(2));
    if (s.drawdown_details) {
      s.drawdown_details.peak_value = Number((s.drawdown_details.peak_value * ratio).toFixed(2));
      s.drawdown_details.trough_value = Number((s.drawdown_details.trough_value * ratio).toFixed(2));
      s.drawdown_details.peak_to_trough_amount = Number((Math.max(0, s.drawdown_details.peak_value - s.drawdown_details.trough_value)).toFixed(2));
      s.drawdown_details.max_drawdown_amount = s.drawdown_details.peak_to_trough_amount;
      s.drawdown_details.min_capital_remaining = s.drawdown_details.trough_value;
      if (s.drawdown_details.min_portfolio_value !== undefined) {
        s.drawdown_details.min_portfolio_value = Number((s.drawdown_details.min_portfolio_value * ratio).toFixed(2));
      }
      if (s.drawdown_details.initial_budget_scaled_loss !== undefined) {
        s.drawdown_details.initial_budget_scaled_loss = Number((s.drawdown_details.initial_budget_scaled_loss * ratio).toFixed(2));
      }
      s.max_drawdown_amount = s.drawdown_details.max_drawdown_amount;
      s.min_capital_remaining = s.drawdown_details.min_capital_remaining;
    } else {
      s.max_drawdown_amount = Number(((s.max_drawdown_amount || 0) * ratio).toFixed(2));
      s.min_capital_remaining = Number(((s.min_capital_remaining || 0) * ratio).toFixed(2));
    }
    s.final_historical_value = Number((s.final_historical_value * ratio).toFixed(2));
  });

  if (state.optData.portfolio_growth) {
    Object.keys(state.optData.portfolio_growth.series || {}).forEach(k => {
      state.optData.portfolio_growth.series[k] = state.optData.portfolio_growth.series[k].map(v => Number((v * ratio).toFixed(2)));
    });
    if (state.optData.portfolio_growth.walk_forward_series) {
      Object.keys(state.optData.portfolio_growth.walk_forward_series).forEach(k => {
        state.optData.portfolio_growth.walk_forward_series[k] = state.optData.portfolio_growth.walk_forward_series[k].map(v => Number((v * ratio).toFixed(2)));
      });
    }
    if (state.optData.portfolio_growth.drawdown_amount_series) {
      Object.keys(state.optData.portfolio_growth.drawdown_amount_series).forEach(k => {
        state.optData.portfolio_growth.drawdown_amount_series[k] = state.optData.portfolio_growth.drawdown_amount_series[k].map(v => Number((v * ratio).toFixed(2)));
      });
    }
  }

  (state.optData.asset_stats || []).forEach(a => {
    if (a.drawdown_details) {
      a.drawdown_details.peak_value = Number((a.drawdown_details.peak_value * ratio).toFixed(2));
      a.drawdown_details.trough_value = Number((a.drawdown_details.trough_value * ratio).toFixed(2));
      a.drawdown_details.peak_to_trough_amount = Number((Math.max(0, a.drawdown_details.peak_value - a.drawdown_details.trough_value)).toFixed(2));
      a.drawdown_details.max_drawdown_amount = a.drawdown_details.peak_to_trough_amount;
      a.drawdown_details.min_capital_remaining = a.drawdown_details.trough_value;
      a.max_drawdown_amount = a.drawdown_details.max_drawdown_amount;
      a.min_capital_remaining = a.drawdown_details.min_capital_remaining;
    } else {
      a.max_drawdown_amount = Number(((a.max_drawdown_amount || 0) * ratio).toFixed(2));
      a.min_capital_remaining = Number(((a.min_capital_remaining || 0) * ratio).toFixed(2));
    }
  });

  // Instant 0ms update for visible text & cards, 120ms debounced update for heavy Plotly charts
  renderDimeWealthOverview();
  renderActiveGoalView();
  clearTimeout(state.budgetDebounceTimer);
  state.budgetDebounceTimer = setTimeout(() => {
    renderBacktestStressCard();
    renderStrategyCompareTable();
    renderAssetStatsTable();
    if (state.activeTab === 'backtest') {
      renderPortfolioGrowthChart();
    } else if (state.activeTab === 'goals') {
      recalculateGoalProjection();
    }
  }, 120);
}

// Preset Selection
function applyPreset(presetKey, autoRun = true, preserveBudgetAndCurrency = false) {
  const p = PRESETS[presetKey];
  if (!p) return;

  const tierInfo = getActiveUserTierInfo();
  const maxAssets = Number(tierInfo.maxAssets || 5);
  state.tickers = p.tickers.slice(0, maxAssets);
  if (typeof cancelEditingSavedPortfolio === 'function') {
    cancelEditingSavedPortfolio();
  }
  const saveNameResetEl = document.getElementById('save-portfolio-name');
  if (saveNameResetEl) {
    saveNameResetEl.value = '';
  }
  if (p.tickers.length > maxAssets && typeof showPortfolioToastApp === 'function') {
    showPortfolioToastApp(`แพ็กเกจ ${tierInfo.labelTh} เลือกได้สูงสุด ${maxAssets} สินทรัพย์ (เข้าสู่ระบบฟรีเพื่อปลดล็อก 8 ตัว หรืออัปเกรด Pro สูงสุด 15 ตัว)`);
  }
  state.blViews = null;
  if (p.start) document.getElementById('start-date-input').value = p.start;
  if (p.end) document.getElementById('end-date-input').value = p.end;

  if (!preserveBudgetAndCurrency) {
    if (p.currency) {
      const sel = document.getElementById('currency-select');
      if (sel) sel.value = p.currency;
      updateCurrencySymbol(false);
    }
    if (p.budget) {
      const formattedBudget = formatNumberWithCommas(p.budget, 0);
      syncAllBudgetInputs(formattedBudget, '');
      state.budget = p.budget;
      setCanonicalFxField('budget', p.budget, state.currency);
    }
  }

  // Highlight active timeframe (3Y)
  document.querySelectorAll('.tf-btn').forEach(b => {
    b.className = 'tf-btn px-1.5 py-0.5 rounded bg-white border border-slate-200 text-slate-600 hover:bg-slate-100 font-medium cursor-pointer';
  });
  const btn3Y = document.getElementById('tf-btn-3Y');
  if (btn3Y) {
    btn3Y.className = 'tf-btn px-1.5 py-0.5 rounded bg-slate-900 text-white font-semibold cursor-pointer';
  }

  // Highlight active preset button (both inside drawer and Tab 1 1-click shortcut pills)
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.className = 'preset-btn px-3 py-2 text-left text-[13px] rounded-xl bg-white hover:bg-slate-50 text-slate-800 font-semibold border border-slate-200 transition cursor-pointer';
  });
  const activeBtn = document.getElementById(`preset-btn-${presetKey}`);
  if (activeBtn) {
    activeBtn.className = 'preset-btn px-3 py-2 text-left text-[13px] rounded-xl bg-blue-50 text-blue-800 font-bold border border-blue-200 transition cursor-pointer';
  }
  document.querySelectorAll('.qf-quick-sample-pill').forEach(pill => {
    pill.classList.toggle('active', pill.id === `quick-sample-${presetKey}`);
  });
  if (!autoRun && p.label && typeof showPortfolioToastApp === 'function' && p.tickers.length <= maxAssets) {
    showPortfolioToastApp(`โหลดชุดตัวอย่าง "${p.label}" (${state.tickers.length} สินทรัพย์) แล้ว — กด "คำนวณพอร์ต" ได้ทันที`);
  }

  renderTickersList();
  updateMaxWeightLabel(document.getElementById('max-weight-slider')?.value || 100);
  refreshAdvancedSummaryLabel();
  updateSetupReadinessUI();
  fetchLiveQuotesForTickers();
  if (autoRun) {
    runOptimization(false);
  } else if (state.resultStatus === 'ready') {
    markResultsStale('เปลี่ยนชุดสินทรัพย์ตัวอย่าง');
  }
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
  markResultsStale(`เปลี่ยนช่วงข้อมูลเป็น ${tf}`);
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
  updateSetupReadinessUI();
}

function setMaxWeight(val) {
  const slider = document.getElementById('max-weight-slider');
  slider.value = val;
  updateMaxWeightLabel(val);
  markResultsStale(`เปลี่ยนเพดานสัดส่วนต่อหุ้นเป็น ${val}%`);
}

// Global Currency Switcher (THB <-> USD) with centralized FX & re-optimization
function setGlobalCurrency(targetCurr) {
  const sel = document.getElementById('currency-select');
  if (sel) {
    sel.value = targetCurr;
  }
  updateCurrencySymbol(true);
}

function syncCurrencyToggleButtons() {
  const isThb = state.currency === 'THB';
  const pairs = [
    ['header-curr-thb', 'header-curr-usd', 'qf-seg-btn qf-seg-active px-2 sm:px-2.5 py-1 text-[11px] sm:text-xs font-semibold rounded-md transition cursor-pointer', 'qf-seg-btn qf-seg-inactive px-2 sm:px-2.5 py-1 text-[11px] sm:text-xs font-medium rounded-md transition cursor-pointer']
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
  const landingSym = document.getElementById('landing-budget-curr-symbol');
  if (landingSym) landingSym.innerText = state.currencySymbol;

  document.querySelectorAll('.curr-unit-inline').forEach(el => {
    el.innerText = state.currencyUnitText;
  });
}

function ensureCanonicalFxAnchorMap() {
  if (!state.fxRoundTripAnchor || typeof state.fxRoundTripAnchor !== 'object' || !('budget' in state.fxRoundTripAnchor && typeof state.fxRoundTripAnchor.budget === 'object')) {
    state.fxRoundTripAnchor = {
      budget: null,
      target: null,
      dca: null
    };
  }
  return state.fxRoundTripAnchor;
}

function setCanonicalFxField(fieldKey, numericValue, currency = state.currency) {
  if (!['budget', 'target', 'dca'].includes(fieldKey)) return;
  const num = Number(numericValue);
  if (!Number.isFinite(num) || num < 0) return;
  const curr = currency === 'USD' ? 'USD' : 'THB';
  const map = ensureCanonicalFxAnchorMap();
  map[fieldKey] = {
    value: num,
    baseCurrency: curr,
    lastCurrency: curr,
    lastDisplayed: num
  };
}

if (typeof window !== 'undefined') {
  window.setCanonicalFxField = setCanonicalFxField;
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

  // Convert budget & goal inputs proportionally when switching between THB and USD.
  // [2.2] Maintain independent per-field canonical (unrounded value + baseCurrency) anchors so
  // THB <-> USD <-> THB round-trips restore exact values with zero drift even if another field is edited.
  const fx = state.fxRate > 0 ? state.fxRate : 34.50;
  if (prevCurrency !== nextCurrency) {
    const convFactor = nextCurrency === 'USD' ? (1.0 / fx) : fx;
    const budgetEl = document.getElementById('budget-input');
    const targetEl = document.getElementById('save-target-amount');
    const dcaEl = document.getElementById('save-monthly-dca');

    const curBudget = budgetEl ? (parseNumericInput(budgetEl.value) || 100000) : (state.budget || 100000);
    const curTarget = targetEl ? (parseNumericInput(targetEl.value) || 1000000) : 1000000;
    const curDca = dcaEl ? (parseNumericInput(dcaEl.value) || 0) : 0;

    const anchorMap = ensureCanonicalFxAnchorMap();
    const resolveFieldConversion = (fieldKey, currentDisplayedVal, editTolerance, allowUsdDecimals) => {
      let entry = anchorMap[fieldKey];
      const wasEdited = !entry
        || entry.lastCurrency !== prevCurrency
        || Math.abs(currentDisplayedVal - Number(entry.lastDisplayed)) > editTolerance;
      if (wasEdited) {
        entry = {
          value: currentDisplayedVal,
          baseCurrency: prevCurrency,
          lastCurrency: prevCurrency,
          lastDisplayed: currentDisplayedVal
        };
        anchorMap[fieldKey] = entry;
      }

      let nextVal;
      if (entry.baseCurrency === nextCurrency) {
        nextVal = entry.value;
      } else {
        const factor = nextCurrency === 'USD' ? (1.0 / fx) : fx;
        const rawConverted = entry.value * factor;
        nextVal = (allowUsdDecimals && nextCurrency === 'USD')
          ? Math.round(rawConverted * 100) / 100
          : Math.round(rawConverted);
      }
      entry.lastCurrency = nextCurrency;
      entry.lastDisplayed = nextVal;
      return nextVal;
    };

    if (budgetEl) {
      const newBudget = resolveFieldConversion('budget', curBudget, 0.01, true);
      state.budget = newBudget;
      const formattedNew = formatNumberWithCommas(newBudget, nextCurrency === 'USD' ? 2 : 0);
      syncAllBudgetInputs(formattedNew, '');
    }

    Object.keys(state.customHoldings).forEach(t => {
      state.customHoldings[t] = Math.round((Number(state.customHoldings[t]) || 0) * convFactor * 100) / 100;
    });
    Object.keys(state.customCost).forEach(t => {
      state.customCost[t] = Math.round((Number(state.customCost[t]) || 0) * convFactor * 100) / 100;
    });
    Object.keys(state.customPnl).forEach(t => {
      state.customPnl[t] = Math.round((Number(state.customPnl[t]) || 0) * convFactor * 100) / 100;
    });
    state.customCashInjection = Math.round((Number(state.customCashInjection) || 0) * convFactor * 100) / 100;
    const cashInEl = document.getElementById('custom-cash-injection');
    if (cashInEl) cashInEl.value = formatNumberWithCommas(state.customCashInjection, 2);

    const goalInitEl = document.getElementById('save-initial-budget');
    if (goalInitEl) {
      goalInitEl.value = formatNumberWithCommas(state.budget, 0);
    }
    if (targetEl) {
      const newTarget = resolveFieldConversion('target', curTarget, 0.5, false);
      targetEl.value = formatNumberWithCommas(newTarget, 0);
    }
    if (dcaEl) {
      const newDca = resolveFieldConversion('dca', curDca, 0.5, false);
      dcaEl.value = formatNumberWithCommas(newDca, 0);
    }
    fetchLiveMarketRates();

    // Immediately convert cached optData figures proportionally to prevent transient mixed currency symbol/number mismatch
    if (state.optData) {
      state.optData.metadata.budget = state.budget;
      state.optData.metadata.currency = nextCurrency;
      Object.values(state.optData.strategies || {}).forEach(s => {
        if (s.expected_annual_profit !== undefined) s.expected_annual_profit = Number((s.expected_annual_profit * convFactor).toFixed(2));
        if (s.expected_annual_dividend !== undefined) s.expected_annual_dividend = Number((s.expected_annual_dividend * convFactor).toFixed(2));
        if (s.max_drawdown_amount !== undefined) s.max_drawdown_amount = Number((s.max_drawdown_amount * convFactor).toFixed(2));
        if (s.min_capital_remaining !== undefined) s.min_capital_remaining = Number((s.min_capital_remaining * convFactor).toFixed(2));
        if (s.final_historical_value !== undefined) s.final_historical_value = Number((s.final_historical_value * convFactor).toFixed(2));
        if (s.drawdown_details) {
          ['peak_value', 'trough_value', 'peak_to_trough_amount', 'max_drawdown_amount', 'min_capital_remaining', 'min_portfolio_value', 'initial_budget_scaled_loss'].forEach(k => {
            if (s.drawdown_details[k] !== undefined) s.drawdown_details[k] = Number((s.drawdown_details[k] * convFactor).toFixed(2));
          });
        }
      });
      if (state.rebalanceMode === 'custom') renderCustomHoldingsInputs();
      renderActiveGoalView();
    }
  }

  renderTickersList();
  renderDimeWealthOverview();

  if (prevCurrency !== nextCurrency && state.optData) {
    markResultsStale(`เปลี่ยนสกุลเงินเป็น ${nextCurrency}`);
    if (reRun && state.tickers.length >= 2) {
      runOptimization(false);
    }
  }
}

// Primary Investment Mode Selector ('new_capital' vs 'existing_portfolio' vs 'goal_based')
// Stays on Setup so users finish picking stocks/budget before routing to the mode's result view.
function selectPrimaryInvestmentMode(modeKey) {
  const resolvedMode = ['new_capital', 'existing_portfolio', 'goal_based'].includes(modeKey) ? modeKey : 'new_capital';
  state.primaryMode = resolvedMode;

  const activePillClass = 'qf-seg-btn qf-seg-active cursor-pointer min-h-[36px] px-2 sm:px-3.5 py-1.5 rounded-lg font-semibold text-[11.5px] sm:text-xs transition inline-flex items-center justify-center gap-1.5 whitespace-nowrap';
  const inactivePillClass = 'qf-seg-btn qf-seg-inactive cursor-pointer min-h-[36px] px-2 sm:px-3.5 py-1.5 rounded-lg font-medium text-[11.5px] sm:text-xs transition inline-flex items-center justify-center gap-1.5 whitespace-nowrap';

  ['new_capital', 'existing_portfolio', 'goal_based'].forEach(k => {
    const card = document.getElementById(`primary-mode-card-${k}`);
    const badge = document.getElementById(`primary-mode-badge-${k}`);
    const isSelected = k === resolvedMode;
    if (card) {
      card.className = isSelected ? activePillClass : inactivePillClass;
      card.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    }
    if (badge) {
      badge.className = 'hidden';
      badge.innerText = isSelected ? 'กำลังเลือก' : 'คลิกเลือก';
    }
  });

  if (resolvedMode === 'existing_portfolio') {
    setRebalanceMode('custom');
  } else {
    setRebalanceMode('cash');
  }

  const helperMap = {
    new_capital: '',
    existing_portfolio: '<strong class="text-slate-900">ปรับพอร์ตเดิม:</strong> เลือกสินทรัพย์ที่ถืออยู่ด้านล่างแล้วกดคำนวณ ระบบจะเปิดหน้ากรอกจำนวนที่ถือเดิมให้อัตโนมัติ',
    goal_based: '<strong class="text-slate-900">เป้าหมาย &amp; DCA:</strong> เลือกสินทรัพย์และงบตั้งต้นแล้วกดคำนวณ ระบบจะพาไปหน้าวางแผนออมรายเดือนอัตโนมัติ'
  };
  const helperBar = document.getElementById('setup-mode-helper-bar');
  const helperEl = document.getElementById('setup-mode-helper-text');
  const msg = helperMap[resolvedMode] || (state.resultStatus === 'ready'
    ? '<strong class="text-slate-900">คำนวณแผนล่าสุดพร้อมแล้ว:</strong> กดปุ่มด้านขวาเพื่อเปิดดูใบสั่งซื้อ–ขายและผลลัพธ์ได้ทันที'
    : '');
  if (helperEl) {
    helperEl.innerHTML = msg;
  }
  if (helperBar) {
    const showBar = !!msg;
    helperBar.classList.toggle('hidden', !showBar);
  }

  updateSetupReadinessUI();
}

function toggleStockPickerDrawer(forceState) {
  const drawer = document.getElementById('setup-stock-picker-drawer');
  const btn = document.getElementById('stock-picker-drawer-btn');
  const chev = document.getElementById('stock-picker-drawer-chevron');
  const hint = document.getElementById('stock-picker-drawer-hint');
  if (!drawer) return;
  const shouldOpen = typeof forceState === 'boolean' ? forceState : drawer.classList.contains('hidden');
  drawer.classList.toggle('hidden', !shouldOpen);
  if (btn) btn.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
  if (chev) chev.style.transform = shouldOpen ? 'rotate(180deg)' : 'rotate(0deg)';
  if (hint) hint.innerText = shouldOpen ? 'พับเก็บ' : 'กดเพื่อเปิดดู';
  if (shouldOpen && typeof fetchDynamicPopularAssets === 'function') {
    fetchDynamicPopularAssets();
  }
}

function jumpToActivePrimaryModeResult() {
  if (state.primaryMode === 'existing_portfolio') {
    setRebalanceMode('custom');
    switchAppTab('trade-plan');
    setTimeout(() => {
      const ddBody = document.getElementById('deep-dive-body-trade-plan');
      const ddChev = document.getElementById('deep-dive-chevron-trade-plan');
      if (ddBody) ddBody.classList.remove('hidden');
      if (ddChev) ddChev.style.transform = 'rotate(180deg)';
      const customPanel = document.getElementById('custom-holdings-panel');
      if (customPanel) {
        customPanel.classList.remove('hidden');
        customPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 80);
  } else if (state.primaryMode === 'goal_based') {
    switchAppTab('goals');
  } else {
    switchAppTab('trade-plan');
  }
}

function switchStockPickerSource(sourceKey = 'catalog') {
  const activeKey = sourceKey === 'presets' ? 'presets' : 'catalog';
  const catalogBox = document.getElementById('quick-stock-catalog-box');
  const presetsPanel = document.getElementById('setup-presets-panel');
  if (catalogBox) catalogBox.classList.toggle('hidden', activeKey !== 'catalog');
  if (presetsPanel) presetsPanel.classList.toggle('hidden', activeKey !== 'presets');

  ['catalog', 'presets'].forEach(k => {
    const tabBtn = document.getElementById(`stock-source-tab-${k}`);
    if (tabBtn) {
      const isAct = k === activeKey;
      tabBtn.setAttribute('aria-selected', isAct ? 'true' : 'false');
      tabBtn.className = isAct
        ? 'qf-source-tab qf-seg-btn qf-seg-active px-3 py-1 rounded-md font-semibold transition cursor-pointer'
        : 'qf-source-tab qf-seg-btn qf-seg-inactive px-3 py-1 rounded-md font-medium transition cursor-pointer';
    }
  });
}

function updateQuickBudgetHighlights(currentBudget) {
  document.querySelectorAll('.qf-quick-budget-btn').forEach(btn => {
    const val = Number(btn.dataset.quickBudget || 0);
    const isMatch = val > 0 && Math.abs(val - currentBudget) < 0.01;
    btn.className = isMatch
      ? 'qf-quick-budget-btn qf-budget-active min-h-[32px] px-2.5 py-0.5 text-xs font-mono font-semibold rounded-md bg-slate-900 text-white border border-slate-900 transition cursor-pointer tabular-nums'
      : 'qf-quick-budget-btn min-h-[32px] px-2.5 py-0.5 text-xs font-mono font-medium rounded-md bg-white border border-slate-200 hover:border-slate-400 text-slate-700 transition cursor-pointer tabular-nums';
  });
}

function updateSetupReadinessUI() {
  const tickerCount = (state.tickers || []).length;
  const budgetEl = document.getElementById('budget-input');
  const budgetVal = budgetEl ? parseNumericInput(budgetEl.value) : (state.budget || 0);
  const sliderEl = document.getElementById('max-weight-slider');
  const maxWeightPct = sliderEl ? parseFloat(sliderEl.value) : 100;
  const maxWeight = maxWeightPct / 100.0;

  // 1. Update Step 1 Assets Status Counter (Subtle Monospace Tag)
  const statusPill = document.getElementById('setup-assets-status-pill');
  const tierInfo = getActiveUserTierInfo();
  const maxAssets = Number(tierInfo.maxAssets || 5);
  if (statusPill) {
    if (tickerCount > maxAssets) {
      statusPill.className = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-mono font-semibold bg-amber-50 text-amber-900 border border-amber-300 shrink-0 tabular-nums';
      statusPill.innerText = `${tickerCount}/${maxAssets} (เกินเพดาน)`;
    } else if (tickerCount >= 2) {
      statusPill.className = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-mono font-semibold bg-slate-100 text-slate-700 border border-slate-200 shrink-0 tabular-nums';
      statusPill.innerText = `${tickerCount}/${maxAssets}`;
    } else {
      const need = Math.max(1, 2 - tickerCount);
      statusPill.className = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-mono font-semibold bg-amber-50 text-amber-900 border border-amber-300 shrink-0 tabular-nums';
      statusPill.innerText = `เพิ่มอีก ${need}`;
    }
  }

  // 2. Update Readiness Warning Bar (Hidden when ready so Calculate CTA dominates; shown ONLY when action is needed)
  const readinessBar = document.getElementById('setup-readiness-bar');
  const readinessText = document.getElementById('setup-readiness-text');
  const calcBtn = document.getElementById('run-optimize-btn');

  let issueMsg = '';
  if (tickerCount < 2) {
    const need = Math.max(1, 2 - tickerCount);
    issueMsg = `เลือกสินทรัพย์ฝั่งซ้ายเพิ่มอีก ${need} ตัว (อย่างน้อย 2 ตัว) เพื่อเริ่มคำนวณ`;
  } else if (!budgetVal || budgetVal < 10) {
    issueMsg = 'ระบุเงินลงทุนอย่างน้อย 10 เพื่อเริ่มคำนวณ';
  } else if (maxWeight * tickerCount < 0.9999) {
    const minReqPct = Math.ceil(100 / tickerCount);
    issueMsg = `เพดานน้ำหนักต่อสินทรัพย์ (${Math.round(maxWeightPct)}%) ต่ำเกินไป — ปรับในตั้งค่าขั้นสูงอย่างน้อย ${minReqPct}%`;
  }

  if (readinessBar && readinessText) {
    readinessBar.classList.toggle('hidden', !issueMsg);
    readinessText.innerText = issueMsg;
  }

  if (calcBtn && state.resultStatus !== 'loading') {
    calcBtn.disabled = !!issueMsg;
    calcBtn.classList.toggle('opacity-55', !!issueMsg);
    calcBtn.classList.toggle('cursor-not-allowed', !!issueMsg);
    calcBtn.classList.toggle('cursor-pointer', !issueMsg);
  }

  // 3. Update optional quick jump link in mode helper strip when results are already ready
  const helperBar = document.getElementById('setup-mode-helper-bar');
  const helperEl = document.getElementById('setup-mode-helper-text');
  const jumpBtn = document.getElementById('setup-mode-jump-btn');
  const jumpLbl = document.getElementById('setup-mode-jump-label');
  if (jumpBtn) {
    const canJump = state.resultStatus === 'ready';
    jumpBtn.classList.toggle('hidden', !canJump);
    if (canJump && jumpLbl) {
      if (state.primaryMode === 'existing_portfolio') jumpLbl.innerText = 'ไปหน้ากรอกพอร์ตเดิมเลย';
      else if (state.primaryMode === 'goal_based') jumpLbl.innerText = 'ไปหน้าเป้าหมาย & DCA เลย';
      else jumpLbl.innerText = 'ไปดูใบสั่งซื้อ-ขายล่าสุด';
    }
    if (helperBar) {
      if (canJump && helperEl && !helperEl.innerText.trim()) {
        helperEl.innerHTML = '<strong class="text-slate-900">คำนวณแผนล่าสุดพร้อมแล้ว:</strong> กดปุ่มด้านขวาเพื่อเปิดดูใบสั่งซื้อ–ขายและผลลัพธ์ได้ทันที';
      }
      const hasHelperText = !!(helperEl && helperEl.innerText.trim());
      helperBar.classList.toggle('hidden', !hasHelperText && !canJump);
    }
  }
}

// Goal Selection (Instant reactive update)
function selectGoal(goalKey) {
  const validGoalKeys = ['max_sharpe', 'min_volatility', 'hrp', 'equal_weight'];
  const normalizedKey = goalKey === 'min_vol' ? 'min_volatility' : goalKey;
  const resolvedKey = validGoalKeys.includes(normalizedKey) ? normalizedKey : 'max_sharpe';
  if (state.activeGoal !== resolvedKey) {
    state.executedOrders = {};
  }
  state.activeGoal = resolvedKey;

  validGoalKeys.forEach(k => {
    const card = document.getElementById(`goal-card-${k}`);
    if (card) {
      if (k === resolvedKey) card.classList.add('active');
      else card.classList.remove('active');
    }
    const pill = document.getElementById(`top-pill-${k}`);
    if (pill) {
      if (k === resolvedKey) {
        pill.className = 'top-goal-pill qf-seg-btn qf-seg-active px-2.5 py-1 rounded-md text-xs font-semibold transition cursor-pointer whitespace-nowrap text-center';
      } else {
        pill.className = 'top-goal-pill qf-seg-btn qf-seg-inactive px-2.5 py-1 rounded-md text-xs font-medium transition cursor-pointer whitespace-nowrap text-center';
      }
    }
  });

  updateSetupReadinessUI();
  if (state.optData) {
    renderActiveGoalView();
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
  if (state.rebalanceMode !== mode) {
    state.executedOrders = {};
  }
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
      state.customCost[t] = perAsset;
      state.customPnl[t] = 0;
      state.customHoldings[t] = perAsset;
      const p = getAssetPriceInCurrentCurrency(t);
      state.customShares[t] = p > 0 ? Number((perAsset / p).toFixed(4)) : 0;
    });
  } else {
    tickers.forEach(t => {
      if (state.customCost[t] === undefined) state.customCost[t] = Number(state.customHoldings[t]) || 0;
      if (state.customPnl[t] === undefined) state.customPnl[t] = 0;
    });
  }
}

function getAssetPriceInCurrentCurrency(ticker) {
  const px = getEffectiveAssetPrice(ticker, state.currency, state.fxRate);
  return px > 0 ? px : 1;
}

function setHoldingsInputUnit(unit) {
  state.holdingsInputUnit = unit;
  const btnMoney = document.getElementById('holdings-unit-btn-money');
  const btnShares = document.getElementById('holdings-unit-btn-shares');
  if (btnMoney && btnShares) {
    if (unit === 'money') {
      btnMoney.className = 'px-2.5 py-1 rounded-lg font-bold bg-slate-900 text-white transition cursor-pointer';
      btnShares.className = 'px-2.5 py-1 rounded-lg font-medium text-slate-700 hover:text-slate-900 transition cursor-pointer';
    } else {
      btnShares.className = 'px-2.5 py-1 rounded-lg font-bold bg-slate-900 text-white transition cursor-pointer';
      btnMoney.className = 'px-2.5 py-1 rounded-lg font-medium text-slate-700 hover:text-slate-900 transition cursor-pointer';
    }
  }

  // Sync shares from net market value when switching to shares mode
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
      state.customCost[t] = 0;
      state.customPnl[t] = 0;
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
        state.customCost[t] = amt;
        state.customPnl[t] = 0;
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

function formatCustomAssetNetBadgeHtml(costVal, pnlVal, netVal, price) {
  const isOverLoss = (costVal + pnlVal) < 0;
  const shares = price > 0 ? (netVal / price) : 0;
  const pnlPct = costVal > 0 ? ((pnlVal / costVal) * 100) : 0;
  const pctBadge = pnlVal < -0.005
    ? `<span class="px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200 font-mono text-[10px] font-bold">${pnlPct.toFixed(1)}%</span>`
    : (pnlVal > 0.005
      ? `<span class="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 font-mono text-[10px] font-bold">+${pnlPct.toFixed(1)}%</span>`
      : '');
  if (isOverLoss) {
    return `<span class="text-amber-700 font-semibold">ขาดทุนเกินต้นทุน ➔ คิดสุทธิ ${maskIfPrivate(formatMoney(0, 0, false))}</span>`;
  }
  return `
    <span class="font-semibold text-slate-700">สุทธิ <b class="font-mono text-slate-900">${maskIfPrivate(formatMoney(netVal, 2, false))}</b></span>
    ${pctBadge}
    <span class="text-slate-400 font-mono">• ~${formatShareUnits(shares, shares < 1 ? 4 : 2)} หน่วย</span>
  `;
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
    const safeT = escapeHtmlText(t);
    const costVal = state.customCost[t] !== undefined ? Number(state.customCost[t]) : (Number(state.customHoldings[t]) || 0);
    const pnlVal = state.customPnl[t] !== undefined ? Number(state.customPnl[t]) : 0;
    const netVal = state.customHoldings[t] !== undefined
      ? Number(state.customHoldings[t])
      : Math.max(0, Number((costVal + pnlVal).toFixed(2)));
    const sharesVal = state.customShares[t] !== undefined
      ? Number(state.customShares[t])
      : (price > 0 ? Number((netVal / price).toFixed(4)) : 0);

    if (isSharesMode) {
      const inputVal = formatNumberWithCommas(sharesVal, 4);
      return `
        <div class="p-3 rounded-xl bg-white border border-slate-200 flex items-center justify-between gap-2.5">
          <div class="flex items-center gap-2 min-w-0">
            <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background-color: ${color}"></span>
            <div class="min-w-0">
              <div class="text-xs font-extrabold font-mono text-slate-900">${safeT}</div>
              <div class="text-[11px] text-slate-500 truncate" id="custom-sub-${safeT}">คิดเป็น ${maskIfPrivate(formatMoney(netVal, 2, false))} (@${formatMoney(price, 2, false)})</div>
            </div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <input
              type="text"
              inputmode="decimal"
              value="${inputVal}"
              data-ticker="${safeT}"
              oninput="formatLiveCommaInput(this, false); handleCustomHoldingInput(this)"
              class="w-28 px-2.5 py-1.5 text-xs font-mono font-bold text-right bg-slate-50 border border-slate-300 rounded-lg text-slate-900 focus:bg-white focus:outline-none focus:border-[#00D084] qf-privacy-input"
            />
            <span class="text-[11px] font-semibold text-slate-500">หน่วย</span>
          </div>
        </div>
      `;
    }

    const costStr = formatNumberWithCommas(costVal, 2);
    const pnlStr = pnlVal === 0 ? '0' : `${pnlVal < 0 ? '-' : ''}${formatNumberWithCommas(Math.abs(pnlVal), 2)}`;
    const pnlColorCls = pnlVal < -0.005 ? 'text-rose-600 border-rose-300 bg-rose-50/50' : (pnlVal > 0.005 ? 'text-emerald-700 border-emerald-300 bg-emerald-50/40' : 'text-slate-900 border-slate-300 bg-slate-50');

    return `
      <div class="p-3 rounded-xl bg-white border border-slate-200 space-y-2">
        <div class="flex items-center justify-between gap-2 flex-wrap">
          <div class="flex items-center gap-2 min-w-0">
            <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background-color: ${color}"></span>
            <span class="text-xs font-extrabold font-mono text-slate-900">${safeT}</span>
            <span class="text-[11px] text-slate-400 font-mono">@${formatMoney(price, 2, false)}</span>
          </div>
          <div class="text-[11px] flex items-center gap-1.5 flex-wrap" id="custom-sub-${safeT}">
            ${formatCustomAssetNetBadgeHtml(costVal, pnlVal, netVal, price)}
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div class="flex items-center gap-1.5 bg-slate-50 border border-slate-300 rounded-lg px-2 py-1 focus-within:bg-white focus-within:border-[#00D084]">
            <span class="text-[10px] font-semibold text-slate-500 shrink-0">เงินต้น</span>
            <input
              type="text"
              inputmode="decimal"
              value="${costStr}"
              data-ticker="${safeT}"
              data-field="cost"
              aria-label="เงินต้น ${safeT}"
              oninput="formatLiveCommaInput(this, false); handleCustomCostPnlInput(this, 'cost')"
              class="w-full min-w-0 bg-transparent text-xs font-mono font-bold text-right text-slate-900 focus:outline-none tabular-nums qf-privacy-input"
            />
          </div>
          <div id="custom-pnl-wrap-${safeT}" class="flex items-center gap-1.5 border rounded-lg px-2 py-1 focus-within:bg-white focus-within:border-[#00D084] ${pnlColorCls}">
            <span class="text-[10px] font-semibold text-slate-500 shrink-0">กำไร/ขาดทุน</span>
            <input
              type="text"
              inputmode="decimal"
              value="${pnlStr}"
              placeholder="-5,000"
              data-ticker="${safeT}"
              data-field="pnl"
              aria-label="กำไรหรือขาดทุน ${safeT}"
              oninput="formatLiveCommaInput(this, true); handleCustomCostPnlInput(this, 'pnl')"
              class="w-full min-w-0 bg-transparent text-xs font-mono font-bold text-right focus:outline-none tabular-nums qf-privacy-input"
            />
          </div>
        </div>
      </div>
    `;
  }).join('');

  updateCustomTotalPortfolioLabel();
}

function handleCustomCostPnlInput(inputEl, field) {
  const ticker = inputEl.getAttribute('data-ticker');
  const rawStr = String(inputEl.value || '').trim();
  const parsedVal = (rawStr === '' || rawStr === '-') ? 0 : parseNumericInput(rawStr);
  const price = getAssetPriceInCurrentCurrency(ticker);

  if (field === 'cost') {
    state.customCost[ticker] = Math.max(0, parsedVal);
  } else {
    state.customPnl[ticker] = parsedVal;
    const wrap = document.getElementById(`custom-pnl-wrap-${ticker}`);
    if (wrap) {
      wrap.classList.remove('text-rose-600', 'border-rose-300', 'bg-rose-50/50', 'text-emerald-700', 'border-emerald-300', 'bg-emerald-50/40', 'text-slate-900', 'border-slate-300', 'bg-slate-50');
      if (parsedVal < -0.005 || rawStr.startsWith('-')) {
        wrap.classList.add('text-rose-600', 'border-rose-300', 'bg-rose-50/50');
      } else if (parsedVal > 0.005) {
        wrap.classList.add('text-emerald-700', 'border-emerald-300', 'bg-emerald-50/40');
      } else {
        wrap.classList.add('text-slate-900', 'border-slate-300', 'bg-slate-50');
      }
    }
  }

  const costVal = Number(state.customCost[ticker]) || 0;
  const pnlVal = Number(state.customPnl[ticker]) || 0;
  const netVal = Math.max(0, Number((costVal + pnlVal).toFixed(2)));
  state.customHoldings[ticker] = netVal;
  state.customShares[ticker] = price > 0 ? Number((netVal / price).toFixed(4)) : 0;

  const subEl = document.getElementById(`custom-sub-${ticker}`);
  if (subEl) {
    subEl.innerHTML = formatCustomAssetNetBadgeHtml(costVal, pnlVal, netVal, price);
  }

  updateCustomTotalPortfolioLabel();
  clearTimeout(state.customInputDebounceTimer);
  state.customInputDebounceTimer = setTimeout(() => {
    renderActiveGoalView();
  }, 90);
}

function handleCustomHoldingInput(inputEl) {
  const ticker = inputEl.getAttribute('data-ticker');
  const rawVal = Math.max(0, parseNumericInput(inputEl.value));
  const price = getAssetPriceInCurrentCurrency(ticker);

  if (state.holdingsInputUnit === 'shares') {
    state.customShares[ticker] = rawVal;
    const netVal = Number((rawVal * price).toFixed(2));
    state.customHoldings[ticker] = netVal;
    state.customCost[ticker] = netVal;
    state.customPnl[ticker] = 0;
  } else {
    state.customHoldings[ticker] = rawVal;
    state.customCost[ticker] = rawVal;
    state.customPnl[ticker] = 0;
    state.customShares[ticker] = price > 0 ? Number((rawVal / price).toFixed(4)) : 0;
  }

  const subEl = document.getElementById(`custom-sub-${ticker}`);
  if (subEl) {
    subEl.innerText = state.holdingsInputUnit === 'shares'
      ? `คิดเป็น ${formatMoney(state.customHoldings[ticker], 2, false)} (@${formatMoney(price, 2, false)})`
      : `ประมาณ ${formatNumberWithCommas(state.customShares[ticker], 4)} หน่วย (@${formatMoney(price, 2, false)})`;
  }

  updateCustomTotalPortfolioLabel();
  clearTimeout(state.customInputDebounceTimer);
  state.customInputDebounceTimer = setTimeout(() => {
    renderActiveGoalView();
  }, 90);
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
  clearTimeout(state.customInputDebounceTimer);
  state.customInputDebounceTimer = setTimeout(() => {
    renderActiveGoalView();
  }, 90);
}

function updateCustomTotalPortfolioLabel() {
  if (!state.optData) return;
  const tickers = state.optData.metadata.tickers || [];
  const sumCost = tickers.reduce((acc, t) => acc + (Number(state.customCost[t] ?? state.customHoldings[t]) || 0), 0);
  const sumPnl = tickers.reduce((acc, t) => acc + (Number(state.customPnl[t]) || 0), 0);
  const sumHoldings = tickers.reduce((acc, t) => acc + (Number(state.customHoldings[t]) || 0), 0);
  const total = Math.max(0, sumHoldings + (Number(state.customCashInjection) || 0));

  const costEl = document.getElementById('custom-total-cost-val');
  if (costEl) {
    costEl.innerText = maskIfPrivate(formatMoney(sumCost, 2, true), true);
  }
  const pnlEl = document.getElementById('custom-total-pnl-val');
  const pnlTile = document.getElementById('custom-total-pnl-tile');
  if (pnlEl) {
    const pctStr = sumCost > 0 ? ` (${sumPnl >= 0 ? '+' : ''}${((sumPnl / sumCost) * 100).toFixed(1)}%)` : '';
    const signStr = sumPnl > 0.005 ? '+' : (sumPnl < -0.005 ? '-' : '');
    const rawPnlText = Math.abs(sumPnl) < 0.005
      ? `${formatMoney(0, 2, true)} (0.0%)`
      : `${signStr}${formatMoney(Math.abs(sumPnl), 2, true)}${pctStr}`;
    pnlEl.innerText = state.balancePrivacyHidden
      ? `${signStr}${state.currencySymbol} ••••••${pctStr}`
      : rawPnlText;
    pnlEl.className = `text-sm sm:text-base font-extrabold font-mono mt-0.5 tabular-nums ${
      sumPnl < -0.005 ? 'text-rose-600' : (sumPnl > 0.005 ? 'text-emerald-700' : 'text-slate-800')
    }`;
    if (pnlTile) {
      pnlTile.classList.remove('is-good', 'is-bad');
      if (sumPnl < -0.005) pnlTile.classList.add('is-bad');
      else if (sumPnl > 0.005) pnlTile.classList.add('is-good');
    }
  }
  const el = document.getElementById('custom-total-portfolio-val');
  if (el) {
    el.innerText = maskIfPrivate(formatMoney(total, 2, true), true);
  }
}

const POPULAR_ASSETS_LS_KEY = 'qf_popular_assets_v2';
const POPULAR_ASSETS_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;
let _popularAssetsFetchPromise = null;
let _popularAssetsFetchedLiveThisSession = false;

const POPULAR_ASSETS_META_STATE = {
  source: 'curated_fallback',
  asOfDate: '',
  updatedAt: '',
  liveCategories: []
};

const STOCK_CATALOG_CATEGORIES = {
  thai_set50: [
    { symbol: 'DELTA.BK', label: 'DELTA (เดลต้า)' },
    { symbol: 'PTT.BK', label: 'PTT (ปตท.)' },
    { symbol: 'ADVANC.BK', label: 'ADVANC (AIS)' },
    { symbol: 'GULF.BK', label: 'GULF (กัลฟ์)' },
    { symbol: 'AOT.BK', label: 'AOT (ทอท.)' },
    { symbol: 'KBANK.BK', label: 'KBANK (กสิกรไทย)' },
    { symbol: 'KTB.BK', label: 'KTB (กรุงไทย)' },
    { symbol: 'PTTEP.BK', label: 'PTTEP (ปตท.สผ.)' },
    { symbol: 'SCB.BK', label: 'SCB (เอสซีบี เอกซ์)' },
    { symbol: 'CPALL.BK', label: 'CPALL (7-Eleven)' },
    { symbol: 'TRUE.BK', label: 'TRUE (ทรู)' },
    { symbol: 'BBL.BK', label: 'BBL (กรุงเทพ)' },
    { symbol: 'BDMS.BK', label: 'BDMS (รพ.กรุงเทพ)' },
    { symbol: 'CPN.BK', label: 'CPN (เซ็นทรัลพัฒนา)' },
    { symbol: 'SCC.BK', label: 'SCC (ปูนซิเมนต์ไทย)' },
    { symbol: 'BH.BK', label: 'BH (รพ.บำรุงราษฎร์)' },
    { symbol: 'MINT.BK', label: 'MINT (ไมเนอร์)' },
    { symbol: 'TISCO.BK', label: 'TISCO (ทิสโก้)' }
  ],
  us_equities: [
    { symbol: 'AAPL', label: 'AAPL (Apple)' },
    { symbol: 'MSFT', label: 'MSFT (Microsoft)' },
    { symbol: 'NVDA', label: 'NVDA (NVIDIA)' },
    { symbol: 'GOOGL', label: 'GOOGL (Alphabet)' },
    { symbol: 'AMZN', label: 'AMZN (Amazon)' },
    { symbol: 'META', label: 'META (Meta)' },
    { symbol: 'TSLA', label: 'TSLA (Tesla)' },
    { symbol: 'AVGO', label: 'AVGO (Broadcom)' },
    { symbol: 'BRK-B', label: 'BRK-B (Berkshire)' },
    { symbol: 'LLY', label: 'LLY (Eli Lilly)' },
    { symbol: 'WMT', label: 'WMT (Walmart)' },
    { symbol: 'JPM', label: 'JPM (JPMorgan)' },
    { symbol: 'V', label: 'V (Visa)' },
    { symbol: 'MA', label: 'MA (Mastercard)' },
    { symbol: 'COST', label: 'COST (Costco)' },
    { symbol: 'AMD', label: 'AMD' },
    { symbol: 'NFLX', label: 'NFLX (Netflix)' },
    { symbol: 'KO', label: 'KO (Coca-Cola)' }
  ],
  etf_gold_bonds: [
    { symbol: 'SPY', label: 'SPY (S&P 500 ETF)' },
    { symbol: 'QQQ', label: 'QQQ (Nasdaq 100 ETF)' },
    { symbol: 'VOO', label: 'VOO (Vanguard S&P 500)' },
    { symbol: 'VTI', label: 'VTI (US Total Stock)' },
    { symbol: 'GLD', label: 'GLD (ทองคำโลก ETF)' },
    { symbol: 'SLV', label: 'SLV (แร่เงิน ETF)' },
    { symbol: 'TLT', label: 'TLT (พันธบัตรสหรัฐฯ 20 ปี+)' },
    { symbol: 'BND', label: 'BND (ตราสารหนี้รวมสหรัฐฯ)' },
    { symbol: 'VNQ', label: 'VNQ (อสังหาฯ สหรัฐฯ REIT)' },
    { symbol: 'DBC', label: 'DBC (สินค้าโภคภัณฑ์รวม)' }
  ],
  crypto: [
    { symbol: 'BTC-USD', label: 'BTC-USD (Bitcoin)' },
    { symbol: 'ETH-USD', label: 'ETH-USD (Ethereum)' },
    { symbol: 'BNB-USD', label: 'BNB-USD (BNB)' },
    { symbol: 'XRP-USD', label: 'XRP-USD (XRP)' },
    { symbol: 'SOL-USD', label: 'SOL-USD (Solana)' },
    { symbol: 'ADA-USD', label: 'ADA-USD (Cardano)' }
  ]
};

function formatThaiShortDateFromIso(dateStr) {
  const m = String(dateStr || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const thaiMonths = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  const yearBe = Number(m[1]) + 543;
  const monthIdx = Number(m[2]) - 1;
  const day = Number(m[3]);
  if (monthIdx < 0 || monthIdx > 11) return '';
  return `${day} ${thaiMonths[monthIdx]} ${yearBe}`;
}

function syncDynamicPresetSubtitles() {
  const thSub = document.getElementById('preset-sub-thai_set50');
  if (thSub && Array.isArray(PRESETS.thai_set50?.tickers) && PRESETS.thai_set50.tickers.length > 0) {
    thSub.innerText = PRESETS.thai_set50.tickers
      .slice(0, 5)
      .map(s => String(s).replace(/\.BK$/i, ''))
      .join(', ');
  }
  const usSub = document.getElementById('preset-sub-tech_titans');
  if (usSub && Array.isArray(PRESETS.tech_titans?.tickers) && PRESETS.tech_titans.tickers.length > 0) {
    const syms = PRESETS.tech_titans.tickers.slice(0, 5).join(', ');
    usSub.innerText = PRESETS.tech_titans.tickers.length > 5 ? `${syms}...` : syms;
  }
}

function updatePopularAssetsMetaCaption() {
  const metaEl = document.getElementById('popular-assets-meta');
  if (!metaEl) return;
  const activeCat = state.activeCatalogCategory || 'thai_set50';
  if (activeCat === 'etf_gold_bonds') {
    metaEl.innerHTML = '<span>คัดสรรครบทุกกลุ่มสินทรัพย์หลัก (ETF หุ้น / ทองคำ / พันธบัตร / REIT)</span>';
    return;
  }
  const isLiveCat = Array.isArray(POPULAR_ASSETS_META_STATE.liveCategories)
    && POPULAR_ASSETS_META_STATE.liveCategories.includes(activeCat);
  const thaiDate = formatThaiShortDateFromIso(POPULAR_ASSETS_META_STATE.asOfDate);
  if (isLiveCat && thaiDate) {
    metaEl.innerHTML = `<span>จัดอันดับอัตโนมัติตามมูลค่าตลาด (Top Market Cap) • อัปเดต ${escapeHtmlText(thaiDate)}</span>`;
  } else {
    metaEl.innerHTML = '<span>จัดอันดับตามมูลค่าตลาด (Top Market Cap) • รายการมาตรฐาน</span>';
  }
}

function applyPopularAssetsPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const cats = payload.categories;
  if (cats && typeof cats === 'object') {
    ['thai_set50', 'us_equities', 'etf_gold_bonds', 'crypto'].forEach(catKey => {
      const list = cats[catKey];
      if (Array.isArray(list) && list.length >= 3) {
        const cleaned = list
          .filter(it => it && typeof it.symbol === 'string' && it.symbol.trim())
          .map(it => ({
            symbol: String(it.symbol).trim().toUpperCase(),
            label: String(it.label || it.symbol).trim()
          }));
        if (cleaned.length >= 3) {
          STOCK_CATALOG_CATEGORIES[catKey] = cleaned;
        }
      }
    });
  }

  const dynPresets = payload.presets;
  if (dynPresets && typeof dynPresets === 'object') {
    if (Array.isArray(dynPresets.thai_set50) && dynPresets.thai_set50.length >= 3) {
      PRESETS.thai_set50.tickers = dynPresets.thai_set50.map(s => String(s).trim().toUpperCase()).filter(Boolean);
    }
    if (Array.isArray(dynPresets.tech_titans) && dynPresets.tech_titans.length >= 3) {
      PRESETS.tech_titans.tickers = dynPresets.tech_titans.map(s => String(s).trim().toUpperCase()).filter(Boolean);
    }
  }

  POPULAR_ASSETS_META_STATE.source = String(payload.source || 'curated_fallback');
  POPULAR_ASSETS_META_STATE.asOfDate = String(payload.as_of_date || '');
  POPULAR_ASSETS_META_STATE.updatedAt = String(payload.updated_at || '');
  POPULAR_ASSETS_META_STATE.liveCategories = Array.isArray(payload.live_categories) ? payload.live_categories : [];

  syncDynamicPresetSubtitles();
  renderQuickStockCatalog();
  return true;
}

function hydratePopularAssetsFromCache() {
  try {
    localStorage.removeItem('qf_popular_assets_v1');
    const raw = localStorage.getItem(POPULAR_ASSETS_LS_KEY);
    if (!raw) {
      syncDynamicPresetSubtitles();
      return false;
    }
    const parsed = JSON.parse(raw);
    const savedAt = Number(parsed?.savedAt || 0);
    if (parsed?.payload && savedAt > 0 && (Date.now() - savedAt) < POPULAR_ASSETS_CLIENT_TTL_MS) {
      applyPopularAssetsPayload(parsed.payload);
      return true;
    }
  } catch (e) {}
  syncDynamicPresetSubtitles();
  return false;
}

async function fetchDynamicPopularAssets(forceRefresh = false) {
  if (!forceRefresh && _popularAssetsFetchedLiveThisSession) return;
  if (_popularAssetsFetchPromise) return _popularAssetsFetchPromise;

  // Skip network call if fresh 24h client cache already exists and not forced
  if (!forceRefresh) {
    try {
      const raw = localStorage.getItem(POPULAR_ASSETS_LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const savedAt = Number(parsed?.savedAt || 0);
        if (parsed?.payload && savedAt > 0 && (Date.now() - savedAt) < POPULAR_ASSETS_CLIENT_TTL_MS) {
          const hasLive = Array.isArray(parsed.payload.live_categories) && parsed.payload.live_categories.length > 0;
          if (hasLive) {
            _popularAssetsFetchedLiveThisSession = true;
            return;
          }
        }
      }
    } catch (e) {}
  }

  _popularAssetsFetchPromise = (async () => {
    try {
      const url = forceRefresh ? '/api/popular-assets?refresh=true' : '/api/popular-assets';
      const res = await fetch(url, { cache: 'default' });
      if (!res.ok) return;
      const payload = await res.json();
      if (applyPopularAssetsPayload(payload)) {
        _popularAssetsFetchedLiveThisSession = true;
        try {
          localStorage.setItem(POPULAR_ASSETS_LS_KEY, JSON.stringify({
            savedAt: Date.now(),
            payload
          }));
        } catch (e) {}
      }
    } catch (e) {
      // Silent graceful fallback to built-in institutional catalog
    } finally {
      _popularAssetsFetchPromise = null;
    }
  })();

  return _popularAssetsFetchPromise;
}

function selectStockCatalogCategory(catKey = 'thai_set50') {
  const validCats = Object.keys(STOCK_CATALOG_CATEGORIES);
  const nextCat = validCats.includes(catKey) ? catKey : 'thai_set50';
  state.activeCatalogCategory = nextCat;

  validCats.forEach(k => {
    const tabBtn = document.getElementById(`stock-cat-tab-${k}`);
    if (tabBtn) {
      tabBtn.className = k === nextCat
        ? 'qf-seg-btn qf-seg-active px-2.5 py-1 rounded-md font-semibold transition cursor-pointer'
        : 'qf-seg-btn qf-seg-inactive px-2.5 py-1 rounded-md font-medium transition cursor-pointer';
    }
  });
  renderQuickStockCatalog();
}

function toggleCatalogTicker(symbol) {
  const clean = String(symbol || '').trim().toUpperCase();
  if (!clean) return;
  if (state.tickers.includes(clean)) {
    removeTicker(clean);
  } else {
    addTicker(clean);
  }
}

function renderQuickStockCatalog() {
  const chipsContainer = document.getElementById('quick-stock-catalog-chips');
  if (!chipsContainer) return;
  const activeCat = state.activeCatalogCategory || 'thai_set50';
  const items = STOCK_CATALOG_CATEGORIES[activeCat] || STOCK_CATALOG_CATEGORIES.thai_set50;

  chipsContainer.innerHTML = items.map(item => {
    const isSelected = state.tickers.includes(item.symbol);
    const safeSym = escapeHtmlText(item.symbol);
    const safeLbl = escapeHtmlText(item.label);
    return `
      <button
        type="button"
        data-symbol="${safeSym}"
        onclick="toggleCatalogTicker(this.dataset.symbol)"
        title="${isSelected ? 'คลิกเพื่อนำออกจากพอร์ต' : 'คลิกเพื่อเพิ่มเข้าพอร์ต'}"
        class="px-2.5 py-1 rounded-xl text-xs font-medium transition cursor-pointer inline-flex items-center gap-1.5 ${
          isSelected
            ? 'bg-[#E6FBF3] text-[#008A57] border border-[#00D084] font-bold shadow-2xs'
            : 'bg-white hover:bg-slate-100 text-slate-700 border border-slate-200/90'
        }"
      >
        <span class="font-mono font-bold">${isSelected ? '✓' : '+'}</span>
        <span>${safeLbl}</span>
      </button>
    `;
  }).join('');
  updatePopularAssetsMetaCaption();
}

// Selected Tickers List in Left Sidebar (Shows both THB and USD prices clearly)
function renderTickersList() {
  const container = document.getElementById('selected-tickers-container');
  document.getElementById('asset-count').innerText = state.tickers.length;
  renderQuickStockCatalog();
  updateSetupReadinessUI();

  if (state.tickers.length === 0) {
    container.innerHTML = `
      <div class="p-6 text-center text-sm text-slate-700 font-medium space-y-1">
        <div>ยังไม่มีสินทรัพย์ในพอร์ต</div>
        <div class="text-xs text-slate-600">ค้นหาชื่อสินทรัพย์ด้านบน หรือเปิดเลือกจากสินทรัพย์ยอดนิยมอย่างน้อย 2 ตัว</div>
      </div>
    `;
    return;
  }

  const fx = state.fxRate > 0 ? state.fxRate : 34.50;

  container.innerHTML = state.tickers.map((ticker, idx) => {
    const q = state.tickerQuotes[ticker] || {};
    const name = q.name || ticker;
    const isThai = ticker.endsWith('.BK');
    const hasPrice = q.price !== undefined && q.price !== null && !Number.isNaN(Number(q.price));
    let priceHtml = '';

    if (hasPrice) {
      const natCurr = q.currency || (isThai ? 'THB' : 'USD');
      const pThb = convertNativePrice(q.price, natCurr, 'THB', fx);
      const pUsd = convertNativePrice(q.price, natCurr, 'USD', fx);
      const thbStr = `฿${pThb.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const usdStr = `$${pUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const primaryPrice = state.currency === 'THB' ? thbStr : usdStr;
      const secondaryPrice = state.currency === 'THB' ? usdStr : thbStr;
      priceHtml = `
        <div class="font-mono text-sm sm:text-base font-bold text-slate-900 tracking-tight tabular-nums whitespace-nowrap">${primaryPrice}</div>
        <div class="font-mono text-[11px] sm:text-xs text-slate-600 mt-0.5 tabular-nums whitespace-nowrap">${secondaryPrice}</div>
      `;
    } else if (state.quotesError && !state.quotesLoading) {
      priceHtml = `
        <button type="button" onclick="fetchLiveQuotesForTickers()" class="text-[11px] font-semibold text-amber-700 hover:underline whitespace-nowrap cursor-pointer">
          ดึงราคาใหม่ ↻
        </button>
      `;
    } else {
      priceHtml = `
        <div class="flex flex-col items-end gap-1.5" aria-label="กำลังดึงราคา">
          <div class="qf-inline-shimmer h-4 w-20 sm:w-24"></div>
          <div class="qf-inline-shimmer h-3 w-14 sm:w-16"></div>
        </div>
      `;
    }

    const isUp = (q.change_pct || 0) >= 0;
    const chgColor = isUp ? 'text-emerald-700 bg-emerald-50/80 border-emerald-200/80' : 'text-rose-700 bg-rose-50/80 border-rose-200/80';
    const chgSign = isUp ? '+' : '';
    const chgBadge = q.change_pct !== undefined
      ? `<span class="text-[10px] sm:text-[11px] font-mono font-semibold px-1.5 py-0.5 rounded border whitespace-nowrap shrink-0 tabular-nums ${chgColor}">${chgSign}${q.change_pct.toFixed(2)}%</span>`
      : '';

    const safeTicker = escapeHtmlText(ticker);
    const safeName = escapeHtmlText(name !== ticker ? name : (isThai ? 'หุ้นไทย (SET)' : 'Global Asset'));
    const avatarBg = ASSET_COLORS[idx % ASSET_COLORS.length];
    return `
      <div class="px-3 sm:px-4 py-2.5 flex items-center justify-between gap-2 sm:gap-3 hover:bg-slate-50/90 transition">
        <div class="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
          ${renderStockLogoBadge(ticker, avatarBg, 32)}
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5 flex-nowrap">
              <span class="font-bold text-[13px] sm:text-sm font-mono text-slate-900 tracking-tight whitespace-nowrap shrink-0">${safeTicker}</span>
              ${chgBadge}
            </div>
            <div class="text-[11.5px] sm:text-xs text-slate-500 truncate mt-0.5">${safeName}</div>
          </div>
        </div>
        <div class="flex items-center gap-1.5 sm:gap-2 shrink-0">
          <div class="text-right leading-tight tabular-nums">
            ${priceHtml}
          </div>
          <button data-ticker="${safeTicker}" onclick="removeTicker(this.dataset.ticker)" title="ลบออก" aria-label="ลบ ${safeTicker} ออกจากพอร์ต" class="text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-md p-1.5 transition cursor-pointer shrink-0">
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
  const reqTickers = [...state.tickers];
  state.quotesLoading = true;
  state.quotesError = false;
  renderTickersList();
  try {
    const res = await fetch(`/api/quote?tickers=${encodeURIComponent(reqTickers.join(','))}`);
    if (res.ok) {
      const data = await res.json();
      if (data.usd_thb_rate && !state.fxIsManual) {
        state.fxRate = Number(data.usd_thb_rate);
        state.isFallbackFx = !!data.is_fallback_fx;
        const fxInput = document.getElementById('fx-rate-input');
        if (fxInput) fxInput.value = state.fxRate.toFixed(2);
        const topFx = document.getElementById('top-fx-rate');
        if (topFx) {
          topFx.innerText = data.is_fallback_fx
            ? `${state.fxRate.toFixed(2)} บาท/$ (สำรอง)`
            : `${state.fxRate.toFixed(2)} บาท/$`;
        }
      }
      if (data.quotes) {
        state.tickerQuotes = { ...state.tickerQuotes, ...data.quotes };
      }
      state.quotesLoading = false;
      state.quotesError = false;
      renderTickersList();
      updateMarketDataStatusPill();
    } else {
      state.quotesLoading = false;
      state.quotesError = true;
      renderTickersList();
    }
  } catch (e) {
    console.warn('Live quotes warning:', e);
    state.quotesLoading = false;
    state.quotesError = true;
    renderTickersList();
  }
}

function resetPortfolioNameOnTickerMutation() {
  // Preserve name & editing context ONLY when user explicitly clicked "แก้ไขพอร์ตเดิม" from Cloud Vault.
  if (typeof window !== 'undefined' && typeof window.isExplicitPortfolioEditing === 'function' && window.isExplicitPortfolioEditing()) {
    return;
  }
  if (typeof cancelEditingSavedPortfolio === 'function') {
    cancelEditingSavedPortfolio();
  }
  const saveNameEl = document.getElementById('save-portfolio-name');
  if (saveNameEl) saveNameEl.value = '';
}

function addTicker(symbol) {
  const clean = symbol.trim().toUpperCase();
  if (!clean) return;
  if (!state.tickers.includes(clean)) {
    const tierInfo = getActiveUserTierInfo();
    const maxAssets = Number(tierInfo.maxAssets || 5);
    if (state.tickers.length >= maxAssets) {
      hideSearchDropdown();
      if (tierInfo.planTier === 'guest') {
        if (typeof window.openProUpgradeModal === 'function') {
          window.openProUpgradeModal(
            `คุณเลือกสินทรัพย์ครบ ${maxAssets} ตัวแล้ว (เพดานโหมด Guest) — สมัครสมาชิกฟรีเพื่อเพิ่มเป็น 8 ตัว หรืออัปเกรดเป็น QuantFolio Pro (15 ตัว) / Advisor Pro (25 ตัว)`,
            'pro'
          );
        }
      } else if (tierInfo.planTier === 'free') {
        if (typeof window.openProUpgradeModal === 'function') {
          window.openProUpgradeModal(
            `คุณเลือกสินทรัพย์ครบ ${maxAssets} ตัวแล้ว (เพดานบัญชี Member ฟรี) — อัปเกรดเป็น QuantFolio Pro (15 ตัว) หรือ Advisor Pro (25 ตัว) ต่อพอร์ต`,
            'pro'
          );
        }
      } else if (tierInfo.planTier === 'pro') {
        if (typeof window.openProUpgradeModal === 'function') {
          window.openProUpgradeModal(
            `คุณเลือกสินทรัพย์ครบ ${maxAssets} ตัวแล้ว (เพดาน QuantFolio Pro) — อัปเกรดเป็น Advisor Pro เพื่อจัดพอร์ตขนาดใหญ่ได้สูงสุด 25 สินทรัพย์ พร้อมรายงาน PDF โหมด IC / IP White-label`,
            'advisor'
          );
        }
      } else {
        showPortfolioToastApp(`พอร์ตนี้มีสินทรัพย์ครบเพดานสูงสุด ${maxAssets} ตัวแล้ว`);
      }
      return;
    }
    state.tickers.push(clean);
    resetPortfolioNameOnTickerMutation();
    renderTickersList();
    updateMaxWeightLabel(document.getElementById('max-weight-slider')?.value || 100);
    markResultsStale(`เพิ่มสินทรัพย์ ${clean}`);
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
  resetPortfolioNameOnTickerMutation();
  renderTickersList();
  updateMaxWeightLabel(document.getElementById('max-weight-slider')?.value || 100);
  markResultsStale(`ลบสินทรัพย์ ${symbol}`);
}

function clearAllTickers() {
  state.tickers = [];
  if (typeof cancelEditingSavedPortfolio === 'function') {
    cancelEditingSavedPortfolio();
  }
  const saveNameEl = document.getElementById('save-portfolio-name');
  if (saveNameEl) saveNameEl.value = '';
  dismissDroppedTickersBanner();
  renderTickersList();
  updateMaxWeightLabel(document.getElementById('max-weight-slider')?.value || 100);
  markResultsStale('ล้างรายการสินทรัพย์ทั้งหมด');
}

// Search & Autocomplete (with instant loading feedback & race-condition protection)
function handleSearchInput(e) {
  const query = e.target.value.trim();
  clearTimeout(state.searchDebounceTimer);

  if (!query) {
    hideSearchDropdown();
    return;
  }

  const dd = document.getElementById('search-dropdown');
  if (dd) {
    dd.innerHTML = `
      <div class="px-3.5 py-3 flex items-center justify-center gap-2 text-xs text-slate-500">
        <span class="w-3.5 h-3.5 rounded-full border-2 border-slate-300 border-t-[#00D084] animate-spin inline-block"></span>
        <span>กำลังค้นหา "${escapeHtmlText(query)}"...</span>
      </div>
    `;
    dd.classList.remove('hidden');
  }

  const reqSeq = ++state.searchRequestId;
  state.searchDebounceTimer = setTimeout(async () => {
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      if (reqSeq !== state.searchRequestId) return;
      if (res.ok) {
        const data = await res.json();
        renderSearchDropdown(data.results || []);
      } else {
        renderSearchDropdown([]);
      }
    } catch (err) {
      if (reqSeq !== state.searchRequestId) return;
      console.warn('Search error:', err);
      renderSearchDropdown([]);
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
  if (state.appView !== 'workspace') {
    setAppView('workspace', false);
  }
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
  const reqId = ++state.optRequestId;
  const useCenteredOverlay = Boolean(shouldSwitchTab || !state.optData);
  setResultStatus('loading');
  showLoading(true, useCenteredOverlay);

  try {
    const tierInfo = getActiveUserTierInfo();
    let cleanedBlViews = null;
    if (tierInfo.canCustomizeBlViews && state.blViews && typeof state.blViews === 'object') {
      cleanedBlViews = {};
      state.tickers.forEach(t => {
        const val = Number(state.blViews[t]);
        cleanedBlViews[t] = Number.isFinite(val) ? Math.max(-0.25, Math.min(0.25, val)) : 0.0;
      });
    }

    const rawConf = Number.isFinite(state.blConfidence) ? Math.max(0, Math.min(1, state.blConfidence)) : 0.50;
    const effectiveConf = tierInfo.canCustomizeBlViews
      ? rawConf
      : Math.min(rawConf, Number(tierInfo.safeBlConfidenceCap || 0.35));

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
      use_news_adjustment: Boolean(tierInfo.canViewNews && state.useNewsAdjustment),
      bl_confidence: effectiveConf,
      bl_views: cleanedBlViews
    };

    const authHeaders = typeof window.getBackendAuthHeaders === 'function' ? window.getBackendAuthHeaders() : {};
    const res = await fetch('/api/optimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (reqId !== state.optRequestId) {
      // A newer optimization request (e.g. rapid THB <-> USD switch) superseded this one
      return;
    }
    if (!res.ok) {
      if (res.status === 403 && typeof window.openProUpgradeModal === 'function') {
        window.openProUpgradeModal(data.detail || 'เกินสิทธิ์ของแพ็กเกจปัจจุบัน กรุณาอัปเกรดเป็น QuantFolio Pro', 'pro');
      }
      // P0-2 Edge Case: Backend returns HTTP 400 when < 2 valid tickers remain after dropping invalid tickers
      const rawDetail = String(data.detail || '');
      if (res.status === 400 && rawDetail.includes('ไม่พบข้อมูล:')) {
        const parsePyList = (label) => {
          const m = rawDetail.match(new RegExp(`${label}:\\s*\\[([^\\]]*)\\]`));
          if (!m || !m[1]) return [];
          return m[1]
            .split(',')
            .map(s => s.replace(/['"\s]/g, '').trim().toUpperCase())
            .filter(Boolean);
        };
        const foundList = parsePyList('พบข้อมูล');
        const missingList = parsePyList('ไม่พบข้อมูล');
        if (missingList.length > 0) {
          const missSet = new Set(missingList);
          state.tickers = state.tickers.filter(t => !missSet.has(String(t || '').trim().toUpperCase()));
          missingList.forEach(dt => {
            delete state.customHoldings[dt];
            delete state.customCost[dt];
            delete state.customPnl[dt];
            delete state.customShares[dt];
            if (state.blViews && typeof state.blViews === 'object') {
              delete state.blViews[dt];
            }
          });
          renderTickersList();
          updateMaxWeightLabel(document.getElementById('max-weight-slider')?.value || 100);
          updateSetupReadinessUI();
          showDroppedTickersBanner(missingList, state.tickers.length);
          const needMore = Math.max(1, 2 - state.tickers.length);
          const friendlyMsg = `ไม่พบข้อมูลตลาดสำหรับ ${missingList.join(', ')} ระบบจึงตัดออกจากรายการแล้ว — ตอนนี้เหลือสินทรัพย์ที่มีข้อมูล ${state.tickers.length} รายการ กรุณาเพิ่มสินทรัพย์ที่ถูกต้องอีกอย่างน้อย ${needMore} ตัว (หากเป็นหุ้นไทยกรุณาเติม .BK เช่น PTT.BK)`;
          showPortfolioToastApp(friendlyMsg);
          throw new Error(friendlyMsg);
        }
      }
      throw new Error(data.detail || 'ไม่สามารถคำนวณข้อมูลพอร์ตได้ กรุณาตรวจสอบช่วงเวลาและชื่อหุ้น');
    }

    state.optData = data;
    state.budget = Number(data.metadata?.budget || budget);
    if (data.metadata && data.metadata.usd_thb_rate && !state.fxIsManual) {
      state.fxRate = Number(data.metadata.usd_thb_rate);
    }

    // Fill any still-missing ticker quotes cleanly from optimization asset_stats so Tab 1 never stalls
    if (Array.isArray(data.asset_stats)) {
      data.asset_stats.forEach(s => {
        if (s && s.ticker && (!state.tickerQuotes[s.ticker] || state.tickerQuotes[s.ticker].price === undefined)) {
          state.tickerQuotes[s.ticker] = {
            symbol: s.ticker,
            name: s.name || s.ticker,
            price: s.native_price,
            price_thb: s.price_thb,
            price_usd: s.price_usd,
            currency: s.native_currency,
            as_of_date: s.latest_price_date
          };
        }
      });
    }

    // P0-2: Sync state.tickers cleanly with validTickers & warn clearly when invalid tickers were dropped
    // Check backend metadata.dropped_tickers, metadata.missing_tickers, AND diff vs requested payload
    const validTickers = Array.isArray(data.metadata?.tickers) ? data.metadata.tickers : [];
    const validSet = new Set(validTickers.map(t => String(t || '').trim().toUpperCase()));
    const rawMissing = [
      ...(Array.isArray(data.metadata?.dropped_tickers) ? data.metadata.dropped_tickers : []),
      ...(Array.isArray(data.metadata?.missing_tickers) ? data.metadata.missing_tickers : []),
      ...(Array.isArray(payload?.tickers) ? payload.tickers.filter(t => !validSet.has(String(t || '').trim().toUpperCase())) : [])
    ];
    const droppedTickers = [...new Set(rawMissing.map(t => String(t || '').trim().toUpperCase()).filter(Boolean))];
    if (droppedTickers.length > 0) {
      state.tickers = [...validTickers];
      droppedTickers.forEach(dt => {
        delete state.customHoldings[dt];
        delete state.customCost[dt];
        delete state.customPnl[dt];
        delete state.customShares[dt];
        if (state.blViews && typeof state.blViews === 'object') {
          delete state.blViews[dt];
        }
      });
      renderTickersList();
      updateMaxWeightLabel(document.getElementById('max-weight-slider')?.value || 100);
      showDroppedTickersBanner(droppedTickers, validTickers.length);
      if (validTickers.length < 2) {
        updateSetupReadinessUI();
        const needMore = Math.max(1, 2 - validTickers.length);
        const underMinMsg = `ไม่พบข้อมูลตลาดสำหรับ ${droppedTickers.join(', ')} ระบบจึงตัดออก — เหลือสินทรัพย์เพียง ${validTickers.length} ตัว กรุณาเพิ่มสินทรัพย์ที่ถูกต้องอีกอย่างน้อย ${needMore} ตัว (หากเป็นหุ้นไทยกรุณาเติม .BK)`;
        showPortfolioToastApp(underMinMsg);
        throw new Error(underMinMsg);
      }
      showPortfolioToastApp(`ไม่พบข้อมูลตลาดสำหรับ ${droppedTickers.join(', ')} ระบบจึงตัดออกจากการคำนวณ — หากเป็นหุ้นไทยกรุณาเติม .BK`);
    } else {
      dismissDroppedTickersBanner();
    }

    // Reset custom holdings for current tickers cleanly
    const perAsset = Math.round((budget / Math.max(1, validTickers.length)) * 100) / 100;
    validTickers.forEach(t => {
      if (state.customHoldings[t] === undefined) {
        state.customHoldings[t] = perAsset;
      }
      if (state.customCost[t] === undefined) {
        state.customCost[t] = state.customHoldings[t];
      }
      if (state.customPnl[t] === undefined) {
        state.customPnl[t] = 0;
      }
      const p = getAssetPriceInCurrentCurrency(t);
      state.customShares[t] = p > 0 ? Number((state.customHoldings[t] / p).toFixed(4)) : 0;
    });

    state.executedOrders = {};
    setResultStatus('ready');
    renderAllViews();
    updateSetupReadinessUI();
    if (shouldSwitchTab) {
      jumpToActivePrimaryModeResult();
    }
  } catch (err) {
    if (reqId !== state.optRequestId) return;
    setResultStatus('error', err.message);
    showError(err.message);
  } finally {
    if (reqId === state.optRequestId) {
      showLoading(false);
    }
  }
}

function renderAllViews() {
  const data = state.optData;
  if (!data) {
    renderTabStateBanners();
    return;
  }

  const resDash = document.getElementById('results-dashboard');
  if (resDash) resDash.classList.remove('hidden');

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
  if (rfEl) {
    rfEl.innerText = data.metadata.is_fallback_rf ? `${rfPctStr} (สำรอง)` : rfPctStr;
    const rfMetaParts = [data.metadata.risk_free_source, data.metadata.risk_free_tenor, data.metadata.risk_free_date ? `ณ ${data.metadata.risk_free_date}` : null].filter(Boolean);
    rfEl.title = rfMetaParts.join(' • ');
  }
  const topFxEl = document.getElementById('top-fx-rate');
  if (topFxEl && data.metadata.usd_thb_rate) {
    const fxVal = state.fxIsManual ? state.fxRate : Number(data.metadata.usd_thb_rate);
    const fxStr = `${fxVal.toFixed(2)} บาท/$`;
    topFxEl.innerText = state.fxIsManual ? `${fxStr} (กำหนดเอง)` : (data.metadata.is_fallback_fx ? `${fxStr} (สำรอง)` : fxStr);
  }
  const periodBadge = document.getElementById('analysis-period-badge');
  if (periodBadge) {
    const annDays = data.metadata.effective_annual_days || 252;
    const sDate = new Date(data.metadata.start_date);
    const eDate = new Date(data.metadata.end_date);
    const diffYears = (!isNaN(sDate) && !isNaN(eDate)) ? ((eDate - sDate) / (1000 * 60 * 60 * 24 * 365.25)) : 0;
    const spanLabel = diffYears >= 0.9
      ? `(${Math.round(diffYears * 10) / 10} ปี)`
      : `(${data.metadata.trading_days} วันข้อมูล)`;
    periodBadge.innerText = `ข้อมูลย้อนหลัง ${data.metadata.start_date} – ${data.metadata.end_date} ${spanLabel}`;
    periodBadge.title = `ชุดข้อมูลจริง ${data.metadata.trading_days} วันข้อมูล | ฐานปรับรายปี ${annDays} วัน`;
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
  renderTabStateBanners();
  updateMarketDataStatusPill();

  if (window.lucide) {
    lucide.createIcons();
  }
}

/**
 * CORE PRUDENT REBALANCE ENGINE
 * คำนวณยอดสั่งขาย (บาท) และยอดสั่งซื้อ (บาท) พร้อมจับคู่เม็ดเงิน (ขาย A กี่บาท -> ไปซื้อ B กี่บาท)
 */
function setOrderExecutionUnitMode(mode) {
  const nextMode = mode === 'whole' ? 'whole' : 'fractional';
  if (state.executionUnitMode !== nextMode) {
    state.executedOrders = {};
  }
  state.executionUnitMode = nextMode;
  const btnFrac = document.getElementById('order-unit-mode-fractional');
  const btnWhole = document.getElementById('order-unit-mode-whole');
  const activeCls = 'qf-seg-btn qf-seg-active px-2.5 py-1.5 rounded-lg font-semibold transition cursor-pointer';
  const inactiveCls = 'qf-seg-btn qf-seg-inactive px-2.5 py-1.5 rounded-lg font-medium transition cursor-pointer';
  if (btnFrac) btnFrac.className = state.executionUnitMode === 'fractional' ? activeCls : inactiveCls;
  if (btnWhole) btnWhole.className = state.executionUnitMode === 'whole' ? activeCls : inactiveCls;
  if (state.optData) renderActiveGoalView();
}

function handleCommissionRateChange() {
  const inp = document.getElementById('commission-rate-input');
  let val = inp ? parseFloat(inp.value) : 0.15;
  if (!Number.isFinite(val) || val < 0) val = 0;
  if (val > 5) val = 5;
  state.commissionPct = val;
  if (state.optData) renderActiveGoalView();
}

function computeRebalancePlan(strat, data) {
  const tickers = data.metadata.tickers || [];
  const baseBudget = Number(data.metadata.budget) || 100000;
  const feeBufferOn = document.getElementById('fee-buffer-toggle')?.checked ?? true;
  const commInp = document.getElementById('commission-rate-input');
  const parsedComm = commInp !== null && commInp.value !== '' ? parseFloat(commInp.value) : Number(state.commissionPct ?? 0.15);
  const commissionPct = (Number.isFinite(parsedComm) && parsedComm >= 0 && parsedComm <= 5) ? parsedComm : 0.15;
  state.commissionPct = commissionPct;
  const minThreshold = parseFloat(document.getElementById('min-trade-threshold')?.value || '100');
  const FEE_RATE = feeBufferOn ? (commissionPct / 100.0) : 0.0;
  const executionUnitMode = state.executionUnitMode === 'whole' ? 'whole' : 'fractional';

  // 1. Determine current holdings per ticker & total portfolio value
  const currentMap = {};
  let cashInjection = 0;
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

  // Price map in user's selected currency using single FX source
  const priceMap = {};
  const statMap = {};
  const fx = state.fxRate > 0 ? state.fxRate : 34.50;
  (data.asset_stats || []).forEach(s => {
    statMap[s.ticker] = s;
    const natCurr = s.native_currency || (s.ticker.endsWith('.BK') ? 'THB' : 'USD');
    priceMap[s.ticker] = convertNativePrice(s.native_price, natCurr, state.currency, fx);
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
    const p = item.price > 0 ? item.price : 0;
    if (effectiveMode !== 'cash' && absDelta < minThreshold) {
      item.action = 'HOLD';
      item.trade_amount = 0;
      item.final_value = item.current_value;
      holdOrders.push(item);
    } else if (item.raw_delta < 0 && effectiveMode !== 'cash') {
      let sellAmt = Number(Math.min(item.current_value, Math.abs(item.raw_delta)).toFixed(2));
      if (executionUnitMode === 'whole' && p > 0) {
        const wholeSell = Math.min(Math.floor((item.current_value + 1e-9) / p), Math.floor((sellAmt + 1e-9) / p));
        sellAmt = Number((wholeSell * p).toFixed(2));
      }
      if (sellAmt < Math.max(1, minThreshold)) {
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

  // Reserve brokerage commission buffer cleanly (accounting for both SELL leg and BUY leg when rebalancing)
  const sellFeeReserve = Number((totalSellGross * FEE_RATE).toFixed(2));
  const cashAfterSellFee = Math.max(0, totalSellGross - sellFeeReserve + cashInjection);
  const buyFeeReserve = Number((cashAfterSellFee * FEE_RATE).toFixed(2));
  const feeReserve = Number((sellFeeReserve + buyFeeReserve).toFixed(2));
  const netSpendableForBuys = Number(Math.max(0, rawCashAvailable - feeReserve).toFixed(2));

  const totalRawBuyNeed = buyCandidates.reduce((acc, b) => acc + b.raw_buy_need, 0);
  const buyOrders = [];

  // Pass 1: Initial proportional / integer floor allocation
  const candidateBuyAmts = new Map();
  buyCandidates.forEach(b => {
    let buyAmt = 0;
    const p = b.price > 0 ? b.price : 0;
    if (totalRawBuyNeed > 0 && netSpendableForBuys > 0) {
      const scale = Math.min(1.0, netSpendableForBuys / totalRawBuyNeed);
      buyAmt = Number((b.raw_buy_need * scale).toFixed(2));
      if (executionUnitMode === 'whole' && p > 0) {
        const wholeBuy = Math.floor((buyAmt + 1e-9) / p);
        buyAmt = Number((wholeBuy * p).toFixed(2));
      }
    }
    candidateBuyAmts.set(b.ticker, buyAmt);
  });

  // Pass 2: Greedy whole-share leftover pass (matches backend DiscreteAllocation.greedy_portfolio)
  if (executionUnitMode === 'whole' && buyCandidates.length > 0 && netSpendableForBuys > 0) {
    let spentSoFar = Array.from(candidateBuyAmts.values()).reduce((a, v) => a + v, 0);
    let remCash = Number((netSpendableForBuys - spentSoFar).toFixed(2));
    let safetyIter = 0;
    while (safetyIter < 500) {
      safetyIter++;
      const affordable = buyCandidates.filter(b => b.price > 0 && b.price <= remCash + 1e-9);
      if (affordable.length === 0) break;
      const denom = Math.max(1.0, totalPortfolioBudget);
      let bestCand = affordable[0];
      let bestGap = -Infinity;
      affordable.forEach(b => {
        const curAlloc = b.current_value + (candidateBuyAmts.get(b.ticker) || 0);
        const gap = b.target_weight - (curAlloc / denom);
        if (gap > bestGap) {
          bestGap = gap;
          bestCand = b;
        }
      });
      const prevAmt = candidateBuyAmts.get(bestCand.ticker) || 0;
      const nextAmt = Number((prevAmt + bestCand.price).toFixed(2));
      candidateBuyAmts.set(bestCand.ticker, nextAmt);
      remCash = Number((remCash - bestCand.price).toFixed(2));
    }
  }

  buyCandidates.forEach(b => {
    const buyAmt = candidateBuyAmts.get(b.ticker) || 0;
    const p = b.price > 0 ? b.price : 0;
    if (buyAmt >= Math.max(1, minThreshold) && (executionUnitMode !== 'whole' || p <= 0 || Math.floor((buyAmt + 1e-9) / p) >= 1)) {
      b.action = 'BUY';
      b.hold_reason = '';
      b.trade_amount = buyAmt;
      b.final_value = Number((b.current_value + buyAmt).toFixed(2));
      buyOrders.push(b);
    } else {
      b.action = 'HOLD';
      b.hold_reason = (executionUnitMode === 'whole' && p > 0 && b.target_weight > 0.0005 && b.raw_buy_need >= Math.max(1, minThreshold) && p > b.raw_buy_need)
        ? 'WHOLE_UNIT_TOO_EXPENSIVE'
        : '';
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
    item.trade_shares_executed = executionUnitMode === 'whole' ? item.trade_shares_whole : item.trade_shares_fractional;
    item.target_shares_fractional = p > 0 ? Number((item.target_value / p).toFixed(4)) : 0;
    item.target_shares_whole = p > 0 ? Math.floor((item.target_value / p) + 1e-9) : 0;
  });

  const totalBuyNet = Number(buyOrders.reduce((acc, b) => acc + b.trade_amount, 0).toFixed(2));
  const leftoverCash = Number(Math.max(0, rawCashAvailable - totalBuyNet).toFixed(2));
  const roundingLeftoverCash = Number(Math.max(0, netSpendableForBuys - totalBuyNet).toFixed(2));

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
    executionUnitMode,
    commissionPct,
    feeRate: FEE_RATE,
    totalPortfolioBudget,
    totalCurrentHoldings,
    cashInjection,
    withdrawalExceedsSells,
    feeBufferOn,
    feeReserve,
    roundingLeftoverCash,
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

  // Concise Hero Title & Tagline
  const blConfPct = Math.round((Number(data.black_litterman?.confidence ?? state.blConfidence ?? 0.5)) * 100);
  const heroTitleMap = {
    max_sharpe: state.useNewsAdjustment
      ? `พอร์ต Black-Litterman • Max Sharpe (ความเชื่อมั่น ${blConfPct}%)`
      : 'พอร์ตคุ้มความเสี่ยงสูงสุด • Max Sharpe',
    min_volatility: 'พอร์ตผันผวนต่ำ • Min Volatility',
    hrp: 'พอร์ตกระจายเสี่ยงสมดุล • Risk Parity',
    equal_weight: 'พอร์ตแบ่งเงินเท่ากันทุกตัว • Equal Weight'
  };
  const activeTitleStr = heroTitleMap[state.activeGoal] || strat.name;
  document.getElementById('active-goal-title').innerText = activeTitleStr;
  document.getElementById('active-goal-desc').innerText = strat.tagline;

  // KPI 1: Expected Return + Profit in Baht
  const retPct = (strat.expected_return * 100).toFixed(2);
  const retSign = strat.expected_return >= 0 ? '+' : '';
  const compactTitleEl = document.getElementById('strip-compact-title');
  const compactKpiEl = document.getElementById('strip-compact-kpi');
  if (compactTitleEl) compactTitleEl.innerText = activeTitleStr;
  if (compactKpiEl) compactKpiEl.innerText = `${retSign}${retPct}%/ปี`;
  const kpiRetEl = document.getElementById('kpi-return');
  kpiRetEl.innerText = `${retSign}${retPct}%`;
  kpiRetEl.className = `font-mono font-extrabold tracking-tight mt-1.5 tabular-nums ${strat.expected_return >= 0 ? 'qf-primary-text' : 'qf-kpi-rose-text'}`;

  const estProfit = budget * strat.expected_return;
  const profitSign = estProfit >= 0 ? '+' : '-';
  const kpiProfitEl = document.getElementById('kpi-profit-money');
  kpiProfitEl.innerText = state.balancePrivacyHidden
    ? `≈ ${profitSign}${state.currencySymbol} ••••••/ปี`
    : `≈ ${profitSign}${formatMoney(Math.abs(estProfit), 0, true)}/ปี`;
  kpiProfitEl.className = estProfit >= 0
    ? 'qf-kpi-sub-tag qf-kpi-tag-emerald text-[11px] sm:text-xs font-mono font-semibold rounded-md border px-2 py-0.5 mt-2 inline-block tabular-nums max-w-full truncate'
    : 'qf-kpi-sub-tag qf-kpi-tag-rose text-[11px] sm:text-xs font-mono font-semibold rounded-md border px-2 py-0.5 mt-2 inline-block tabular-nums max-w-full truncate';

  // KPI 2: Volatility & Risk Badge
  const volPct = (strat.volatility * 100).toFixed(2);
  document.getElementById('kpi-volatility').innerText = `${volPct}%`;
  const riskBadge = document.getElementById('kpi-risk-badge');
  if (strat.volatility < 0.16) {
    riskBadge.innerText = 'ความเสี่ยงต่ำ';
    riskBadge.className = 'qf-kpi-sub-tag qf-kpi-tag-emerald inline-block text-[11px] sm:text-xs font-semibold px-2 py-0.5 rounded-md border mt-2 max-w-full truncate';
  } else if (strat.volatility <= 0.28) {
    riskBadge.innerText = 'ความเสี่ยงปานกลาง';
    riskBadge.className = 'qf-kpi-sub-tag qf-kpi-tag-amber inline-block text-[11px] sm:text-xs font-semibold px-2 py-0.5 rounded-md border mt-2 max-w-full truncate';
  } else {
    riskBadge.innerText = 'ความเสี่ยงสูง';
    riskBadge.className = 'qf-kpi-sub-tag qf-kpi-tag-rose inline-block text-[11px] sm:text-xs font-semibold px-2 py-0.5 rounded-md border mt-2 max-w-full truncate';
  }

  // KPI 3: Historical Max Drawdown in BAHT (Clean Hero Summary; full Peak->Trough in Tab 4 & Tooltip)
  const mddBaht = strat.max_drawdown_amount !== undefined
    ? strat.max_drawdown_amount
    : Math.abs(strat.max_drawdown) * budget;
  const minRemainingBaht = strat.min_capital_remaining !== undefined
    ? strat.min_capital_remaining
    : Math.max(0, budget - mddBaht);

  document.getElementById('kpi-mdd-baht').innerText = state.balancePrivacyHidden
    ? `-${state.currencySymbol} ••••••`
    : `-${formatMoney(mddBaht, 0, true)}`;
  document.getElementById('kpi-mdd').innerText = `${(strat.max_drawdown * 100).toFixed(2)}%`;
  const mddRemEl = document.getElementById('kpi-mdd-remaining');
  if (mddRemEl) {
    mddRemEl.innerHTML = 'จากจุดสูงสุด<span class="hidden sm:inline">ในอดีต</span>';
    mddRemEl.title = state.balancePrivacyHidden
      ? 'ช่วงย่อตัวจากจุดสูงสุดลงสู่จุดต่ำสุดในอดีต'
      : `ช่วงย่อตัวจากจุดสูงสุดลงสู่จุดต่ำสุดในอดีต (${formatMoney(minRemainingBaht, 0, false)})`;
  }

  // KPI 4: Sharpe Ratio
  document.getElementById('kpi-sharpe').innerText = strat.sharpe_ratio.toFixed(2);
  const srBadge = document.getElementById('kpi-sharpe-badge');
  if (strat.sharpe_ratio >= 1.5) {
    srBadge.innerText = 'คุ้มค่าดีเยี่ยม';
    srBadge.className = 'qf-kpi-sub-tag qf-kpi-tag-emerald inline-block text-[11px] sm:text-xs font-semibold px-2 py-0.5 rounded-md border mt-2 max-w-full truncate';
  } else if (strat.sharpe_ratio >= 1.0) {
    srBadge.innerText = 'คุ้มค่าดี';
    srBadge.className = 'qf-kpi-sub-tag qf-kpi-tag-blue inline-block text-[11px] sm:text-xs font-semibold px-2 py-0.5 rounded-md border mt-2 max-w-full truncate';
  } else {
    srBadge.innerText = 'คุ้มค่าระดับปานกลาง';
    srBadge.className = 'qf-kpi-sub-tag qf-kpi-tag-neutral inline-block text-[11px] sm:text-xs font-semibold px-2 py-0.5 rounded-md border mt-2 max-w-full truncate';
  }

  // Donut Chart of Portfolio Weights
  renderDonutAllocationChart(strat.weights, data.metadata.tickers);

  // Compute Prudent Rebalance Plan
  const plan = computeRebalancePlan(strat, data);
  state.lastRebalancePlan = plan;

  // Keep Trade Plan tab label clean without "N รายการ" pill clutter
  const navTradeBadge = document.getElementById('nav-trade-count-badge');
  if (navTradeBadge) {
    navTradeBadge.innerText = '';
    navTradeBadge.classList.add('hidden');
  }

  // Update Summary KPI Box & Order Assumptions (respects Privacy Mode)
  document.getElementById('order-kpi-budget').innerText = maskIfPrivate(formatMoney(plan.totalPortfolioBudget, 2, false));
  document.getElementById('order-kpi-total-sell').innerText = plan.totalSellGross > 0
    ? (state.balancePrivacyHidden ? `+${state.currencySymbol} ••••••` : `+${formatMoney(plan.totalSellGross, 2, false)}`)
    : maskIfPrivate(formatMoney(0, 2, false));
  document.getElementById('order-kpi-total-buy').innerText = maskIfPrivate(formatMoney(plan.totalBuyNet, 2, false));
  document.getElementById('order-kpi-leftover').innerText = maskIfPrivate(formatMoney(plan.leftoverCash, 2, false));

  const roundingEl = document.getElementById('order-rounding-leftover');
  if (roundingEl) {
    roundingEl.innerText = `กันสำรอง: ${maskIfPrivate(formatMoney(plan.feeReserve, 2, false))} • ปัดเศษ: ${maskIfPrivate(formatMoney(plan.roundingLeftoverCash, 2, false))}`;
  }
  const commEstEl = document.getElementById('order-commission-estimate');
  if (commEstEl) {
    commEstEl.innerText = plan.feeBufferOn
      ? `กันสำรองค่านายหน้า (${plan.commissionPct.toFixed(2)}%): ${maskIfPrivate(formatMoney(plan.feeReserve, 2, true), true)}`
      : 'ไม่หักสำรองค่านายหน้า (0.00%)';
  }
  const assumpEl = document.getElementById('order-assumptions-summary');
  if (assumpEl) {
    const unitDesc = plan.executionUnitMode === 'whole'
      ? 'ซื้อ-ขายเฉพาะจำนวนเต็มหน่วย (ปัดลง)'
      : 'ซื้อเป็นเศษหน่วยได้ (ทศนิยม 4 ตำแหน่ง)';
    const feeDesc = plan.feeBufferOn ? `${plan.commissionPct.toFixed(2)}%` : '0.00%';
    assumpEl.innerText = `สมมติฐาน: ${unitDesc} • ค่านายหน้า ${feeDesc} • เรท ${state.fxRate.toFixed(2)} ฿/$ • ยังไม่รวมส่วนต่างแลกเงิน / VAT / ภาษีปันผล`;
  }

  const prudentNote = document.getElementById('prudent-status-note');
  if (prudentNote) {
    if (plan.withdrawalExceedsSells) {
      prudentNote.innerHTML = `<i data-lucide="alert-triangle" class="w-3.5 h-3.5"></i><span>คำเตือน: ยอดถอนเงินสดมากกว่ายอดขายสินทรัพย์ ระบบงดสั่งซื้อเพิ่มเพื่อป้องกันเงินสดติดลบ</span>`;
      prudentNote.className = 'text-[11px] text-rose-700 font-bold flex items-center gap-1';
    } else if (plan.feeBufferOn) {
      prudentNote.innerHTML = `<i data-lucide="shield-check" class="w-3.5 h-3.5"></i><span>รอบคอบ: กันสำรองค่านายหน้า ${plan.commissionPct.toFixed(2)}% (${maskIfPrivate(formatMoney(plan.feeReserve, 2, true), true)}) + เหลือปัดเศษ ${maskIfPrivate(formatMoney(plan.roundingLeftoverCash, 2, true), true)}</span>`;
      prudentNote.className = 'text-[11px] text-emerald-700 font-medium flex items-center gap-1';
    } else {
      prudentNote.innerHTML = `<i data-lucide="info" class="w-3.5 h-3.5"></i><span>คำนวณเต็มวงเงิน 100% (ไม่หักสำรองค่านายหน้า)</span>`;
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

  // Case 2: Rebalance Mode with SELL orders (Buy/Sell pairing OR Sell-Only Withdrawal)
  if (plan.sellOrders.length > 0) {
    const cashDeltaPill = plan.cashInjection < -0.5
      ? `<span class="px-2.5 py-1 rounded-lg bg-amber-50 text-amber-800 border border-amber-200 tabular-nums">ถอนออก ${maskIfPrivate(formatMoney(Math.abs(plan.cashInjection), 0, false))}</span>`
      : (plan.cashInjection > 0.5
        ? `<span class="px-2.5 py-1 rounded-lg bg-blue-50 text-blue-700 border border-blue-200 tabular-nums">เติมเพิ่ม +${maskIfPrivate(formatMoney(plan.cashInjection, 0, false))}</span>`
        : '');

    const pairRowsHtml = plan.flowPairs.length > 0
      ? plan.flowPairs.map((pair, idx) => {
          const fromLabel = pair.fromIsCash
            ? `<span class="px-2 py-0.5 rounded-md bg-blue-100 text-blue-800 font-bold text-[11px] whitespace-nowrap">${escapeHtmlText(pair.fromName)}</span>`
            : `<span class="px-2 py-0.5 rounded-md bg-rose-100 text-rose-800 font-mono font-bold text-[11px] whitespace-nowrap">ขาย ${escapeHtmlText(pair.fromTicker)}</span>`;
          const fromSub = (!pair.fromIsCash && pair.sellShares > 0)
            ? `<span class="text-[11px] text-slate-500 font-mono whitespace-nowrap">~${formatShareUnits(pair.sellShares, 4)} หน่วย</span>`
            : '';
          const toSub = pair.buyShares > 0
            ? `<span class="text-[11px] text-slate-500 font-mono whitespace-nowrap">~${formatShareUnits(pair.buyShares, 4)} หน่วย</span>`
            : '';

          return `
            <div class="flow-pair-card px-3 py-2.5 grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] items-center gap-2 text-xs">
              <div class="flex items-center gap-2 min-w-0">
                <span class="w-5 h-5 rounded-full bg-slate-900 text-white text-[10px] font-bold flex items-center justify-center shrink-0">${idx + 1}</span>
                ${fromLabel}
                <div class="min-w-0">
                  <div class="font-mono font-bold text-rose-700 text-[13px] tabular-nums truncate">${maskIfPrivate(formatMoney(pair.sellAmount, 2, false))}</div>
                  ${fromSub}
                </div>
              </div>

              <div class="hidden sm:flex items-center justify-center px-2 text-slate-400 font-extrabold text-sm whitespace-nowrap select-none">
                ──➔
              </div>

              <div class="flex items-center sm:justify-end gap-2 min-w-0">
                <span class="px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-800 font-mono font-bold text-[11px] whitespace-nowrap">ซื้อ ${escapeHtmlText(pair.toTicker)}</span>
                <div class="sm:text-right min-w-0">
                  <div class="font-mono font-bold text-emerald-700 text-[13px] tabular-nums truncate">${maskIfPrivate(formatMoney(pair.buyAmount, 2, false))}</div>
                  ${toSub}
                </div>
              </div>
            </div>
          `;
        }).join('')
      : `
        <div class="p-3.5 rounded-xl bg-amber-50/70 border border-amber-200 text-xs text-amber-900 space-y-1">
          <div class="font-bold">โหมดขายรับเงินสดเพื่อถอนออก (ไม่มีคำสั่งซื้อเพิ่ม)</div>
          <div class="text-slate-700">
            ขายสินทรัพย์รวม <b class="font-mono text-rose-700">${maskIfPrivate(formatMoney(plan.totalSellGross, 2, true), true)}</b>
            ${plan.cashInjection < 0 ? `สำหรับแผนถอนออก <b class="font-mono">${maskIfPrivate(formatMoney(Math.abs(plan.cashInjection), 2, true), true)}</b>` : ''}
            (ดูรายการขายรายตัวด้านบน)
          </div>
        </div>
      `;

    const withdrawalNote = (plan.cashInjection < -0.5 && plan.flowPairs.length > 0)
      ? `<div class="text-[11px] text-amber-800 bg-amber-50/80 border border-amber-200/80 rounded-xl px-3 py-2 font-medium">
           หักเงินสดถอนออก <b class="font-mono">${maskIfPrivate(formatMoney(Math.abs(plan.cashInjection), 2, true), true)}</b> + กันสำรองค่านายหน้า <b class="font-mono">${maskIfPrivate(formatMoney(plan.feeReserve, 2, true), true)}</b> ก่อนนำส่วนที่เหลือไปซื้อต่อ
         </div>`
      : '';

    box.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-slate-200/80">
        <div>
          <h4 class="text-sm font-extrabold text-slate-900">ผังโยกเงินปรับพอร์ต (ขาย ➔ ซื้อ)</h4>
          <p class="text-[11px] text-slate-500 mt-0.5">จับคู่ยอดเงินขายไปซื้ออัตโนมัติ (ดูรายการส่งคำสั่งเต็มได้ด้านบน)</p>
        </div>
        <div class="flex flex-wrap items-center gap-1.5 text-xs font-mono font-bold">
          <span class="px-2.5 py-1 rounded-lg bg-rose-50 text-rose-700 border border-rose-200 tabular-nums">ขาย ${maskIfPrivate(formatMoney(plan.totalSellGross, 0, false))}</span>
          ${cashDeltaPill}
          <span class="text-slate-400 font-sans">➔</span>
          <span class="px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 tabular-nums">ซื้อ ${maskIfPrivate(formatMoney(plan.totalBuyNet, 0, false))}</span>
        </div>
      </div>

      ${withdrawalNote}

      <div class="space-y-2 flex-1">
        ${pairRowsHtml}
      </div>
    `;
    return;
  }

  // Case 3: 100% Cash / Buy-Only Mode (Concise summary strip — avoids repeating the order cards above)
  const topBuyPreview = plan.buyOrders
    .slice(0, 3)
    .map(b => `<span class="px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-800 border border-emerald-200 font-mono text-[11px] font-semibold">${escapeHtmlText(b.ticker)} ${(b.target_weight * 100).toFixed(1)}%</span>`)
    .join('');
  const extraCount = Math.max(0, plan.buyOrders.length - 3);
  const extraBadge = extraCount > 0
    ? `<span class="px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 text-[11px] font-semibold">+${extraCount} ตัว</span>`
    : '';

  box.innerHTML = `
    <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-3 border-b border-slate-200/80 pb-3">
      <div>
        <div class="flex items-center gap-2">
          <span class="w-2 h-2 rounded-full bg-emerald-600 shrink-0"></span>
          <h4 class="text-sm font-bold text-slate-900">
            สรุปการจัดสรรเงินสดตั้งต้น ${maskIfPrivate(formatMoney(plan.totalPortfolioBudget, 2, true), true)}
          </h4>
        </div>
        <p class="text-xs text-slate-600 mt-1">
          ระบบจัดสรรเป็นคำสั่งซื้อทั้งหมด <b class="font-mono text-slate-900">${plan.buyOrders.length} รายการ</b> (กันสำรองค่านายหน้าแล้ว ${maskIfPrivate(formatMoney(plan.feeReserve, 2, true), true)}) ดูรายละเอียดรายตัวด้านบนได้ทั้งแบบการ์ดและตารางเต็ม
        </p>
      </div>
      <button
        type="button"
        onclick="toggleTradePlanViewMode('table'); document.getElementById('step-3-execution-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });"
        class="px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-blue-700 text-white text-xs font-semibold transition cursor-pointer shrink-0 whitespace-nowrap"
      >
        สลับดูมุมมองตารางเต็ม
      </button>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
      <div class="p-3 rounded-xl bg-white border border-slate-200/90">
        <div class="text-[11px] text-slate-500">ยอดจัดสรรซื้อสุทธิ</div>
        <div class="font-mono font-bold text-sm text-emerald-700 mt-0.5 tabular-nums">${maskIfPrivate(formatMoney(plan.totalBuyNet, 2, true), true)}</div>
      </div>
      <div class="p-3 rounded-xl bg-white border border-slate-200/90">
        <div class="text-[11px] text-slate-500">กันสำรองค่านายหน้า</div>
        <div class="font-mono font-bold text-sm text-slate-900 mt-0.5 tabular-nums">${maskIfPrivate(formatMoney(plan.feeReserve, 2, true), true)}</div>
      </div>
      <div class="p-3 rounded-xl bg-white border border-slate-200/90">
        <div class="text-[11px] text-slate-500">สัดส่วนหลักในรอบนี้</div>
        <div class="flex flex-wrap gap-1 mt-1">${topBuyPreview}${extraBadge}</div>
      </div>
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

    // Dual-currency display via centralized FX conversion
    const natCurr = stat.native_currency || item.native_currency || (item.ticker.endsWith('.BK') ? 'THB' : 'USD');
    const natPx = Number(stat.native_price || item.native_price || item.price);
    const pThb = convertNativePrice(natPx, natCurr, 'THB', fx);
    const pUsd = convertNativePrice(natPx, natCurr, 'USD', fx);

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
        <div class="font-mono font-bold text-rose-700 text-sm mt-0.5">-${maskIfPrivate(formatMoney(item.trade_amount, 2, true), true)}</div>
      `;
      sharesActionHtml = item.trade_shares_whole > 0
        ? `<div class="font-sans font-bold text-rose-700">ขาย ${item.trade_shares_whole.toLocaleString()} หน่วย</div>
           <div class="text-[10px] text-slate-400 font-mono">(ละเอียด: ${item.trade_shares_fractional} หน่วย)</div>`
        : `<div class="font-sans font-bold text-rose-700">ขาย ${item.trade_shares_fractional} หน่วยย่อย</div>
           <div class="text-[10px] text-slate-400 font-sans">(ส่งคำสั่งแบบเศษหน่วย)</div>`;
    } else if (item.action === 'BUY') {
      actionBadgeHtml = `
        <div class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-200 font-sans font-bold text-xs">
          <span>สั่งซื้อเพิ่ม</span>
        </div>
        <div class="font-mono font-bold text-emerald-700 text-sm mt-0.5">+${maskIfPrivate(formatMoney(item.trade_amount, 2, true), true)}</div>
      `;
      sharesActionHtml = item.trade_shares_whole > 0
        ? `<div class="font-sans font-bold text-emerald-700">ซื้อ ${item.trade_shares_whole.toLocaleString()} หน่วย</div>
           <div class="text-[10px] text-slate-400 font-mono">(ละเอียด: ${item.trade_shares_fractional} หน่วย)</div>`
        : `<div class="font-sans font-bold text-blue-700">ซื้อ ${item.trade_shares_fractional} หน่วยย่อย</div>
           <div class="text-[10px] text-slate-400 font-sans">(ส่งคำสั่งแบบเศษหน่วย)</div>`;
    } else if (item.hold_reason === 'WHOLE_UNIT_TOO_EXPENSIVE') {
      actionBadgeHtml = `
        <div class="inline-block px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 font-sans font-semibold text-[11px]">
          เกินงบเต็มหน่วย
        </div>
        <div class="text-[10px] text-amber-700 font-sans mt-0.5">ราคาต่อหน่วยสูงกว่างบจัดสรร</div>
      `;
      sharesActionHtml = `<span class="text-amber-700 font-sans text-[11px]">ต้องซื้อเศษหน่วย</span>`;
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
          <div class="text-[11px] text-slate-500">เดิม: ${maskIfPrivate(formatMoney(item.current_value, 0, false))} (${wCurPct}%)</div>
          <div class="font-bold text-slate-900 mt-0.5">เป้า: ${maskIfPrivate(formatMoney(item.target_value, 0, false))} (${wTarPct}%)</div>
        </td>
        <td class="py-3 px-3 text-right">${actionBadgeHtml}</td>
        <td class="py-3 px-3 text-right">${sharesActionHtml}</td>
      </tr>
    `;
  }).join('');

  renderOrderChecklistCards(sortedItems, data);
  updateOrderExecProgressBadge(doneCount, actionableItems.length);
}

function formatShareUnits(val, maxFrac = 4) {
  const num = Number(val);
  if (!Number.isFinite(num)) return '0';
  return num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: maxFrac });
}

function computePortfolioEntryReadiness(data = state.optData, goalKey = state.activeGoal) {
  if (!data || !data.strategies) return null;
  const activeStrat = data.strategies[goalKey] || {};
  const weights = activeStrat.weights || {};
  const assetStats = Array.isArray(data.asset_stats) ? data.asset_stats : [];
  const intelAssets = (data.market_intelligence && data.market_intelligence.assets) || {};
  const statMap = {};
  assetStats.forEach(s => { if (s && s.ticker) statMap[s.ticker] = s; });

  let posW = 0;
  let neuW = 0;
  let ovbW = 0;
  let cauW = 0;
  let totalW = 0;
  const trancheTickers = [];
  const cautiousTickers = [];

  Object.entries(weights).forEach(([ticker, rawW]) => {
    const w = Number(rawW) || 0;
    if (w <= 0.0001) return;
    totalW += w;
    const dec = (statMap[ticker] && statMap[ticker].decision) || intelAssets[ticker] || {};
    const lvl = dec.signal_level || 'NEUTRAL_ACCUMULATE';
    if (lvl === 'POSITIVE_BUY') {
      posW += w;
    } else if (lvl === 'OVERBOUGHT_TRANCHE') {
      ovbW += w;
      trancheTickers.push(ticker);
    } else if (lvl === 'CAUTIOUS_SHIELD') {
      cauW += w;
      trancheTickers.push(ticker);
      cautiousTickers.push(ticker);
    } else {
      neuW += w;
    }
  });

  if (totalW <= 0) return null;
  const positivePct = Number(((posW / totalW) * 100).toFixed(1));
  const neutralPct = Number(((neuW / totalW) * 100).toFixed(1));
  const overboughtPct = Number(((ovbW / totalW) * 100).toFixed(1));
  const cautiousPct = Number(((cauW / totalW) * 100).toFixed(1));
  const favorablePct = Number((positivePct + neutralPct).toFixed(1));
  const cautionTotalPct = Number((overboughtPct + cautiousPct).toFixed(1));

  const tierInfo = typeof getActiveUserTierInfo === 'function' ? getActiveUserTierInfo() : { canViewNews: false };
  const hasLiveNews = Boolean(tierInfo.canViewNews);
  const blActiveOnGoal = Boolean(state.useNewsAdjustment && goalKey === 'max_sharpe');
  const sourceCaptionTh = hasLiveNews
    ? 'ผสานสัญญาณข่าวตลาด + แนวโน้มราคา & RSI (ถ่วงน้ำหนักตาม % เงินลงทุนจริง)'
    : 'ประเมินจากแนวโน้มราคา & RSI (เข้าสู่ระบบฟรีเพื่อเพิ่มสัญญาณข่าวตลาด)';

  let level = 'favorable';
  let badgeTh = 'จังหวะเอื้อต่อการเข้าตามแผน';
  let tagCls = 'qf-kpi-tag-emerald';
  let headlineTh = `เงินลงทุนส่วนใหญ่ (${favorablePct.toFixed(0)}%) อยู่ในโซนน่าสะสม/สมดุล เอื้อต่อการเข้าลงทุนตามแผน`;
  let actionTh = 'สามารถทยอยส่งคำสั่งตามแผนหรือสะสมรายเดือน (DCA) ได้ตามวินัย โดยติดตามข่าวและทบทวนพอร์ตทุกไตรมาส';
  let pdfNoteTh = 'จังหวะราคาโดยรวมอยู่ในเกณฑ์สมดุล สามารถทยอยเข้าลงทุนตามสัดส่วนแผนหรือ DCA ตามวินัย';

  if (cautiousPct >= 40) {
    level = 'cautious';
    badgeTh = 'ควรระวัง / รอจังหวะ';
    tagCls = 'qf-kpi-tag-rose';
    const topCaut = cautiousTickers.slice(0, 3).join(', ');
    headlineTh = `เงินลงทุน ${cautiousPct.toFixed(0)}% อยู่ในโซนควรระวัง (${topCaut || 'สินทรัพย์หลัก'})`;
    actionTh = 'แนะนำชะลอการเข้าซื้อก้อนเดียว พิจารณาแบ่งซื้ออย่างน้อย 3 ไม้ ตรวจข่าวรายตัวก่อนตัดสินใจ หรือเทียบแผนผันผวนต่ำ (Min Vol)';
    pdfNoteTh = `เงินลงทุน ${cautiousPct.toFixed(0)}% อยู่ในโซนควรระวัง แนะนำแบ่งไม้เข้าลงทุนอย่างน้อย 3 ไม้หรือทบทวนแผนผันผวนต่ำ`;
  } else if (cautionTotalPct >= 30) {
    level = 'tranche';
    badgeTh = 'ควรทยอยแบ่งไม้ซื้อ (2–3 ไม้)';
    tagCls = 'qf-kpi-tag-amber';
    const topTranche = trancheTickers.slice(0, 3).join(', ');
    headlineTh = `เงินลงทุน ${cautionTotalPct.toFixed(0)}% อยู่ในโซนราคาตึงตัว/ควรระวัง (${topTranche || 'สินทรัพย์หลัก'})`;
    actionTh = 'เพื่อลดความเสี่ยงไล่ราคา แนะนำแบ่งงบทยอยซื้อ 2–3 ไม้แทนการเข้าซื้อครั้งเดียว 100% (ดูยอดแนะนำต่อไม้ในการ์ดด้านล่าง)';
    pdfNoteTh = `เงินลงทุน ${cautionTotalPct.toFixed(0)}% อยู่ในโซนราคาตึงตัว/ควรระวัง แนะนำทยอยแบ่งซื้อ 2–3 ไม้เพื่อลดความเสี่ยงไล่ราคา`;
  }

  return {
    level,
    badgeTh,
    tagCls,
    headlineTh,
    actionTh,
    pdfNoteTh,
    positivePct,
    neutralPct,
    overboughtPct,
    cautiousPct,
    favorablePct,
    cautionTotalPct,
    trancheTickers,
    cautiousTickers,
    hasLiveNews,
    blActiveOnGoal,
    sourceCaptionTh
  };
}

function inspectTickerOnInsightsTab(ticker) {
  const clean = String(ticker || '').trim().toUpperCase();
  if (clean) {
    state.insightsSelectedTicker = clean;
    state.insightsNewsExpanded = false;
  }
  switchAppTab('insights');
  if (typeof renderNewsAndSignalSection === 'function') {
    renderNewsAndSignalSection();
  }
  setTimeout(() => {
    const grid = document.getElementById('insights-stock-cards-grid');
    if (grid) {
      grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, 90);
}

function renderPortfolioEntryReadinessBox(containerId, readiness, compactForTradePlan = false) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!readiness) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.classList.remove('hidden');

  const segsHtml = [
    { pct: readiness.positivePct, cls: 'bg-emerald-600', title: `น่าสะสม ${readiness.positivePct.toFixed(1)}%` },
    { pct: readiness.neutralPct, cls: 'bg-blue-500', title: `สมดุล ${readiness.neutralPct.toFixed(1)}%` },
    { pct: readiness.overboughtPct, cls: 'bg-amber-500', title: `ราคาตึง/แบ่งไม้ ${readiness.overboughtPct.toFixed(1)}%` },
    { pct: readiness.cautiousPct, cls: 'bg-rose-500', title: `ควรระวัง ${readiness.cautiousPct.toFixed(1)}%` }
  ].filter(s => s.pct > 0).map(s => `<div class="h-full ${s.cls}" style="width:${s.pct.toFixed(1)}%" title="${escapeHtmlText(s.title)}"></div>`).join('');

  const rightActionHtml = compactForTradePlan
    ? `<button type="button" onclick="switchAppTab('insights')" class="shrink-0 px-3 py-1.5 rounded-lg bg-white hover:bg-slate-100 text-slate-800 border border-slate-300 text-xs font-semibold transition cursor-pointer whitespace-nowrap self-start sm:self-center">ตรวจข่าว &amp; จังหวะ (แท็บ 3) ➔</button>`
    : (readiness.level === 'cautious' && state.activeGoal !== 'min_volatility'
        ? `<button type="button" onclick="selectGoal('min_volatility')" class="shrink-0 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold transition cursor-pointer whitespace-nowrap self-start sm:self-center">ลองดูแผนผันผวนต่ำ ➔</button>`
        : `<button type="button" onclick="switchAppTab('trade-plan')" class="shrink-0 px-3 py-1.5 rounded-lg bg-white hover:bg-slate-100 text-slate-800 border border-slate-300 text-xs font-semibold transition cursor-pointer whitespace-nowrap self-start sm:self-center">กลับไปดูใบสั่งซื้อ (แท็บ 2) ➔</button>`);

  el.className = 'p-3.5 sm:p-4 rounded-xl bg-slate-50 border border-slate-200/90 space-y-2.5';
  el.innerHTML = `
    <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-2.5">
      <div class="space-y-1 min-w-0">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-[11px] font-semibold text-slate-500">ความพร้อมจังหวะเข้าลงทุนทั้งพอร์ต</span>
          <span class="px-2 py-0.5 rounded-md border text-[11px] font-bold ${readiness.tagCls}">${escapeHtmlText(readiness.badgeTh)}</span>
        </div>
        <div class="text-xs sm:text-[13px] font-semibold text-slate-900 leading-snug">${escapeHtmlText(readiness.headlineTh)}</div>
        <div class="text-xs text-slate-600 leading-relaxed">${escapeHtmlText(readiness.actionTh)}</div>
      </div>
      ${rightActionHtml}
    </div>
    <div class="space-y-1.5 pt-0.5">
      <div class="w-full h-2 rounded-full bg-slate-200/80 overflow-hidden flex">${segsHtml}</div>
      <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-slate-600">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono tabular-nums">
          <span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-emerald-600"></span>น่าสะสม ${readiness.positivePct.toFixed(0)}%</span>
          <span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-blue-500"></span>สมดุล ${readiness.neutralPct.toFixed(0)}%</span>
          <span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-amber-500"></span>ราคาตึง ${readiness.overboughtPct.toFixed(0)}%</span>
          <span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-rose-500"></span>ควรระวัง ${readiness.cautiousPct.toFixed(0)}%</span>
        </div>
        <span class="text-[10.5px] text-slate-500">${escapeHtmlText(readiness.sourceCaptionTh)}</span>
      </div>
    </div>
  `;
}

function renderOrderChecklistCards(sortedItems, data) {
  const readiness = computePortfolioEntryReadiness(data, state.activeGoal);
  renderPortfolioEntryReadinessBox('tab2-entry-readiness-strip', readiness, true);
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

    const pThb = convertNativePrice(stat.native_price || item.native_price || item.price, stat.native_currency || item.native_currency, 'THB', fx);
    const pUsd = convertNativePrice(stat.native_price || item.native_price || item.price, stat.native_currency || item.native_currency, 'USD', fx);
    const companionShort = state.currency === 'THB'
      ? `$${pUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : `฿${pThb.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const fracSharesTxt = formatShareUnits(item.trade_shares_fractional, 4);
    const wholeSharesTxt = formatShareUnits(item.trade_shares_whole, 0);

    let actionPill = '<span class="px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 font-semibold text-xs whitespace-nowrap shrink-0">ถือคงเดิม</span>';
    let amountText = '<div class="font-mono text-base font-semibold text-slate-400">ไม่ต้องซื้อ-ขาย</div>';
    let sharesLine = '<span class="text-slate-500 text-[13px]">สัดส่วนใกล้เคียงเป้าหมายแล้ว</span>';

    if (item.action === 'HOLD' && item.target_weight <= 0.0001 && item.current_weight <= 0.0001) {
      actionPill = '<span class="px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 border border-slate-200 font-semibold text-xs whitespace-nowrap shrink-0">ไม่จัดสรร (0%)</span>';
      amountText = '<div class="font-sans text-sm font-semibold text-slate-500">ไม่จัดสรรในแผนนี้ (0%)</div>';
      sharesLine = '<span class="text-slate-500 text-[13px]">กลยุทธ์นี้ไม่ได้เลือกถือครองสินทรัพย์นี้</span>';
    }

    const isWholeMode = state.executionUnitMode === 'whole';
    if (item.action === 'SELL') {
      actionPill = '<span class="px-2.5 py-1 rounded-full bg-rose-100 text-rose-800 border border-rose-200 font-semibold text-xs whitespace-nowrap shrink-0">สั่งขายออก</span>';
      amountText = `<div class="font-mono font-bold text-xl sm:text-2xl text-rose-600 tracking-tight leading-tight tabular-nums">-${maskIfPrivate(formatMoney(item.trade_amount, 2, true), true)}</div>`;
      sharesLine = isWholeMode
        ? `<span class="text-slate-600">จำนวน:</span> <b class="text-rose-700 font-bold text-[15px] whitespace-nowrap">${wholeSharesTxt} หน่วย</b> <span class="text-slate-400 text-xs whitespace-nowrap">(เต็มหน่วย)</span>`
        : `<span class="text-slate-600">จำนวน:</span> <b class="text-rose-700 font-bold text-[15px] whitespace-nowrap">${fracSharesTxt} หน่วย</b> <span class="text-slate-400 text-xs whitespace-nowrap">(~${wholeSharesTxt} เต็ม)</span>`;
    } else if (item.action === 'BUY') {
      actionPill = '<span class="px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200 font-semibold text-xs whitespace-nowrap shrink-0">สั่งซื้อเพิ่ม</span>';
      amountText = `<div class="font-mono font-bold text-xl sm:text-2xl text-emerald-600 tracking-tight leading-tight tabular-nums">+${maskIfPrivate(formatMoney(item.trade_amount, 2, true), true)}</div>`;
      sharesLine = isWholeMode
        ? `<span class="text-slate-600">จำนวน:</span> <b class="text-emerald-700 font-bold text-[15px] whitespace-nowrap">${wholeSharesTxt} หน่วย</b> <span class="text-slate-400 text-xs whitespace-nowrap">(เต็มหน่วย)</span>`
        : `<span class="text-slate-600">จำนวน:</span> <b class="text-emerald-700 font-bold text-[15px] whitespace-nowrap">${fracSharesTxt} หน่วย</b> <span class="text-slate-400 text-xs whitespace-nowrap">(~${wholeSharesTxt} เต็ม)</span>`;
    } else if (item.hold_reason === 'WHOLE_UNIT_TOO_EXPENSIVE') {
      actionPill = '<span class="px-2.5 py-1 rounded-full bg-amber-50 text-amber-800 border border-amber-200 font-semibold text-xs whitespace-nowrap shrink-0">เกินงบเต็มหน่วย</span>';
      amountText = '<div class="font-sans text-sm font-bold text-amber-700">1 หน่วยราคาสูงกว่างบจัดสรร</div>';
      sharesLine = '<span class="text-amber-800 text-xs font-sans">เลือก <b>"ซื้อเศษหน่วยได้"</b> เพื่อซื้อสัดส่วนนี้</span>';
    }

    let sigBadge = '';
    let trancheHintHtml = '';
    if (dec.signal_badge_th) {
      let sigCls = 'bg-slate-100 text-slate-700 border-slate-200 hover:border-slate-400';
      if (dec.signal_level === 'POSITIVE_BUY') sigCls = 'qf-kpi-tag-emerald hover:opacity-90';
      else if (dec.signal_level === 'OVERBOUGHT_TRANCHE') sigCls = 'qf-kpi-tag-amber hover:opacity-90';
      else if (dec.signal_level === 'CAUTIOUS_SHIELD') sigCls = 'qf-kpi-tag-rose hover:opacity-90';
      sigBadge = `<button type="button" data-ticker="${safeTicker}" onclick="inspectTickerOnInsightsTab(this.dataset.ticker)" title="คลิกเพื่อดูข่าวและโซนราคาของ ${safeTicker} ในแท็บ 3" class="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-md border transition cursor-pointer ${sigCls}"><span>${escapeHtmlText(dec.signal_badge_th)}</span><span class="text-[10px] opacity-75">↗</span></button>`;

      if (item.action === 'BUY' && Number(item.trade_amount || 0) > 0 && (dec.signal_level === 'OVERBOUGHT_TRANCHE' || dec.signal_level === 'CAUTIOUS_SHIELD')) {
        const trancheN = dec.signal_level === 'CAUTIOUS_SHIELD' ? 3 : 2;
        const perTrancheAmt = Math.abs(Number(item.trade_amount || 0)) / trancheN;
        const perTrancheTxt = state.balancePrivacyHidden
          ? `${state.currencySymbol} ••••••`
          : formatMoney(perTrancheAmt, 0, true);
        const hintLabel = dec.signal_level === 'CAUTIOUS_SHIELD'
          ? `แนะนำแบ่ง ${trancheN} ไม้ ≈ ${perTrancheTxt}/ไม้ • เช็กข่าวก่อนเข้า`
          : `แนะนำแบ่ง ${trancheN} ไม้ ≈ ${perTrancheTxt}/ไม้`;
        trancheHintHtml = `<span class="text-[11px] font-mono text-slate-600 leading-tight">${escapeHtmlText(hintLabel)}</span>`;
      }
    }

    return `
      <div id="order-card-${safeTicker}" class="qf-ticket-card ${typeCls} ${execCls} flex flex-col justify-between gap-3">
        <!-- Row 1: Asset Identity + Non-wrapping Action Pill -->
        <div class="flex items-center justify-between gap-2.5">
          <div class="flex items-center gap-2.5 min-w-0 flex-1">
            ${isActionable
              ? `<input type="checkbox" class="qf-order-check shrink-0" data-ticker="${safeTicker}" ${isChecked ? 'checked' : ''} onchange="toggleOrderExecution(this.dataset.ticker, this.checked)" title="ติ๊กเมื่อส่งคำสั่งจริงในโบรกเกอร์แล้ว" />`
              : `<span class="w-4 h-4 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center text-xs shrink-0">-</span>`}
            ${renderStockLogoBadge(item.ticker, color, 40)}
            <div class="min-w-0 flex-1">
              <div class="font-mono font-bold text-base sm:text-lg text-slate-900 tracking-tight truncate" title="${safeTicker}">${safeTicker}</div>
              <div class="text-xs text-slate-500 truncate" title="${safeName}">${safeName}</div>
            </div>
          </div>
          ${actionPill}
        </div>

        <!-- Row 2: Dedicated Trade Amount & Unit Price Strip (prevents large amounts from colliding with ticker names) -->
        <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 pt-2 border-t border-slate-100">
          ${amountText}
          <div class="text-xs font-mono text-slate-500 whitespace-nowrap shrink-0">ราคา ${formatMoney(item.price, 2, false)} <span class="text-slate-300">|</span> ${companionShort}</div>
        </div>

        <!-- Row 3: Comma-Formatted Share Qty & Target Weight -->
        <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 bg-slate-50/90 rounded-xl px-3.5 py-2.5 border border-slate-100 text-[13px]">
          <div class="font-mono text-slate-700 min-w-0">${sharesLine}</div>
          <div class="text-right font-mono text-slate-500 whitespace-nowrap shrink-0 ml-auto">
            สัดส่วน <span class="text-slate-400">${wCurPct}%</span> ➔ <b class="text-slate-900 text-[15px] font-bold">${wTarPct}%</b>${(() => {
              const totalBudget = Number(state.lastRebalancePlan?.totalPortfolioBudget || 0);
              if (!isWholeMode || totalBudget <= 0 || item.action !== 'BUY') return '';
              const actualW = (Number(item.final_value || 0) / totalBudget) * 100;
              if (Math.abs(actualW - Number(wTarPct)) < 5.0) return '';
              return ` <span class="inline-block ml-1 px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 text-[10.5px] font-sans font-bold align-middle" title="สัดส่วนที่ใช้เงินจริงในโหมดซื้อเต็มหน่วย">ใช้จริง ${actualW.toFixed(1)}%</span>`;
            })()}
          </div>
        </div>
        ${sigBadge ? `<div class="flex flex-wrap items-center justify-between gap-2 pt-0.5">${sigBadge}${trancheHintHtml}</div>` : ''}
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
  const isMobile = isMobileViewport();
  const trace = {
    labels: labels,
    values: values,
    type: 'pie',
    hole: isMobile ? 0.52 : 0.56,
    automargin: true,
    domain: isMobile ? { x: [0.05, 0.95], y: [0.22, 0.96] } : { x: [0.10, 0.90], y: [0.12, 0.88] },
    marker: {
      colors: colors,
      line: { color: ct.donutBorder, width: 2.5 }
    },
    textinfo: isMobile ? 'percent' : 'label+percent',
    textposition: isMobile ? 'inside' : 'outside',
    insidetextorientation: 'horizontal',
    textfont: { family: 'Plus Jakarta Sans, Anuphan, sans-serif', size: isMobile ? 10.5 : 11, color: isMobile ? '#FFFFFF' : ct.donutLabel },
    outsidetextfont: { family: 'Plus Jakarta Sans, Anuphan, sans-serif', size: 11, color: ct.donutLabel },
    hovertemplate: '<b>%{label}</b><br>สัดส่วนเป้าหมาย: %{value:.2f}%<extra></extra>'
  };

  const layout = {
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    margin: isMobile ? { l: 10, r: 10, t: 10, b: 10 } : { l: 34, r: 34, t: 30, b: 34 },
    showlegend: isMobile,
    legend: isMobile ? {
      orientation: 'h',
      x: 0.5,
      xanchor: 'center',
      y: 0.0,
      yanchor: 'bottom',
      font: { size: 10.5, color: ct.donutLabel, family: 'Plus Jakarta Sans, Anuphan, sans-serif' }
    } : undefined,
    annotations: [
      {
        font: { size: 11, color: ct.donutSub, family: 'Plus Jakarta Sans, Anuphan, sans-serif' },
        showarrow: false,
        text: 'พอร์ตเป้าหมาย',
        x: 0.5,
        y: isMobile ? 0.59 : 0.5
      }
    ]
  };

  Plotly.newPlot(container, [trace], layout, getPlotlyConfig());
}

/**
 * REQUIREMENT 1: Render Backtest Stress Test & Max Drawdown in Baht Card (Peak -> Loss -> Trough + Privacy Mode)
 */
function renderBacktestStressCard() {
  const data = state.optData;
  if (!data) return;

  const strat = data.strategies[state.activeGoal];
  if (!strat) return;

  const budget = Number(data.metadata.budget) || 100000;
  const dd = strat.drawdown_details || {};
  const lossBaht = strat.max_drawdown_amount !== undefined
    ? Number(strat.max_drawdown_amount)
    : Number((Math.abs(strat.max_drawdown) * budget).toFixed(2));
  const remainingBaht = strat.min_capital_remaining !== undefined
    ? Number(strat.min_capital_remaining)
    : Number(Math.max(0, budget - lossBaht).toFixed(2));
  const peakBaht = dd.peak_value !== undefined
    ? Number(dd.peak_value)
    : Number((remainingBaht + lossBaht).toFixed(2));
  const scaledLoss = dd.initial_budget_scaled_loss !== undefined
    ? Number(dd.initial_budget_scaled_loss)
    : Number((Math.abs(strat.max_drawdown) * budget).toFixed(2));
  const scaledRemaining = Math.max(0, budget - scaledLoss);

  const mddPctAbs = Math.abs(strat.max_drawdown * 100).toFixed(2);
  const keepPct = Math.max(0, Math.min(100, 100 - Math.abs(strat.max_drawdown * 100))).toFixed(1);

  const moneyDec = budget >= 1000 ? 0 : 2;
  document.getElementById('bt-dd-initial-budget').innerText = maskIfPrivate(formatMoney(peakBaht, moneyDec, true), true);
  const initSubEl = document.getElementById('bt-dd-initial-sub');
  if (initSubEl) {
    initSubEl.innerText = `เริ่มจากเงินต้น ${maskIfPrivate(formatMoney(budget, moneyDec, true), true)}`;
  }

  document.getElementById('bt-dd-loss-baht').innerText = state.balancePrivacyHidden
    ? `-${state.currencySymbol} ••••••`
    : `-${formatMoney(lossBaht, moneyDec, true)}`;
  document.getElementById('bt-dd-loss-pct').innerText = `คิดเป็น -${mddPctAbs}% จากจุดสูงสุดในอดีต`;

  document.getElementById('bt-dd-remaining-baht').innerText = maskIfPrivate(formatMoney(remainingBaht, moneyDec, true), true);
  const remSubEl = document.getElementById('bt-dd-remaining-sub');
  if (remSubEl) {
    remSubEl.innerText = `คงเหลือ ${keepPct}% ของจุดสูงสุด`;
  }

  const periodEl = document.getElementById('bt-dd-period');
  const recEl = document.getElementById('bt-dd-recovery');
  if (dd.peak_date && dd.trough_date) {
    periodEl.innerText = `${dd.peak_date} ➔ ${dd.trough_date}`;
  } else {
    periodEl.innerText = `${data.metadata.start_date} ➔ ${data.metadata.end_date}`;
  }
  if (dd.recovery_days !== null && dd.recovery_days !== undefined) {
    recEl.innerHTML = `ฟื้นตัวกลับจุดสูงสุดเดิมใน ${dd.recovery_days.toLocaleString()} วัน <span class="whitespace-nowrap">(${escapeHtmlText(dd.recovery_date || '-')})</span>`;
    recEl.classList.remove('hidden');
  } else {
    recEl.innerText = 'ยังไม่ฟื้นตัวกลับจุดสูงสุดเดิมในช่วงข้อมูลนี้';
    recEl.classList.remove('hidden');
  }

  document.getElementById('bt-bar-keep-label').innerText = `${maskIfPrivate(formatMoney(remainingBaht, moneyDec, true), true)} (${keepPct}%)`;
  document.getElementById('bt-bar-lose-label').innerText = state.balancePrivacyHidden
    ? `-${state.currencySymbol} •••••• (-${mddPctAbs}%)`
    : `-${formatMoney(lossBaht, moneyDec, true)} (-${mddPctAbs}%)`;
  document.getElementById('bt-bar-keep-fill').style.width = `${keepPct}%`;
  document.getElementById('bt-bar-lose-fill').style.width = `${100 - Number(keepPct)}%`;

  const stressNoteEl = document.getElementById('bt-dd-worst-timing-note');
  if (stressNoteEl) {
    const budgetTxt = maskIfPrivate(formatMoney(budget, 0, true), true);
    const scaledLossTxt = state.balancePrivacyHidden ? `${state.currencySymbol} ••••••` : formatMoney(scaledLoss, 0, true);
    const scaledRemTxt = maskIfPrivate(formatMoney(scaledRemaining, 0, true), true);
    stressNoteEl.innerHTML = `<span class="font-semibold text-slate-700">จำลองเทียบเงินต้น:</span> หากเข้าลงทุนเงินต้น <span class="font-mono font-semibold text-slate-900">${budgetTxt}</span> ตรงจุดสูงสุดพอดี จะย่อตัวราว <span class="font-mono font-semibold text-rose-600">-${scaledLossTxt}</span> เหลือประมาณ <span class="font-mono font-semibold text-emerald-700">${scaledRemTxt}</span>`;
  }

  // Actionable Stress-Test Bridge: compare active strategy MDD vs safer alternatives (Min Vol / HRP)
  const saferBoxEl = document.getElementById('bt-stress-safer-plan-box');
  if (saferBoxEl) {
    const activeMddNum = Math.abs(Number(strat.max_drawdown || 0) * 100);
    const candidates = [
      { key: 'min_volatility', label: 'ผันผวนต่ำ (Min Volatility)' },
      { key: 'hrp', label: 'กระจายเสี่ยงสมดุล (HRP)' }
    ].filter(c => c.key !== state.activeGoal && data.strategies?.[c.key]);

    let bestSafer = null;
    candidates.forEach(c => {
      const mddVal = Math.abs(Number(data.strategies[c.key].max_drawdown || 0) * 100);
      if (!bestSafer || mddVal < bestSafer.mddVal) {
        bestSafer = { ...c, mddVal };
      }
    });

    if (bestSafer && (activeMddNum - bestSafer.mddVal) >= 2.0) {
      const diffPts = (activeMddNum - bestSafer.mddVal).toFixed(1);
      saferBoxEl.className = 'p-3.5 rounded-xl bg-slate-50 border border-slate-200/90 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 text-xs';
      saferBoxEl.innerHTML = `
        <div class="text-slate-700 leading-relaxed">
          <span class="font-semibold text-slate-900">รับการย่อตัว -${activeMddNum.toFixed(1)}% ไม่ไหว?</span>
          แผน <b>${escapeHtmlText(bestSafer.label)}</b> เคยย่อตัวน้อยกว่าที่ <span class="font-mono font-bold qf-primary-text">-${bestSafer.mddVal.toFixed(1)}%</span> (ลดความเสี่ยงช่วงวิกฤตลง ${diffPts}%)
        </div>
        <button type="button" onclick="selectGoal('${bestSafer.key}')" class="shrink-0 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold transition cursor-pointer whitespace-nowrap self-start sm:self-center">
          ลองสลับดูแผน${escapeHtmlText(bestSafer.key === 'min_volatility' ? 'ผันผวนต่ำ' : 'กระจายสมดุล')} ➔
        </button>
      `;
      saferBoxEl.classList.remove('hidden');
    } else {
      saferBoxEl.classList.add('hidden');
      saferBoxEl.innerHTML = '';
    }
  }
}

function switchBacktestChartMode(mode) {
  state.backtestChartMode = mode;
  const btnWealth = document.getElementById('btn-bt-chart-wealth');
  const btnDd = document.getElementById('btn-bt-chart-drawdown');

  if (btnWealth && btnDd) {
    const activeCls = 'qf-seg-btn qf-seg-active px-3 py-1 rounded-lg font-semibold transition cursor-pointer';
    const inactiveCls = 'qf-seg-btn qf-seg-inactive px-3 py-1 rounded-lg font-medium transition cursor-pointer';
    btnWealth.className = mode === 'wealth' ? activeCls : inactiveCls;
    btnDd.className = mode === 'wealth' ? inactiveCls : activeCls;
  }

  renderPortfolioGrowthChart();
}

// Tab 1: Portfolio Growth Simulation OR Drawdown Chart (Privacy-Safe + Dark Mode Fixed + 3-Pill OOS Summary)
function renderPortfolioGrowthChart() {
  const data = state.optData;
  if (!data || !data.portfolio_growth) return;

  const container = document.getElementById('portfolio-growth-chart');
  const pg = data.portfolio_growth;
  const sym = state.currencySymbol;
  const unit = state.currencyUnitText;
  const budget = Number(data.metadata.budget) || 100000;
  const isPrivate = !!state.balancePrivacyHidden;

  const namesMap = {
    max_sharpe: 'คุ้มความเสี่ยง (ข้อมูลรวม)',
    min_volatility: 'ผันผวนต่ำ (ข้อมูลรวม)',
    hrp: 'กระจายสมดุล (ข้อมูลรวม)',
    equal_weight: 'แบ่งเท่ากัน (1/N)'
  };
  const shortNamesMap = {
    max_sharpe: 'คุ้มความเสี่ยง',
    min_volatility: 'ผันผวนต่ำ',
    hrp: 'กระจายสมดุล',
    equal_weight: 'แบ่งเท่ากัน'
  };

  // Render 3-Pill Backtest Summary Strip (Active In-Sample vs Out-of-Sample vs Equal Weight 1/N)
  const summaryStripEl = document.getElementById('bt-growth-summary-strip');
  if (summaryStripEl) {
    const activeSeries = pg.series?.[state.activeGoal] || [];
    const activeWf = pg.walk_forward_series?.[state.activeGoal] || [];
    const eqSeries = pg.series?.equal_weight || [];

    const inSampleFinal = activeSeries.length ? Number(activeSeries[activeSeries.length - 1]) : budget;
    const oosFinal = activeWf.length ? Number(activeWf[activeWf.length - 1]) : inSampleFinal;
    const eqFinal = eqSeries.length ? Number(eqSeries[eqSeries.length - 1]) : budget;

    const inSamplePct = ((inSampleFinal - budget) / Math.max(1, budget)) * 100;
    const oosPct = ((oosFinal - budget) / Math.max(1, budget)) * 100;
    const eqPct = ((eqFinal - budget) / Math.max(1, budget)) * 100;
    const diffVsEqPct = inSamplePct - eqPct;

    const fmtPct = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
    const activeLabel = shortNamesMap[state.activeGoal] || state.activeGoal;

    summaryStripEl.innerHTML = `
      <div class="px-3.5 py-2.5 rounded-2xl bg-emerald-50/35 border border-emerald-200 min-w-0">
        <div class="text-[11px] font-semibold text-emerald-800 truncate">${activeLabel} (ข้อมูลรวม)</div>
        <div class="flex items-baseline justify-between gap-2 mt-0.5 flex-wrap">
          <span class="font-mono text-sm sm:text-[15px] font-bold text-slate-900 tabular-nums">${maskIfPrivate(formatMoney(inSampleFinal, 0, true), true)}</span>
          <span class="font-mono text-xs font-bold ${inSamplePct >= 0 ? 'text-emerald-700' : 'text-rose-600'} tabular-nums">${fmtPct(inSamplePct)}</span>
        </div>
      </div>
      <div class="px-3.5 py-2.5 rounded-2xl bg-slate-50 border border-slate-200 min-w-0">
        <div class="text-[11px] font-semibold text-slate-600 truncate">ทดสอบจริงไม่รู้อนาคต (${activeLabel})</div>
        <div class="flex items-baseline justify-between gap-2 mt-0.5 flex-wrap">
          <span class="font-mono text-sm sm:text-[15px] font-bold text-slate-900 tabular-nums">${maskIfPrivate(formatMoney(oosFinal, 0, true), true)}</span>
          <span class="font-mono text-xs font-bold ${oosPct >= 0 ? 'text-emerald-700' : 'text-rose-600'} tabular-nums">${fmtPct(oosPct)}</span>
        </div>
      </div>
      <div class="px-3.5 py-2.5 rounded-2xl bg-slate-50 border border-slate-200 min-w-0">
        <div class="text-[11px] font-semibold text-slate-600 truncate">เทียบแบ่งเท่ากันทุกตัว (1/N)</div>
        <div class="flex items-baseline justify-between gap-2 mt-0.5 flex-wrap">
          <span class="font-mono text-sm sm:text-[15px] font-bold text-slate-900 tabular-nums">${maskIfPrivate(formatMoney(eqFinal, 0, true), true)}</span>
          <span class="font-mono text-xs font-bold ${diffVsEqPct >= 0 ? 'text-emerald-700' : 'text-rose-600'} tabular-nums">${state.activeGoal === 'equal_weight' ? fmtPct(eqPct) : (diffVsEqPct >= 0 ? `แผนนี้ชนะ 1/N (${fmtPct(diffVsEqPct)})` : `แผนนี้แพ้ 1/N (${fmtPct(diffVsEqPct)})`)}</span>
        </div>
      </div>
    `;
  }

  const isDrawdownMode = state.backtestChartMode === 'drawdown' && pg.drawdown_amount_series;
  const sourceSeries = isDrawdownMode ? pg.drawdown_amount_series : pg.series;

  const toPctSeries = (key, arr) => {
    if (!Array.isArray(arr)) return [];
    if (!isDrawdownMode) {
      return arr.map(v => Number((((Number(v) - budget) / Math.max(1, budget)) * 100).toFixed(2)));
    }
    const wealthArr = pg.series?.[key] || [];
    return arr.map((ddVal, idx) => {
      const wv = Number(wealthArr[idx] ?? budget);
      const dd = Number(ddVal || 0);
      const exactPeak = Math.max(1, wv - dd);
      return Number(((dd / exactPeak) * 100).toFixed(2));
    });
  };

  let minDrawdownVal = 0;
  let minWealthVal = Infinity;
  let maxWealthVal = -Infinity;
  const traces = Object.keys(sourceSeries).map(key => {
    const isSelected = key === state.activeGoal;
    const yVals = isPrivate ? toPctSeries(key, sourceSeries[key]) : sourceSeries[key];
    if (Array.isArray(yVals)) {
      yVals.forEach(v => {
        const nv = Number(v);
        if (!Number.isFinite(nv)) return;
        if (isDrawdownMode) {
          if (nv < minDrawdownVal) minDrawdownVal = nv;
        } else {
          if (nv < minWealthVal) minWealthVal = nv;
          if (nv > maxWealthVal) maxWealthVal = nv;
        }
      });
    }
    return {
      x: pg.dates,
      y: yVals,
      mode: 'lines',
      fill: isDrawdownMode && isSelected ? 'tozeroy' : 'none',
      fillcolor: isDrawdownMode && isSelected ? 'rgba(225, 29, 72, 0.11)' : undefined,
      name: namesMap[key] || key,
      line: {
        color: STRATEGY_COLORS[key],
        width: isSelected ? 3 : 1.45,
        dash: key === 'equal_weight' ? 'dot' : 'solid'
      },
      opacity: isSelected ? 1.0 : 0.44,
      hovertemplate: isPrivate
        ? (isDrawdownMode
            ? `<b>${namesMap[key]}</b><br>ย่อตัวจากจุดสูงสุด: %{y:.2f}%<extra></extra>`
            : `<b>${namesMap[key]}</b><br>ผลตอบแทนสะสม: %{y:+.2f}%<extra></extra>`)
        : (isDrawdownMode
            ? `<b>${namesMap[key]}</b><br>ย่อตัวจากจุดสูงสุด: %{y:,.0f} ${unit}<extra></extra>`
            : `<b>${namesMap[key]}</b><br>มูลค่าพอร์ต: ${sym}%{y:,.0f} (${unit})<extra></extra>`)
    };
  });

  const ct = getChartThemeTokens();
  // Out-of-Sample Rebalanced overlay from pg.walk_forward_series[activeGoal]
  const wfSeries = pg.walk_forward_series?.[state.activeGoal];
  const wfEqSeries = pg.walk_forward_series?.equal_weight;
  let splitDate = null;
  if (!isDrawdownMode && Array.isArray(pg.dates) && Array.isArray(wfSeries) && wfSeries.length > 0) {
    const wfDates = pg.dates.slice(0, wfSeries.length);
    let splitIdx = Math.min(Math.max(1, Math.floor(wfSeries.length / 3)), Math.max(0, wfSeries.length - 2));
    // Detect exact divergence index from 1/N warm-up phase when available
    if (Array.isArray(wfEqSeries) && wfEqSeries.length === wfSeries.length) {
      const refSeries = state.activeGoal !== 'equal_weight' ? wfSeries : (pg.walk_forward_series?.max_sharpe || wfSeries);
      for (let i = 1; i < refSeries.length - 1; i++) {
        if (Math.abs(Number(refSeries[i]) - Number(wfEqSeries[i])) > 0.05) {
          splitIdx = Math.max(1, i - 1);
          break;
        }
      }
    }
    splitDate = wfDates[splitIdx] || null;
    const wfYVals = isPrivate ? toPctSeries(state.activeGoal, wfSeries) : wfSeries;
    if (Array.isArray(wfYVals)) {
      wfYVals.forEach(v => {
        const nv = Number(v);
        if (!Number.isFinite(nv)) return;
        if (nv < minWealthVal) minWealthVal = nv;
        if (nv > maxWealthVal) maxWealthVal = nv;
      });
    }
    traces.push({
      x: wfDates,
      y: wfYVals,
      mode: 'lines',
      name: `ทดสอบจริง (${shortNamesMap[state.activeGoal] || state.activeGoal})`,
      line: { color: ct.wfLine, width: 2.5, dash: 'dashdot' },
      hovertemplate: isPrivate
        ? `<b>ทดสอบเสมือนจริงแบบไม่รู้อนาคต</b><br>ผลตอบแทนสะสม: %{y:+.2f}%<extra></extra>`
        : `<b>ทดสอบเสมือนจริงแบบไม่รู้อนาคต</b><br>มูลค่าพอร์ตช่วงทดสอบจริง: ${sym}%{y:,.0f} (${unit})<extra></extra>`
    });
  }

  const shapes = (!isDrawdownMode && splitDate && pg.dates.length > 0)
    ? [
        {
          type: 'line',
          x0: splitDate,
          x1: splitDate,
          y0: 0,
          y1: 1,
          xref: 'x',
          yref: 'paper',
          line: { color: ct.axisText, width: 1.2, dash: 'dot' }
        },
        {
          type: 'rect',
          x0: pg.dates[0],
          x1: splitDate,
          y0: 0,
          y1: 1,
          xref: 'x',
          yref: 'paper',
          fillcolor: ct.dark ? 'rgba(148, 163, 184, 0.10)' : 'rgba(148, 163, 184, 0.08)',
          line: { width: 0 }
        }
      ]
    : [];

  const annotations = (!isDrawdownMode && splitDate)
    ? [{
        x: splitDate,
        y: 0.96,
        xref: 'x',
        yref: 'paper',
        text: 'เริ่มช่วงทดสอบจริง ➔',
        showarrow: false,
        xanchor: 'left',
        yanchor: 'top',
        bgcolor: ct.dark ? 'rgba(17, 22, 32, 0.92)' : 'rgba(255, 255, 255, 0.92)',
        bordercolor: ct.line,
        borderwidth: 1,
        borderpad: 4,
        font: { size: 10.5, color: ct.legendText }
      }]
    : [];

  const yAxisCfg = {
    title: isPrivate
      ? (isDrawdownMode ? 'ย่อตัวจากจุดสูงสุด (%)' : 'ผลตอบแทนสะสม (%)')
      : (isDrawdownMode ? `มูลค่าที่ย่อตัว (${unit})` : `มูลค่าพอร์ต (${unit})`),
    gridcolor: ct.grid,
    linecolor: ct.line,
    color: isDrawdownMode ? '#FF6B70' : ct.axisText,
    automargin: true
  };
  if (isPrivate) {
    yAxisCfg.ticksuffix = '%';
    if (!isDrawdownMode) {
      yAxisCfg.tickformat = '+.0f';
      if (Number.isFinite(minWealthVal) && Number.isFinite(maxWealthVal) && maxWealthVal > minWealthVal) {
        const pad = Math.max(2, (maxWealthVal - minWealthVal) * 0.08);
        yAxisCfg.range = [minWealthVal - pad * 0.6, maxWealthVal + pad];
      }
    }
  } else if (isDrawdownMode) {
    // Avoid awkward "฿-5k" formatting; clear unit already shown in axis title & hover
    yAxisCfg.tickformat = ',.0f';
    if (minDrawdownVal < 0) {
      yAxisCfg.range = [minDrawdownVal * 1.12, Math.abs(minDrawdownVal) * 0.05];
    }
  } else {
    yAxisCfg.tickprefix = sym;
    if (Number.isFinite(minWealthVal) && Number.isFinite(maxWealthVal) && maxWealthVal > minWealthVal) {
      const pad = (maxWealthVal - minWealthVal) * 0.08;
      yAxisCfg.range = [Math.max(0, minWealthVal - pad * 0.5), maxWealthVal + pad];
    }
  }

  const layout = {
    paper_bgcolor: 'transparent',
    plot_bgcolor: ct.plotBg,
    hoverlabel: ct.hoverLabel,
    margin: { l: isMobileViewport() ? 52 : 76, r: 16, t: isMobileViewport() ? 72 : 66, b: 40 },
    dragmode: isMobileViewport() ? false : 'zoom',
    shapes,
    annotations,
    xaxis: {
      gridcolor: ct.grid,
      linecolor: ct.line,
      color: ct.axisText
    },
    yaxis: yAxisCfg,
    legend: {
      orientation: 'h',
      x: 0,
      y: 1.03,
      yanchor: 'bottom',
      font: { size: isMobileViewport() ? 10 : 11, color: ct.legendText }
    },
    hovermode: isMobileViewport() ? 'closest' : 'x unified'
  };

  Plotly.newPlot(container, traces, layout, getPlotlyConfig());
}

function renderStrategyCompareTable() {
  const data = state.optData;
  if (!data) return;

  const tbody = document.getElementById('strategy-compare-table-body');
  const budget = Number(data.metadata.budget) || 100000;
  const order = ['max_sharpe', 'min_volatility', 'hrp', 'equal_weight'];
  const thaiStrategyLabel = {
    max_sharpe: 'คุ้มความเสี่ยง (Max Sharpe)',
    min_volatility: 'ผันผวนต่ำ (Min Vol)',
    hrp: 'กระจายสมดุล (HRP)',
    equal_weight: 'แบ่งเท่ากัน (1/N)'
  };

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
    const annualProfitTxt = maskIfPrivate(formatMoney(budget * s.expected_return, 0, true), true);
    const mddBahtTxt = state.balancePrivacyHidden ? `${state.currencySymbol} ••••••` : formatMoney(mddBaht, 0, true);
    const minRemTxt = maskIfPrivate(formatMoney(minRemBaht, 0, false));
    const finalValTxt = maskIfPrivate(formatMoney(s.final_historical_value, 0, false));

    return `
      <tr class="${rowBg}">
        <td class="py-2.5 px-2.5 font-sans">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background-color: ${STRATEGY_COLORS[key]}"></span>
            <span class="font-bold text-slate-900">${thaiStrategyLabel[key] || s.short_name}</span>
            ${isSelected ? `<span class="text-[10px] font-semibold px-1.5 py-0.5 rounded-md qf-kpi-tag-emerald border whitespace-nowrap">เลือกอยู่</span>` : ''}
          </div>
        </td>
        <td class="py-2.5 px-2.5 text-right tabular-nums whitespace-nowrap">
          <div class="font-bold ${s.expected_return >= 0 ? 'qf-primary-text' : 'qf-kpi-rose-text'}">${(s.expected_return * 100).toFixed(2)}%</div>
          <div class="text-[10px] text-slate-500">~${annualProfitTxt}/ปี</div>
        </td>
        <td class="py-2.5 px-2.5 text-right text-slate-700 font-semibold tabular-nums whitespace-nowrap">${(s.volatility * 100).toFixed(2)}%</td>
        <td class="py-2.5 px-2.5 text-right tabular-nums">
          <div class="font-bold qf-kpi-rose-text whitespace-nowrap">-${mddBahtTxt}</div>
          <div class="text-[10px] text-slate-500 leading-tight whitespace-nowrap">${(s.max_drawdown * 100).toFixed(1)}% • จุดต่ำสุด ${minRemTxt}</div>
        </td>
        <td class="py-2.5 px-2.5 text-right font-bold text-blue-700 tabular-nums whitespace-nowrap">${s.sharpe_ratio.toFixed(2)}</td>
        <td class="py-2.5 px-2.5 text-right font-bold text-slate-900 tabular-nums whitespace-nowrap">${finalValTxt}</td>
        <td class="py-2.5 px-2.5 text-center font-sans whitespace-nowrap">
          ${isSelected
            ? `<span class="dime-pill-up whitespace-nowrap">แสดงผลอยู่</span>`
            : `<button onclick="selectGoal('${key}')" class="px-2.5 py-1 text-[11px] font-bold bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 rounded-xl transition cursor-pointer whitespace-nowrap">เลือกพอร์ตนี้</button>`
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

  const ct = getChartThemeTokens();
  const primaryChartGreen = isDarkTheme() ? '#10B981' : '#059669';
  if (ef.curve && ef.curve.length > 0) {
    traces.push({
      x: ef.curve.map(p => p.vol),
      y: ef.curve.map(p => p.ret),
      mode: 'lines',
      name: 'แนวพอร์ตที่คุ้มค่าที่สุด',
      line: { color: primaryChartGreen, width: 2.6 },
      hoverinfo: 'skip'
    });
  }

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
    { key: 'max_sharpe', label: 'คุ้มความเสี่ยง', color: primaryChartGreen, symbol: 'star', size: 15, ax: 44, ay: -34 },
    { key: 'min_volatility', label: 'ผันผวนต่ำ', color: '#2563EB', symbol: 'diamond', size: 13, ax: -44, ay: 28 },
    { key: 'hrp', label: 'กระจายสมดุล', color: '#6366F1', symbol: 'circle', size: 13, ax: -58, ay: -20 },
    { key: 'equal_weight', label: 'แบ่งเท่ากัน', color: '#D97706', symbol: 'square', size: 11, ax: 48, ay: 26 }
  ];

  const frontierAnnotations = [];
  markerConfigs.forEach(cfg => {
    const s = strats[cfg.key];
    traces.push({
      x: [s.volatility],
      y: [s.expected_return],
      mode: 'markers',
      name: cfg.label,
      marker: {
        symbol: cfg.symbol,
        size: cfg.size,
        color: cfg.color,
        line: { color: ct.donutBorder, width: 2 }
      },
      hovertemplate: `<b>${cfg.label}</b><br>ความผันผวน: %{x:.2%}<br>ผลตอบแทนคาดหวัง: %{y:.2%}<br>ความคุ้มค่า (กำไร/เสี่ยง): ${s.sharpe_ratio.toFixed(2)}<extra></extra>`
    });
    frontierAnnotations.push({
      x: s.volatility,
      y: s.expected_return,
      text: `<b>${cfg.label}</b>`,
      showarrow: true,
      arrowhead: 0,
      arrowwidth: 1.2,
      arrowcolor: cfg.color,
      ax: cfg.ax,
      ay: cfg.ay,
      bgcolor: ct.dark ? 'rgba(17, 22, 32, 0.90)' : 'rgba(255, 255, 255, 0.92)',
      bordercolor: cfg.color,
      borderwidth: 1,
      borderpad: 3,
      font: { color: ct.dark ? '#F8FAFC' : '#0F172A', size: 10.5, family: 'Plus Jakarta Sans, Anuphan, sans-serif' }
    });
  });

  const layout = {
    paper_bgcolor: 'transparent',
    plot_bgcolor: ct.plotBg,
    hoverlabel: ct.hoverLabel,
    annotations: frontierAnnotations,
    margin: { l: isMobileViewport() ? 48 : 64, r: isMobileViewport() ? 24 : 36, t: 38, b: 52 },
    dragmode: isMobileViewport() ? false : 'zoom',
    xaxis: {
      title: 'ความผันผวนต่อปี (ความเสี่ยง — ยิ่งซ้ายความเสี่ยงยิ่งต่ำ)',
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
      font: { size: isMobileViewport() ? 10 : 11, color: ct.legendText }
    },
    hovermode: 'closest'
  };

  Plotly.newPlot(container, traces, layout, getPlotlyConfig());
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

    const natCurr = stat.native_currency || (t.endsWith('.BK') ? 'THB' : 'USD');
    const natPx = Number(stat.native_price || stat.latest_price || 0);
    const priceThb = convertNativePrice(natPx, natCurr, 'THB', fx);
    const priceUsd = convertNativePrice(natPx, natCurr, 'USD', fx);
    const displayPx = isTHB ? priceThb : priceUsd;
    const companionPriceHtml = isTHB
      ? `<div class="text-[10px] text-slate-400 font-mono">($${Number(priceUsd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD)</div>`
      : `<div class="text-[10px] text-slate-400 font-mono">(฿${Number(priceThb).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} THB)</div>`;

    const mddBahtTxt = state.balancePrivacyHidden ? `${state.currencySymbol} ••••••` : formatMoney(mddBaht, 0, true);
    const minRemTxt = maskIfPrivate(formatMoney(minRemBaht, 0, false));

    return `
      <tr>
        <td class="py-2.5 px-2.5 font-sans">
          <div class="flex items-center gap-2 min-w-0">
            ${renderStockLogoBadge(t, color, 26)}
            <div class="min-w-0">
              <div class="font-mono font-bold text-slate-900 leading-tight">${escapeHtmlText(t)}</div>
              <div class="text-[10px] text-slate-500 truncate max-w-[130px] xl:max-w-[180px]">${stat.name !== t ? escapeHtmlText(stat.name) : ''}</div>
            </div>
          </div>
        </td>
        <td class="py-2.5 px-2.5 text-right font-semibold text-slate-800 whitespace-nowrap">
          <div>${formatMoney(displayPx, 2, false)}</div>
          ${companionPriceHtml}
        </td>
        <td class="py-2.5 px-2.5 text-right font-bold whitespace-nowrap ${stat.expected_return >= 0 ? 'text-emerald-700' : 'text-rose-700'}">
          ${(stat.expected_return * 100).toFixed(2)}%
        </td>
        <td class="py-2.5 px-2.5 text-right text-slate-700 whitespace-nowrap">${(stat.volatility * 100).toFixed(2)}%</td>
        <td class="py-2.5 px-2.5 text-right bg-rose-50/35 whitespace-nowrap">
          <div class="font-bold text-rose-700">-${mddBahtTxt}</div>
          <div class="text-[10px] text-rose-600 leading-tight">${(stat.max_drawdown * 100).toFixed(1)}% • จุดต่ำสุด ${minRemTxt}</div>
        </td>
        <td class="py-2.5 px-2.5 text-right font-bold whitespace-nowrap ${Number(w) > 0 ? 'text-blue-700' : 'text-slate-400'}">${w}%</td>
      </tr>
    `;
  }).join('');
}

function renderCorrelationAndGrowthPlots() {
  const data = state.optData;
  if (!data) return;

  const corrContainer = document.getElementById('correlation-plot-container');
  const corr = data.correlation;
  const mobile = isMobileViewport();
  const nAssets = Array.isArray(corr?.tickers) ? corr.tickers.length : 0;
  const isDenseMatrix = nAssets >= 19;
  const isMediumMatrix = nAssets >= 13 && nAssets <= 18;

  if (corrContainer) {
    corrContainer.style.minHeight = isDenseMatrix ? (mobile ? '380px' : '490px') : (isMediumMatrix ? (mobile ? '340px' : '430px') : '');
  }

  const ct = getChartThemeTokens();
  const corrTrace = {
    z: corr.matrix,
    x: corr.tickers,
    y: corr.tickers,
    text: corr.matrix.map(row => row.map(v => v.toFixed(2))),
    texttemplate: isDenseMatrix ? '' : '%{text}',
    textfont: {
      family: 'Plus Jakarta Sans, Anuphan, sans-serif',
      size: isMediumMatrix ? (mobile ? 7.5 : 8.5) : (mobile ? 9.5 : 11),
      color: ct.corrText
    },
    type: 'heatmap',
    colorscale: ct.corrScale,
    zmin: -0.2,
    zmax: 1.0,
    showscale: isDenseMatrix,
    colorbar: isDenseMatrix ? {
      thickness: 10,
      len: 0.85,
      tickfont: { family: 'Plus Jakarta Sans, Anuphan, sans-serif', size: 9.5, color: ct.axisText }
    } : undefined,
    hovertemplate: '<b>%{x} vs %{y}</b><br>ความสัมพันธ์: %{z:.2f}<extra></extra>'
  };

  const corrLayout = {
    paper_bgcolor: 'transparent',
    plot_bgcolor: ct.plotBg,
    hoverlabel: ct.hoverLabel,
    dragmode: mobile ? false : 'zoom',
    margin: {
      l: mobile ? 56 : (isDenseMatrix ? 68 : 62),
      r: isDenseMatrix ? 42 : 14,
      t: 14,
      b: mobile ? 66 : (isDenseMatrix ? 68 : (isMediumMatrix ? 58 : 42))
    },
    xaxis: {
      color: ct.axisText,
      tickangle: isDenseMatrix ? -45 : (isMediumMatrix ? -40 : (mobile ? -35 : 0)),
      automargin: true,
      tickfont: {
        family: 'Plus Jakarta Sans, Anuphan, sans-serif',
        size: isDenseMatrix ? (mobile ? 8 : 9) : (isMediumMatrix ? 9.5 : (mobile ? 9.5 : 11)),
        color: ct.axisText
      }
    },
    yaxis: {
      color: ct.axisText,
      automargin: true,
      tickfont: {
        family: 'Plus Jakarta Sans, Anuphan, sans-serif',
        size: isDenseMatrix ? (mobile ? 8 : 9) : (isMediumMatrix ? 9.5 : (mobile ? 9.5 : 11)),
        color: ct.axisText
      },
      autorange: 'reversed'
    }
  };

  Plotly.newPlot(corrContainer, [corrTrace], corrLayout, getPlotlyConfig());

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
    hoverlabel: ct.hoverLabel,
    dragmode: isMobileViewport() ? false : 'zoom',
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
    hovermode: isMobileViewport() ? 'closest' : 'x unified'
  };

  Plotly.newPlot(container, traces, layout, getPlotlyConfig());
}

function toggleGrowthScale(isLog) {
  state.growthLogScale = isLog;
  const activeCls = 'qf-seg-btn qf-seg-active px-2.5 py-1 rounded-lg font-semibold cursor-pointer';
  const inactiveCls = 'qf-seg-btn qf-seg-inactive px-2.5 py-1 rounded-lg font-medium cursor-pointer';
  const btnLog = document.getElementById('btn-scale-log');
  const btnLin = document.getElementById('btn-scale-linear');
  if (btnLog) btnLog.className = isLog ? activeCls : inactiveCls;
  if (btnLin) btnLin.className = !isLog ? activeCls : inactiveCls;

  renderGrowth100Plot();
}

// Copy & Export Rebalance Order Sheet
function copyOrderSheet() {
  if (!state.optData || !state.lastRebalancePlan) return;
  const strat = state.optData.strategies[state.activeGoal];
  const plan = state.lastRebalancePlan;
  const mddBaht = strat.max_drawdown_amount || Math.abs(strat.max_drawdown) * plan.totalPortfolioBudget;

  const isWhole = plan.executionUnitMode === 'whole';
  const unitModeLabel = isWhole ? 'จำนวนเต็ม (ปัดลง)' : 'ซื้อเศษหน่วยได้';

  let text = `สรุปแผนการปรับพอร์ตและคำสั่งซื้อ-ขาย — QuantFolio Wealth Analytics\n`;
  text += `กลยุทธ์เป้าหมาย: ${strat.name}\n`;
  text += `มูลค่าพอร์ตรวมที่ใช้คำนวณ: ${formatMoney(plan.totalPortfolioBudget, 2, true)} | โหมดจำนวน: ${unitModeLabel}\n`;
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
      const qtyStr = isWhole ? `${formatShareUnits(s.trade_shares_whole, 0)} หน่วยเต็ม` : `${formatShareUnits(s.trade_shares_fractional, 4)} หน่วย`;
      text += `- ขาย ${s.ticker} (${s.name}): เป็นเงิน ${formatMoney(s.trade_amount, 2, true)} (ประมาณ ${qtyStr})\n`;
    });
    text += `รวมรับเงินจากการขาย: +${formatMoney(plan.totalSellGross, 2, true)}\n`;
    text += `--------------------------------------------------\n`;
  }

  if (plan.buyOrders.length > 0) {
    text += `[ขั้นตอนที่ 2: รายการสั่งซื้อ (BUY)]\n`;
    plan.buyOrders.forEach(b => {
      const qtyStr = isWhole ? `${formatShareUnits(b.trade_shares_whole, 0)} หน่วยเต็ม` : `${formatShareUnits(b.trade_shares_fractional, 4)} หน่วย`;
      text += `- ซื้อ ${b.ticker} (${b.name}): เป็นเงิน ${formatMoney(b.trade_amount, 2, true)} (ประมาณ ${qtyStr} @ ${formatMoney(b.price, 2, false)})\n`;
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
  const escCsv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

  let csv = '\uFEFFSymbol,AssetName,Action,Currency,ExecutionMode,CurrentPrice,CurrentValue,TargetWeightPct,TargetValue,NetOrderAmount,WholeUnitsToTrade,FractionalUnitsToTrade\n';
  plan.items.forEach(item => {
    const signedAmt = item.action === 'SELL' ? -item.trade_amount : item.trade_amount;
    csv += `${escCsv(item.ticker)},${escCsv(item.name)},${escCsv(item.action)},${escCsv(state.currency)},${escCsv(plan.executionUnitMode)},${item.price},${item.current_value},${(item.target_weight * 100).toFixed(2)},${item.target_value},${signedAmt},${item.trade_shares_whole},${item.trade_shares_fractional}\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `QuantFolio_${state.activeGoal}_RebalancePlan.csv`);
  link.click();
  setTimeout(() => window.URL.revokeObjectURL(url), 1000);
}

// Switch Bottom Analytics Tabs (Dime! Segmented Pill Sub-Tabs)
function switchTab(tabId) {
  document.querySelectorAll('.tab-pane').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.className = 'tab-btn qf-seg-btn qf-seg-inactive min-h-[40px] px-3.5 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition cursor-pointer';
  });

  const pane = document.getElementById(`tab-content-${tabId}`);
  const btn = document.getElementById(`tab-btn-${tabId}`);
  if (pane) pane.classList.remove('hidden');
  if (btn) {
    btn.className = 'tab-btn qf-seg-btn qf-seg-active min-h-[40px] px-3.5 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition cursor-pointer';
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

// UI Helpers (Minimal Institutional Progress Card + Top Progress Bar + Skeleton Shimmer)
function setLoadingStageVisual(stageIdx, pct, title, subtitle) {
  const pctBadge = document.getElementById('loading-pct-badge');
  const progFill = document.getElementById('loading-progress-fill');
  const topFill = document.getElementById('qf-top-progress-fill');
  const titleEl = document.getElementById('loading-step-title');
  const subEl = document.getElementById('loading-step-subtitle');

  if (pctBadge) pctBadge.innerText = `${pct}%`;
  if (progFill) progFill.style.width = `${pct}%`;
  if (topFill) topFill.style.width = `${pct}%`;
  if (titleEl && title) titleEl.innerText = title;
  if (subEl && subtitle) subEl.innerText = subtitle;
}

function toggleSkeletonCards(active) {
  ['global-result-strip', 'dime-wealth-overview', 'step-3-execution-card', 'section-market-news', 'section-backtest-analytics'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('qf-skeleton-loading', !!active);
  });
}

function showLoading(show, useCenteredOverlay = false) {
  const card = document.getElementById('loading-card');
  const topBar = document.getElementById('qf-top-progress-bar');
  const btn = document.getElementById('run-optimize-btn');
  const btnLabel = document.getElementById('run-optimize-btn-label');
  const timerEl = document.getElementById('loading-elapsed-timer');

  (state.loadingStepTimers || []).forEach(t => clearTimeout(t));
  state.loadingStepTimers = [];
  if (state.loadingElapsedTimer) {
    clearInterval(state.loadingElapsedTimer);
    state.loadingElapsedTimer = null;
  }

  if (show) {
    state.loadingStartTime = performance.now();
    if (topBar) topBar.classList.remove('hidden');
    if (timerEl) timerEl.innerText = '0.0 วิ';

    if (useCenteredOverlay && card) {
      card.classList.remove('hidden');
    } else if (card) {
      card.classList.add('hidden');
    }

    toggleSkeletonCards(true);
    setLoadingStageVisual(1, 18, 'กำลังดึงราคาตลาดและอัตราแลกเปลี่ยน...', 'อัปเดตข้อมูลราคาปิดล่าสุดและค่าเงิน USD/THB');

    // Smooth asymptotic progress + real elapsed clock
    state.loadingElapsedTimer = setInterval(() => {
      const elapsedSec = (performance.now() - state.loadingStartTime) / 1000;
      if (timerEl) timerEl.innerText = `${elapsedSec.toFixed(1)} วิ`;

      const smoothPct = Math.min(92, Math.round(18 + 74 * (1 - Math.exp(-elapsedSec / 2.2))));
      if (elapsedSec < 0.75) {
        setLoadingStageVisual(1, smoothPct, 'กำลังดึงราคาตลาดและอัตราแลกเปลี่ยน...', 'อัปเดตข้อมูลราคาปิดล่าสุดและค่าเงิน USD/THB');
      } else if (elapsedSec < 1.7) {
        setLoadingStageVisual(2, smoothPct, 'กำลังคำนวณสัดส่วนทั้ง 4 กลยุทธ์...', 'ประมวลผล Max Sharpe, Min Volatility, HRP และ 1/N');
      } else {
        setLoadingStageVisual(3, smoothPct, 'กำลังจัดทำใบสั่งซื้อ–ขายและทดสอบย้อนหลัง...', 'สรุปคำสั่งซื้อ–ขาย สัญญาณตลาด และผลจำลองย้อนหลัง');
      }
    }, 100);

    if (btn) {
      btn.disabled = true;
      btn.classList.add('opacity-70', 'cursor-not-allowed');
    }
    if (btnLabel) {
      btnLabel.innerText = 'กำลังคำนวณพอร์ตล่าสุด...';
    }
  } else {
    const finalElapsed = state.loadingStartTime ? ((performance.now() - state.loadingStartTime) / 1000) : 0;
    if (timerEl && finalElapsed > 0) timerEl.innerText = `${finalElapsed.toFixed(1)} วิ`;
    setLoadingStageVisual(4, 100, 'คำนวณพอร์ตเสร็จสมบูรณ์ ✓', 'พร้อมแสดงผลสัดส่วนและใบสั่งซื้อ-ขายจริง');
    toggleSkeletonCards(false);
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('opacity-70', 'cursor-not-allowed');
    }
    if (btnLabel) {
      btnLabel.innerText = 'คำนวณพอร์ต & ดูผลลัพธ์';
    }
    state.loadingStepTimers.push(setTimeout(() => {
      if (card) card.classList.add('hidden');
      if (topBar) topBar.classList.add('hidden');
    }, 180));
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
  const baseBudget = Number(data.metadata.budget) || totalBudget || 1;
  const budgetScale = baseBudget > 0 ? (totalBudget / baseBudget) : 1;
  const targetMddAmt = strat.max_drawdown_amount !== undefined
    ? Number((Number(strat.max_drawdown_amount) * budgetScale).toFixed(2))
    : (targetMddPct * totalBudget);

  const sharpeDiff = targetSharpe - currSharpe;
  const returnDiffPct = (targetReturn - currReturn) * 100;
  const volDiffPct = (targetVol - currVol) * 100;

  const thStratNames = {
    max_sharpe: 'คุ้มความเสี่ยงสูงสุด',
    min_volatility: 'ผันผวนต่ำ',
    hrp: 'กระจายเสี่ยงสมดุล',
    equal_weight: 'ซื้อหารเท่ากัน (1/N)'
  };
  const thStrat = thStratNames[state.activeGoal] || strat.short_name || strat.name;
  const mddDelta = targetMddAmt - currMddAmt;

  let summaryPill = '';
  if (maxSingleWeight > 0.45) {
    summaryPill = `<span class="px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300 text-[11px] font-bold">เดิมกระจุกที่ ${escapeHtmlText(maxSingleTicker)} ${(maxSingleWeight * 100).toFixed(0)}%</span>`;
  } else if (sharpeDiff > 0.05) {
    summaryPill = `<span class="px-2.5 py-0.5 rounded-full bg-[#E6FBF3] text-[#008A57] border border-[#00D084]/40 text-[11px] font-bold">ปรับแล้วคุ้มค่าขึ้น +${sharpeDiff.toFixed(2)}</span>`;
  } else {
    summaryPill = `<span class="px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200 text-[11px] font-bold">พอร์ตเดิมกระจายสมดุลดี</span>`;
  }

  auditBox.innerHTML = `
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="text-xs font-extrabold text-slate-900">เทียบพอร์ตเดิมของคุณ ➔ พอร์ตเป้าหมาย (${thStrat})</div>
      ${summaryPill}
    </div>
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
      <div class="qf-delta-tile ${returnDiffPct > 0.05 ? 'is-good' : ''} min-w-0">
        <div class="text-[11px] font-semibold text-slate-500 truncate">ผลตอบแทน/ปี</div>
        <div class="mt-1 text-xs sm:text-[13px] font-mono font-bold text-slate-700 tabular-nums truncate">
          ${(currReturn * 100).toFixed(1)}% <span class="text-slate-400">➔</span> <span class="${returnDiffPct >= 0 ? 'text-emerald-700' : 'text-slate-900'}">${(targetReturn * 100).toFixed(1)}%</span>
        </div>
        <div class="text-[11px] mt-0.5 font-semibold ${returnDiffPct >= 0 ? 'text-emerald-700' : 'text-slate-500'} tabular-nums">
          ${returnDiffPct >= 0 ? `+${returnDiffPct.toFixed(1)}%/ปี` : `${returnDiffPct.toFixed(1)}%/ปี`}
        </div>
      </div>

      <div class="qf-delta-tile ${volDiffPct < -0.05 ? 'is-good' : (volDiffPct > 0.05 ? 'is-warn' : '')} min-w-0">
        <div class="text-[11px] font-semibold text-slate-500 truncate">ความผันผวน/ปี</div>
        <div class="mt-1 text-xs sm:text-[13px] font-mono font-bold text-slate-700 tabular-nums truncate">
          ${(currVol * 100).toFixed(1)}% <span class="text-slate-400">➔</span> <span class="text-slate-900">${(targetVol * 100).toFixed(1)}%</span>
        </div>
        <div class="text-[11px] mt-0.5 font-semibold ${volDiffPct <= 0 ? 'text-emerald-700' : 'text-amber-700'} tabular-nums">
          ${volDiffPct <= 0 ? `นิ่งขึ้น ${Math.abs(volDiffPct).toFixed(1)}%` : `แกว่งขึ้น +${volDiffPct.toFixed(1)}%`}
        </div>
      </div>

      <div class="qf-delta-tile ${sharpeDiff > 0.03 ? 'is-good' : ''} min-w-0">
        <div class="text-[11px] font-semibold text-slate-500 truncate">ความคุ้มค่า (Sharpe)</div>
        <div class="mt-1 text-xs sm:text-[13px] font-mono font-bold text-slate-700 tabular-nums truncate">
          ${currSharpe.toFixed(2)} <span class="text-slate-400">➔</span> <span class="text-blue-700">${targetSharpe.toFixed(2)}</span>
        </div>
        <div class="text-[11px] mt-0.5 font-semibold ${sharpeDiff >= 0 ? 'text-emerald-700' : 'text-slate-500'} tabular-nums">
          ${sharpeDiff >= 0 ? `ดีขึ้น +${sharpeDiff.toFixed(2)}` : `${sharpeDiff.toFixed(2)}`}
        </div>
      </div>

      <div class="qf-delta-tile ${mddDelta < -5 ? 'is-good' : (mddDelta > 5 ? 'is-bad' : '')} min-w-0">
        <div class="text-[11px] font-semibold text-slate-500 truncate">ลงหนักสุดประเมิน</div>
        <div class="mt-1 text-xs sm:text-[13px] font-mono font-bold text-rose-700 tabular-nums truncate">
          -${maskIfPrivate(formatMoney(currMddAmt, 0, false))} <span class="text-slate-400">➔</span> -${maskIfPrivate(formatMoney(targetMddAmt, 0, false))}
        </div>
        <div class="text-[11px] mt-0.5 font-semibold ${mddDelta <= 0 ? 'text-emerald-700' : 'text-rose-700'} tabular-nums">
          ${mddDelta <= 0 ? `ลดลง ${maskIfPrivate(formatMoney(Math.abs(mddDelta), 0, false))}` : `ลงลึกขึ้น +${maskIfPrivate(formatMoney(Math.abs(mddDelta), 0, false))}`}
        </div>
      </div>
    </div>
  `;
}

// =========================================================================
// MARKET NEWS SENTIMENT & QUANTITATIVE BUY SIGNAL ENGINE
// =========================================================================
function getBLConfidenceTierLabel(confPct) {
  const pct = Math.max(0, Math.min(100, Math.round(Number(confPct) || 0)));
  if (pct === 0) return 'ยึดฐานสมดุล HRP ล้วน';
  if (pct <= 30) return 'ระมัดระวัง (เชื่อฐานตลาดมาก)';
  if (pct <= 65) return 'สมดุล (ผสมฐานตลาด + มุมมอง)';
  return 'เชื่อมุมมองสูง';
}

function scheduleBLReoptimize(delayMs = 150) {
  clearTimeout(state.blDebounceTimer);
  if (!state.useNewsAdjustment || !state.optData || state.tickers.length < 2) return;
  state.blDebounceTimer = setTimeout(() => {
    runOptimization(false);
  }, delayMs);
}

function handleBLConfidenceInput(valPct) {
  const tierInfo = getActiveUserTierInfo();
  const safeCapPct = Math.round((Number(tierInfo.safeBlConfidenceCap || 0.35)) * 100);
  if (!tierInfo.canCustomizeBlViews) {
    state.blConfidence = Number((safeCapPct / 100).toFixed(2));
    const sliderEl = document.getElementById('bl-confidence-slider');
    if (sliderEl) sliderEl.value = String(safeCapPct);
    const valEl = document.getElementById('bl-confidence-value-label');
    const tierEl = document.getElementById('bl-confidence-tier-pill');
    if (valEl) valEl.innerText = `${safeCapPct}%`;
    if (tierEl) tierEl.innerText = `${safeCapPct}% (ล็อกระดับปลอดภัย Member ฟรี • PRO ปรับอิสระ 0–100%)`;
    refreshAdvancedSummaryLabel();
    return;
  }
  const clampedPct = Math.max(0, Math.min(100, Math.round(Number(valPct) || 0)));
  state.blConfidence = Number((clampedPct / 100).toFixed(2));
  const valEl = document.getElementById('bl-confidence-value-label');
  const tierEl = document.getElementById('bl-confidence-tier-pill');
  if (valEl) valEl.innerText = `${clampedPct}%`;
  if (tierEl) tierEl.innerText = getBLConfidenceTierLabel(clampedPct);
  refreshAdvancedSummaryLabel();
}

function handleBLConfidenceChange(valPct) {
  const tierInfo = getActiveUserTierInfo();
  if (!tierInfo.canCustomizeBlViews) {
    handleBLConfidenceInput(valPct);
    if (typeof window.openProUpgradeModal === 'function') {
      window.openProUpgradeModal(
        'บัญชี Member ฟรีล็อกระดับความเชื่อมั่นข่าวไว้ที่ระดับปลอดภัย 35% อัตโนมัติเพื่อป้องกันข่าวระยะสั้นเหวี่ยงพอร์ตแรงเกินไป อัปเกรดเป็น QuantFolio Pro เพื่อปรับความเชื่อมั่นอิสระ 0%–100%',
        'pro'
      );
    }
    return;
  }
  handleBLConfidenceInput(valPct);
  scheduleBLReoptimize(120);
}

function ensureEditableBLViewsMap() {
  const data = state.optData;
  const bl = data?.black_litterman || {};
  const baseApplied = bl.applied_views || bl.suggested_views || {};
  const nextMap = {};
  (data?.metadata?.tickers || state.tickers || []).forEach(t => {
    if (state.blViews && Number.isFinite(Number(state.blViews[t]))) {
      nextMap[t] = Number(state.blViews[t]);
    } else if (Number.isFinite(Number(baseApplied[t]))) {
      nextMap[t] = Number(baseApplied[t]);
    } else {
      nextMap[t] = 0.0;
    }
  });
  state.blViews = nextMap;
  return nextMap;
}

function setBLAssetView(ticker, deltaPct) {
  if (!ticker) return;
  const tierInfo = getActiveUserTierInfo();
  if (!tierInfo.canCustomizeBlViews) {
    if (typeof window.openProUpgradeModal === 'function') {
      window.openProUpgradeModal(
        'การกำหนดมุมมองผลตอบแทนรายหุ้นด้วยตนเอง (Black-Litterman Custom Views -25% ถึง +25%) สงวนไว้สำหรับสมาชิก QuantFolio Pro และ Advisor Pro',
        'pro'
      );
    }
    return;
  }
  const clampedPct = Math.max(-25, Math.min(25, Number(deltaPct) || 0));
  const map = ensureEditableBLViewsMap();
  map[ticker] = Number((clampedPct / 100).toFixed(4));
  renderNewsAndSignalSection();
  scheduleBLReoptimize(150);
}

function handleBLCustomViewInput(inputEl) {
  if (!inputEl) return;
  const tierInfo = getActiveUserTierInfo();
  if (!tierInfo.canCustomizeBlViews) {
    renderNewsAndSignalSection();
    if (typeof window.openProUpgradeModal === 'function') {
      window.openProUpgradeModal(
        'การกำหนดมุมมองผลตอบแทนรายหุ้นด้วยตนเอง (Black-Litterman Custom Views -25% ถึง +25%) สงวนไว้สำหรับสมาชิก QuantFolio Pro และ Advisor Pro',
        'pro'
      );
    }
    return;
  }
  const ticker = inputEl.dataset.ticker;
  const raw = Number(inputEl.value);
  const clampedPct = Number.isFinite(raw) ? Math.max(-25, Math.min(25, raw)) : 0;
  inputEl.value = clampedPct.toFixed(1);
  setBLAssetView(ticker, clampedPct);
}

function fillBLViewsFromSignals() {
  const tierInfo = getActiveUserTierInfo();
  if (!tierInfo.canViewNews) {
    if (typeof window.openProUpgradeModal === 'function') {
      window.openProUpgradeModal(
        'กรุณาสมัครสมาชิกหรือเข้าสู่ระบบฟรีเพื่อปลดล็อกการวิเคราะห์ข่าวตลาดและปรับพอร์ตตามสัญญาณข่าว',
        'free'
      );
    }
    return;
  }
  state.blViews = null;
  if (!tierInfo.canCustomizeBlViews) {
    state.blConfidence = Number(tierInfo.safeBlConfidenceCap || 0.35);
  } else if (state.blConfidence <= 0) {
    state.blConfidence = 0.50;
  }
  state.useNewsAdjustment = true;
  refreshAdvancedSummaryLabel();
  renderNewsAndSignalSection();
  scheduleBLReoptimize(60);
}

function resetBLViewsNeutral() {
  const tierInfo = getActiveUserTierInfo();
  if (!tierInfo.canCustomizeBlViews) {
    if (typeof window.openProUpgradeModal === 'function') {
      window.openProUpgradeModal(
        'การปรับแต่งหรือรีเซ็ตมุมมองรายหุ้นเอง (Custom BL Views) สงวนไว้สำหรับสมาชิก QuantFolio Pro และ Advisor Pro (บัญชี Member ฟรีใช้ค่าแนะนำอัตโนมัติจากข่าวและสัญญาณเทคนิคที่ความเชื่อมั่นปลอดภัย 35%)',
        'pro'
      );
    }
    return;
  }
  const tickers = state.optData?.metadata?.tickers || state.tickers || [];
  const zeroMap = {};
  tickers.forEach(t => { zeroMap[t] = 0.0; });
  state.blViews = zeroMap;
  renderNewsAndSignalSection();
  scheduleBLReoptimize(60);
}

function focusAssetNewsFeed(ticker) {
  filterInsightsByTicker(ticker || 'ALL');
  const feedEl = document.getElementById('insights-news-feed-card');
  if (feedEl && typeof feedEl.scrollIntoView === 'function') {
    feedEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function renderBlackLittermanControlsPanel() {
  const panel = document.getElementById('bl-controls-panel');
  const data = state.optData;
  if (!panel || !data) return;

  if (!state.useNewsAdjustment) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');

  const tierInfo = getActiveUserTierInfo();
  const bl = data.black_litterman || {};
  const rawConfPct = Math.round((Number.isFinite(state.blConfidence) ? state.blConfidence : Number(bl.confidence ?? 0.5)) * 100);
  const safeCapPct = Math.round((Number(tierInfo.safeBlConfidenceCap || 0.35)) * 100);
  const confPct = tierInfo.canCustomizeBlViews ? rawConfPct : safeCapPct;
  const tierLabel = tierInfo.canCustomizeBlViews
    ? getBLConfidenceTierLabel(confPct)
    : `${safeCapPct}% (ล็อกระดับปลอดภัย Member ฟรี • PRO ปรับอิสระ 0–100%)`;
  const deltaVal = Number(bl.risk_aversion_delta ?? 2.5).toFixed(2);
  const tauVal = Number(bl.tau ?? 0.05).toFixed(2);

  const lockSvgSm = '<svg class="w-3 h-3 inline-block shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';

  panel.innerHTML = `
    <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
      <div class="flex-1 space-y-1.5">
        <div class="flex items-center justify-between gap-2 flex-wrap">
          <div class="flex items-center gap-2 flex-wrap">
            <label for="bl-confidence-slider" class="text-xs sm:text-[13px] font-bold text-slate-900">ระดับความเชื่อมั่นในมุมมอง (Confidence Slider)</label>
            <span class="px-2 py-0.5 rounded-md bg-slate-200/80 text-slate-700 text-[10px] font-semibold" title="Black-Litterman Prior: HRP Equilibrium • δ=${deltaVal} • τ=${tauVal}">ฐานสมดุลความเสี่ยง HRP</span>
            ${!tierInfo.canCustomizeBlViews ? `<button type="button" onclick="openProUpgradeModal('อัปเกรดเป็น QuantFolio Pro เพื่อปลดล็อกการเลื่อนระดับความเชื่อมั่น 0%–100% และตั้งมุมมองรายหุ้นเอง', 'pro')" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-100 hover:bg-amber-200 text-amber-900 border border-amber-300 text-[10px] font-bold transition cursor-pointer">${lockSvgSm}<span>ปลดล็อก PRO</span></button>` : ''}
          </div>
          <div class="flex items-center gap-2">
            <span id="bl-confidence-tier-pill" class="px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 text-[11px] font-semibold">${tierLabel}</span>
            <span id="bl-confidence-value-label" class="font-mono font-extrabold text-sm text-slate-900 min-w-[3.2ch] text-right">${confPct}%</span>
          </div>
        </div>
        <input
          type="range"
          id="bl-confidence-slider"
          min="0"
          max="100"
          step="5"
          value="${confPct}"
          oninput="handleBLConfidenceInput(this.value)"
          onchange="handleBLConfidenceChange(this.value)"
          class="qf-bl-slider w-full accent-[#00D084] cursor-pointer"
        />
        <div class="flex items-center justify-between text-[10px] text-slate-500 font-medium">
          <span>0% (ยึดพอร์ตฐานสมดุลล้วน)</span>
          <span>${tierInfo.canCustomizeBlViews ? '50% (ผสมสมดุล)' : '35% (เพดานปลอดภัย Member ฟรี)'}</span>
          <span>100% (เชื่อมุมมองเต็มที่ • PRO)</span>
        </div>
      </div>

      <div class="flex sm:flex-row lg:flex-col xl:flex-row items-stretch sm:items-center gap-1.5 shrink-0 pt-1 lg:pt-0 lg:pl-3 lg:border-l lg:border-slate-200/80">
        <button type="button" id="btn-bl-autofill" onclick="fillBLViewsFromSignals()" class="px-3 py-1.5 rounded-xl bg-white hover:bg-slate-100 text-slate-800 border border-slate-200 text-xs font-semibold transition cursor-pointer">
          เติมค่าจากข่าว &amp; เทคนิค
        </button>
        <button type="button" id="btn-bl-reset-neutral" onclick="resetBLViewsNeutral()" class="inline-flex items-center justify-center gap-1 px-3 py-1.5 rounded-xl bg-white hover:bg-slate-100 text-slate-600 border border-slate-200 text-xs font-semibold transition cursor-pointer">
          <span>รีเซ็ตเป็นกลาง (0%)</span>${!tierInfo.canCustomizeBlViews ? lockSvgSm : ''}
        </button>
      </div>
    </div>
  `;
}

function toggleNewsSignalAdjustment(enable) {
  const tierInfo = getActiveUserTierInfo();
  if (Boolean(enable) && !tierInfo.canViewNews) {
    state.useNewsAdjustment = false;
    const cb = document.getElementById('news-signal-toggle') || document.getElementById('use-news-adjustment-checkbox');
    if (cb) cb.checked = false;
    if (typeof window.openProUpgradeModal === 'function') {
      window.openProUpgradeModal(
        'กรุณาสมัครสมาชิกหรือเข้าสู่ระบบฟรีเพื่อปลดล็อกการวิเคราะห์ข่าวตลาดและปรับพอร์ตตามสัญญาณข่าว (Black-Litterman)',
        'free'
      );
    }
    return;
  }

  state.useNewsAdjustment = Boolean(enable);
  if (state.useNewsAdjustment && !tierInfo.canCustomizeBlViews) {
    state.blConfidence = Number(tierInfo.safeBlConfidenceCap || 0.35);
    state.blViews = null;
  }

  const cb = document.getElementById('news-signal-toggle') || document.getElementById('use-news-adjustment-checkbox');
  if (cb) cb.checked = state.useNewsAdjustment;

  const btnOn = document.getElementById('btn-news-adj-on');
  const btnOff = document.getElementById('btn-news-adj-off');
  if (btnOn && btnOff) {
    const activeCls = 'qf-seg-btn qf-seg-active px-3.5 py-1.5 rounded-lg font-semibold transition cursor-pointer';
    const inactiveCls = 'qf-seg-btn qf-seg-inactive px-3.5 py-1.5 rounded-lg font-medium transition cursor-pointer';
    btnOn.className = state.useNewsAdjustment ? activeCls : inactiveCls;
    btnOff.className = state.useNewsAdjustment ? inactiveCls : activeCls;
  }

  refreshAdvancedSummaryLabel();
  if (!state.optData) return;

  // Immediate visual feedback on Tab 3 banner, BL panel & per-asset cards before async re-optimization completes
  renderNewsAndSignalSection();

  // Trigger a clean re-optimization so backtest growth, drawdown, and discrete allocations stay 100% consistent
  if (state.tickers.length >= 2) {
    runOptimization(false);
  }
}

function filterInsightsByTicker(ticker = 'ALL') {
  state.insightsSelectedTicker = ticker || 'ALL';
  state.insightsNewsExpanded = false;
  renderNewsAndSignalSection();
}

function toggleInsightsNewsExpand() {
  state.insightsNewsExpanded = !state.insightsNewsExpanded;
  renderNewsAndSignalSection();
}

function buildClientFallbackPulseArticle(stat, dec, tech) {
  const t = stat.ticker;
  const isThai = String(t).endsWith('.BK');
  const mom1m = Number(tech.momentum_1m || 0) * 100;
  const mom3m = Number(tech.momentum_3m || 0) * 100;
  const rsiVal = Number(tech.rsi_14 !== undefined ? tech.rsi_14 : 50);
  const trendLabel = tech.trend_label_th || 'แกว่งตัวในกรอบปกติ';
  const sigLevel = dec.signal_level || 'NEUTRAL_ACCUMULATE';
  const sent = sigLevel === 'POSITIVE_BUY' ? 'positive' : (sigLevel === 'CAUTIOUS_SHIELD' ? 'negative' : 'neutral');
  const sentLabel = sent === 'positive' ? 'สัญญาณราคาเชิงบวก' : (sent === 'negative' ? 'สัญญาณระมัดระวัง' : 'สรุปความเคลื่อนไหวราคา');
  const searchQuery = encodeURIComponent(isThai ? `${t.replace('.BK', '')} หุ้น` : `${t} stock news`);
  return {
    ticker: t,
    title: `สรุปความเคลื่อนไหว ${stat.name || t}: ${trendLabel} (1 เดือน ${mom1m >= 0 ? '+' : ''}${mom1m.toFixed(1)}%, 3 เดือน ${mom3m >= 0 ? '+' : ''}${mom3m.toFixed(1)}%, RSI ${rsiVal.toFixed(0)})`,
    publisher: 'QuantFolio Market Pulse (วิเคราะห์จากราคาตลาดจริง)',
    link: `https://news.google.com/search?q=${searchQuery}&hl=${isThai ? 'th' : 'en-US'}`,
    published_at: stat.latest_price_date || 'ล่าสุด',
    sentiment: sent,
    sentiment_label_th: sentLabel,
    is_market_pulse: true
  };
}

function renderNewsAndSignalSection() {
  const data = state.optData;
  if (!data) return;

  const tierInfo = getActiveUserTierInfo();
  const guestGateEl = document.getElementById('insights-guest-login-gate');
  const newsFeedCardEl = document.getElementById('insights-news-feed-card');
  if (guestGateEl) guestGateEl.classList.toggle('hidden', tierInfo.canViewNews);
  if (newsFeedCardEl) newsFeedCardEl.classList.toggle('hidden', !tierInfo.canViewNews);

  const intel = data.market_intelligence || {};
  const assetIntelMap = intel.assets || {};
  const activeStrat = data.strategies[state.activeGoal] || {};
  const fx = Number(data.metadata?.usd_thb_rate || state.fxRate || 34.50);
  const allStats = data.asset_stats || [];
  const allPortfolioTickers = allStats.map(s => s.ticker);

  // Ensure selected filter ticker is valid for current portfolio
  if (state.insightsSelectedTicker && state.insightsSelectedTicker !== 'ALL' && !allPortfolioTickers.includes(state.insightsSelectedTicker)) {
    state.insightsSelectedTicker = 'ALL';
  }
  const selectedFilter = state.insightsSelectedTicker || 'ALL';

  // Sync toggle buttons & checkbox
  const cb = document.getElementById('news-signal-toggle') || document.getElementById('use-news-adjustment-checkbox');
  if (cb) cb.checked = state.useNewsAdjustment;

  const btnOn = document.getElementById('btn-news-adj-on');
  const btnOff = document.getElementById('btn-news-adj-off');
  if (btnOn && btnOff) {
    const activeCls = 'qf-seg-btn qf-seg-active px-3.5 py-1.5 rounded-lg font-semibold transition cursor-pointer';
    const inactiveCls = 'qf-seg-btn qf-seg-inactive px-3.5 py-1.5 rounded-lg font-medium transition cursor-pointer';
    btnOn.className = state.useNewsAdjustment ? activeCls : inactiveCls;
    btnOff.className = state.useNewsAdjustment ? inactiveCls : activeCls;
  }

  // Truthful strategy-aware news impact metadata
  const isMaxSharpeGoal = state.activeGoal === 'max_sharpe';
  const isNewsActiveOnWeights = Boolean(state.useNewsAdjustment && isMaxSharpeGoal);
  const goalNameThMap = {
    max_sharpe: 'คุ้มความเสี่ยงสูงสุด (Max Sharpe)',
    min_volatility: 'ผันผวนต่ำ (Min Volatility)',
    hrp: 'กระจายเสี่ยงสมดุล (HRP)',
    equal_weight: 'ซื้อหารเท่ากัน (1/N)'
  };
  const activeGoalLabelTh = goalNameThMap[state.activeGoal] || 'แผนที่เลือกอยู่';
  const activeWeightShifts = allStats.map(s => {
    const t = s.ticker;
    const hW = Number(((activeStrat.historical_weights?.[t] ?? activeStrat.weights?.[t] ?? 0) * 100).toFixed(1));
    const nW = Number(((activeStrat.news_adjusted_weights?.[t] ?? activeStrat.weights?.[t] ?? 0) * 100).toFixed(1));
    const diff = Number((nW - hW).toFixed(1));
    return { ticker: t, histW: hW, newsW: nW, diff };
  }).filter(item => Math.abs(item.diff) >= 0.1);

  const blInfo = data.black_litterman || {};
  const blConfPct = Math.round((Number.isFinite(state.blConfidence) ? state.blConfidence : Number(blInfo.confidence ?? 0.5)) * 100);
  const blDeltaStr = Number(blInfo.risk_aversion_delta ?? 2.5).toFixed(2);

  const impactBanner = document.getElementById('insights-news-impact-banner');
  if (impactBanner) {
    if (!state.useNewsAdjustment) {
      impactBanner.dataset.bannerMode = 'historical';
      impactBanner.className = 'qf-news-impact-banner qf-news-impact-historical p-3 sm:p-3.5 rounded-2xl bg-slate-50 border border-slate-200/90 text-xs sm:text-[13px] text-slate-700 leading-relaxed';
      impactBanner.innerHTML = `
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div class="space-y-0.5">
            <div class="font-bold text-slate-900 flex items-center gap-1.5 flex-wrap">
              <span class="px-2 py-0.5 rounded-md bg-slate-200/80 text-slate-800 text-[11px] font-bold">ค่าเริ่มต้น: สถิติราคาปิดย้อนหลังล้วน</span>
              <span>ข่าวไม่เปลี่ยนสัดส่วน % พอร์ต</span>
            </div>
            <p class="text-slate-600">
              สัดส่วน % คำนวณจากราคาปิดย้อนหลังล้วน ข่าวด้านล่างใช้ดูประกอบจังหวะเข้าซื้อเท่านั้น (กดปุ่ม <strong>“Black-Litterman (Max Sharpe)”</strong> ด้านบนหากต้องการปรับสัดส่วนตามมุมมอง)
            </p>
          </div>
        </div>
      `;
    } else if (isMaxSharpeGoal) {
      impactBanner.dataset.bannerMode = 'active_tilt';
      impactBanner.className = 'qf-news-impact-banner qf-news-impact-active p-3 sm:p-3.5 rounded-2xl bg-emerald-50/80 border border-emerald-200 text-xs sm:text-[13px] text-emerald-950 leading-relaxed space-y-1.5';
      const shiftChipsHtml = activeWeightShifts.length > 0
        ? `<div class="flex flex-wrap items-center gap-1.5 pt-0.5">
            <span class="text-[11px] font-semibold text-emerald-800 mr-0.5">สัดส่วนที่เปลี่ยน (สถิติล้วน ➔ BL):</span>
            ${activeWeightShifts.map(item => {
              const safeTick = escapeHtmlText(item.ticker);
              const chipCls = item.diff > 0
                ? 'bg-emerald-100 text-emerald-900 border-emerald-300'
                : 'bg-rose-50 text-rose-800 border-rose-200';
              const sign = item.diff > 0 ? '+' : '';
              return `<span class="px-2 py-0.5 rounded-lg border font-mono text-[11px] font-bold ${chipCls}">${safeTick} ${item.histW.toFixed(1)}% ➔ ${item.newsW.toFixed(1)}% (${sign}${item.diff.toFixed(1)}%)</span>`;
            }).join('')}
          </div>`
        : `<div class="text-[11px] text-emerald-800/90">สัดส่วน Black-Litterman ใกล้เคียงกับสัดส่วนสถิติอดีตล้วน</div>`;
      impactBanner.innerHTML = `
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div class="space-y-1 min-w-0">
            <div class="font-bold text-emerald-950 flex items-center gap-1.5 flex-wrap" title="He-Litterman + Idzorek (2005) • Prior: HRP Equilibrium • δ=${blDeltaStr} • τ=0.05">
              <span class="px-2 py-0.5 rounded-md qf-kpi-tag-emerald border text-[11px] font-bold">กำลังใช้โมเดล Black-Litterman บน Max Sharpe</span>
              <span>ความเชื่อมั่น ${blConfPct}% • อิงพอร์ตฐานสมดุล HRP</span>
            </div>
            <p class="text-emerald-900/90">
              ผสานมุมมองรายตัวที่ท้ายการ์ดด้านล่างเข้ากับพอร์ตฐานสมดุล <strong>เฉพาะแผน Max Sharpe</strong> (ส่วนแผนผันผวนต่ำ, HRP และ 1/N คงสัดส่วนสถิติอดีตล้วน 100%)
            </p>
            ${shiftChipsHtml}
          </div>
          <button type="button" onclick="switchAppTab('trade-plan')" class="shrink-0 px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold transition cursor-pointer whitespace-nowrap self-start sm:self-center">
            ดูใบสั่งซื้อ-ขายที่อัปเดตแล้ว (แท็บ 2) ➔
          </button>
        </div>
      `;
    } else {
      impactBanner.dataset.bannerMode = 'info_only';
      impactBanner.className = 'qf-news-impact-banner qf-news-impact-info p-3 sm:p-3.5 rounded-2xl bg-blue-50/80 border border-blue-200 text-xs sm:text-[13px] text-blue-950 leading-relaxed';
      impactBanner.innerHTML = `
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div class="space-y-0.5">
            <div class="font-bold text-blue-950 flex items-center gap-1.5 flex-wrap">
              <span class="px-2 py-0.5 rounded-md bg-blue-100 text-blue-900 border border-blue-200 text-[11px] font-bold">สัดส่วน % และผลตอบแทนคงที่ (เปลี่ยน 0.0%)</span>
              <span>แผน${escapeHtmlText(activeGoalLabelTh)} ไม่ได้ปรับน้ำหนักจาก Black-Litterman</span>
            </div>
            <p class="text-blue-900/90">
              กลยุทธ์นี้คงสูตรจากราคาปิดย้อนหลังล้วน 100% โหมด Black-Litterman จะมีผลเฉพาะบนแผน Max Sharpe เท่านั้น
            </p>
          </div>
          <button type="button" onclick="selectGoal('max_sharpe')" class="qf-banner-cta-btn shrink-0 px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold transition cursor-pointer inline-flex items-center justify-center gap-1.5 self-start sm:self-center">
            <span>ลองดูผลบน Max Sharpe ➔</span>
          </button>
        </div>
      `;
    }
  }

  // Render Money-Weighted Portfolio Entry Readiness Verdict directly below impact banner
  const tab3Readiness = computePortfolioEntryReadiness(data, state.activeGoal);
  renderPortfolioEntryReadinessBox('insights-portfolio-readiness-card', tab3Readiness, false);

  // Render Sleek Single-Bar Black-Litterman Confidence Slider Panel
  renderBlackLittermanControlsPanel();

  // Compute summary counts across ALL portfolio assets (4 distinct truthful states)
  let posCount = 0;
  let neuCount = 0;
  let overboughtCount = 0;
  let cautCount = 0;
  allStats.forEach(s => {
    const lvl = (s.decision || assetIntelMap[s.ticker] || {}).signal_level || 'NEUTRAL_ACCUMULATE';
    if (lvl === 'POSITIVE_BUY') posCount++;
    else if (lvl === 'OVERBOUGHT_TRANCHE') overboughtCount++;
    else if (lvl === 'CAUTIOUS_SHIELD') cautCount++;
    else neuCount++;
  });
  const posEl = document.getElementById('insights-count-positive');
  const neuEl = document.getElementById('insights-count-neutral');
  const obEl = document.getElementById('insights-count-overbought');
  const cautEl = document.getElementById('insights-count-caution');
  if (posEl) posEl.innerText = String(posCount);
  if (neuEl) neuEl.innerText = String(neuCount);
  if (obEl) obEl.innerText = String(overboughtCount);
  if (cautEl) cautEl.innerText = String(cautCount);

  const covBadge = document.getElementById('insights-stocks-coverage-badge');
  if (covBadge) {
    covBadge.innerText = selectedFilter === 'ALL'
      ? `แสดงครบทั้ง ${allStats.length}/${allStats.length} สินทรัพย์ในพอร์ต (100%)`
      : `กำลังดูเฉพาะ ${selectedFilter} (จาก ${allStats.length} สินทรัพย์ในพอร์ต)`;
  }

  // Render Asset Filter Pill Bar (#insights-ticker-filter-bar)
  const filterBar = document.getElementById('insights-ticker-filter-bar');
  if (filterBar) {
    const allBtnCls = selectedFilter === 'ALL'
      ? 'px-3 py-1 rounded-xl text-xs font-bold bg-slate-900 text-[#00D084] shadow-2xs transition cursor-pointer'
      : 'px-3 py-1 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 transition cursor-pointer';
    const tickerButtonsHtml = allStats.map(s => {
      const safeT = escapeHtmlText(s.ticker);
      const isAct = selectedFilter === s.ticker;
      const cls = isAct
        ? 'px-2.5 py-1 rounded-xl text-xs font-mono font-bold bg-[#00D084] text-[#0A0D12] shadow-2xs transition cursor-pointer'
        : 'px-2.5 py-1 rounded-xl text-xs font-mono font-semibold bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 transition cursor-pointer';
      return `<button type="button" data-ticker="${safeT}" onclick="filterInsightsByTicker(this.dataset.ticker)" class="${cls}">${safeT}</button>`;
    }).join('');
    filterBar.innerHTML = `
      <span class="text-[11px] font-semibold text-slate-500 mr-1">เลือกดูรายสินทรัพย์:</span>
      <button type="button" onclick="filterInsightsByTicker('ALL')" class="${allBtnCls}">ทั้งหมดครบทุกตัว (${allStats.length})</button>
      ${tickerButtonsHtml}
    `;
  }

  // Build guaranteed per-asset articles map & round-robin article list across ALL portfolio assets
  const perTickerArticles = {};
  allStats.forEach(stat => {
    const t = stat.ticker;
    const tech = stat.technical || assetIntelMap[t]?.technical || {};
    const dec = stat.decision || assetIntelMap[t] || {};
    const rawArts = (stat.news && Array.isArray(stat.news.articles) && stat.news.articles.length > 0)
      ? stat.news.articles
      : (intel.articles || []).filter(a => a.ticker === t);
    perTickerArticles[t] = rawArts.length > 0 ? rawArts : [buildClientFallbackPulseArticle(stat, dec, tech)];
  });

  const interleavedArticles = [];
  const maxDepth = Math.max(1, ...allStats.map(s => (perTickerArticles[s.ticker] || []).length));
  for (let pass = 0; pass < maxDepth; pass++) {
    allStats.forEach(s => {
      const list = perTickerArticles[s.ticker] || [];
      if (pass < list.length) {
        interleavedArticles.push(list[pass]);
      }
    });
  }

  const visibleStats = selectedFilter === 'ALL'
    ? allStats
    : allStats.filter(s => s.ticker === selectedFilter);
  const visibleArticles = selectedFilter === 'ALL'
    ? interleavedArticles
    : (perTickerArticles[selectedFilter] || []);

  // Update news count badge & external links when filtered
  const countBadge = document.getElementById('news-count-badge');
  if (countBadge) {
    countBadge.innerText = selectedFilter === 'ALL'
      ? `ครบ ${allStats.length} สินทรัพย์ (${visibleArticles.length} ข่าว)`
      : `ข่าวของ ${selectedFilter} (${visibleArticles.length} รายการ)`;
  }
  const extLinksEl = document.getElementById('insights-news-external-links');
  if (extLinksEl) {
    if (selectedFilter !== 'ALL') {
      const isTh = selectedFilter.endsWith('.BK');
      const gUrl = `https://news.google.com/search?q=${encodeURIComponent(isTh ? selectedFilter.replace('.BK', '') + ' หุ้น' : selectedFilter + ' stock')}&hl=${isTh ? 'th' : 'en-US'}`;
      const yUrl = `https://finance.yahoo.com/quote/${encodeURIComponent(selectedFilter)}`;
      extLinksEl.classList.remove('hidden');
      extLinksEl.innerHTML = `
        <a href="${gUrl}" target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline">Google News ↗</a>
        <span class="text-slate-300">•</span>
        <a href="${yUrl}" target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline">Yahoo Finance ↗</a>
      `;
    } else {
      extLinksEl.classList.add('hidden');
      extLinksEl.innerHTML = '';
    }
  }

  const blPresets = [
    { pct: -4, label: '-4%' },
    { pct: -2, label: '-2%' },
    { pct: 0, label: '0%' },
    { pct: 2, label: '+2%' },
    { pct: 4, label: '+4%' }
  ];
  const blPriorMap = blInfo.prior_returns || {};
  const blPostMap = blInfo.posterior_returns || {};
  const blSuggestedMap = blInfo.suggested_views || {};
  const blAppliedMap = state.blViews || blInfo.applied_views || blSuggestedMap || {};

  // 1. Render Upfront Per-Asset 2-Column Clean Cards (#insights-stock-cards-grid — No Duplicate News)
  const stockCardsGrid = document.getElementById('insights-stock-cards-grid');
  if (stockCardsGrid) {
    stockCardsGrid.innerHTML = visibleStats.map(stat => {
      const t = stat.ticker;
      const safeT = escapeHtmlText(t);
      const safeName = escapeHtmlText(stat.name || t);
      const color = ASSET_COLORS[Math.max(0, (data.metadata?.tickers || []).indexOf(t)) % ASSET_COLORS.length];
      const tech = stat.technical || assetIntelMap[t]?.technical || {};
      const newsObj = stat.news || {};
      const dec = stat.decision || assetIntelMap[t] || {};

      const natCurr = stat.native_currency || (t.endsWith('.BK') ? 'THB' : 'USD');
      const natPx = Number(stat.native_price || stat.latest_price || 0);
      const priceThb = convertNativePrice(natPx, natCurr, 'THB', fx);
      const priceUsd = convertNativePrice(natPx, natCurr, 'USD', fx);

      const histW = ((activeStrat.historical_weights?.[t] ?? activeStrat.weights?.[t] ?? 0) * 100).toFixed(1);
      const newsW = ((activeStrat.news_adjusted_weights?.[t] ?? activeStrat.weights?.[t] ?? 0) * 100).toFixed(1);
      const weightDiffNum = Number((Number(newsW) - Number(histW)).toFixed(1));

      const blViewPct = Number(((Number(blAppliedMap[t] ?? 0)) * 100).toFixed(1));
      const blPriorPct = Number(((Number(blPriorMap[t] ?? stat.expected_return ?? 0)) * 100).toFixed(1));
      const blPostPct = Number(((Number(blPostMap[t] ?? blPriorMap[t] ?? stat.expected_return ?? 0)) * 100).toFixed(1));
      const blSugPct = Number(((Number(blSuggestedMap[t] ?? 0)) * 100).toFixed(1));
      const blViewSign = blViewPct > 0 ? '+' : '';

      let weightImpactText = `ใช้สัดส่วนสถิติ ${histW}%`;
      let weightImpactCls = 'text-slate-800';
      let weightImpactSubText = 'ข่าวใช้ดูประกอบเท่านั้น';
      if (isNewsActiveOnWeights) {
        weightImpactText = weightDiffNum > 0
          ? `เพิ่ม +${weightDiffNum.toFixed(1)}% (${histW}% ➔ ${newsW}%)`
          : weightDiffNum < 0
          ? `ลด ${weightDiffNum.toFixed(1)}% (${histW}% ➔ ${newsW}%)`
          : `คงสัดส่วน ${newsW}%`;
        weightImpactCls = weightDiffNum > 0 ? 'text-emerald-700' : (weightDiffNum < 0 ? 'text-rose-600' : 'text-slate-700');
        weightImpactSubText = `มุมมอง BL: ${blViewSign}${blViewPct.toFixed(1)}%/ปี (ฐาน ${blPriorPct.toFixed(1)}% ➔ หลังปรับ ${blPostPct.toFixed(1)}%)`;
      } else if (!state.useNewsAdjustment) {
        weightImpactText = `ใช้สัดส่วนสถิติ ${histW}%`;
        weightImpactCls = 'text-slate-800';
        if (isMaxSharpeGoal && Math.abs(weightDiffNum) >= 0.1) {
          weightImpactSubText = `ไม่ปรับตามข่าว (ถ้าเปิด BL ➔ ${newsW}%)`;
        } else if (!isMaxSharpeGoal) {
          weightImpactSubText = 'แผนนี้ไม่ปรับ % จากข่าว';
        }
      } else {
        weightImpactText = `คงสัดส่วน ${histW}%`;
        weightImpactCls = 'text-slate-800';
        weightImpactSubText = 'แผนนี้ไม่ปรับ % ตามข่าว';
      }

      const rsiVal = Math.max(5, Math.min(95, Number(tech.rsi_14 !== undefined ? tech.rsi_14 : 50)));
      let rsiPlainZone = 'โซนราคาสมดุลปกติ (ทยอยซื้อได้)';
      let rsiZoneColor = 'text-emerald-700';
      if (rsiVal >= 72) {
        rsiPlainZone = 'โซนราคาร้อนแรง (ระวังไล่ราคา แบ่งไม้ซื้อ)';
        rsiZoneColor = 'text-amber-700';
      } else if (rsiVal <= 32) {
        if (dec.signal_level === 'CAUTIOUS_SHIELD' || tech.trend === 'DOWNTREND') {
          rsiPlainZone = 'ราคาลงลึกเข้าเขตขายมากเกิน (Oversold) แต่แนวโน้มยังขาลง — ควรรอสัญญาณกลับตัวหรือแบ่งไม้เล็กๆ';
          rsiZoneColor = 'text-amber-700';
        } else {
          rsiPlainZone = 'โซนราคาอ่อนตัวลงลึก (จังหวะทยอยสะสมของถูก)';
          rsiZoneColor = 'text-sky-700';
        }
      }

      const mom1mPct = Number(tech.momentum_1m || 0) * 100;
      const mom3mPct = Number(tech.momentum_3m || 0) * 100;
      const trendPlain = tech.trend_status === 'UPTREND'
        ? 'ขาขึ้นชัดเจน'
        : tech.trend_status === 'RECOVERY'
        ? 'กำลังฟื้นตัวระยะสั้น'
        : tech.trend_status === 'DOWNTREND'
        ? 'ขาลงระยะสั้น (รอสร้างฐาน)'
        : 'แกว่งตัวในกรอบ';

      const sentScore = Number(dec.news_sentiment_score ?? newsObj.news_sentiment_score ?? 0);
      const sentPlain = sentScore > 0.12
        ? 'ข่าวเชิงบวกหนุน'
        : sentScore < -0.12
        ? 'มีข่าวกดดันระยะสั้น'
        : 'กระแสข่าวเป็นกลาง';
      const sentTextCls = sentScore > 0.12 ? 'text-emerald-700' : (sentScore < -0.12 ? 'text-rose-600' : 'text-slate-700');

      const signalLevel = dec.signal_level || 'NEUTRAL_ACCUMULATE';
      let badgeCls = 'bg-blue-50 text-blue-800 border-blue-200';
      if (signalLevel === 'POSITIVE_BUY') badgeCls = 'bg-emerald-50 text-emerald-800 border-emerald-200';
      else if (signalLevel === 'OVERBOUGHT_TRANCHE') badgeCls = 'bg-amber-50 text-amber-800 border-amber-200';
      else if (signalLevel === 'CAUTIOUS_SHIELD') badgeCls = 'bg-rose-50 text-rose-800 border-rose-200';

      const stockNewsCount = (perTickerArticles[t] || []).length;

      // Embedded Per-Asset Black-Litterman View Footer (only shown when BL mode is ON)
      let embeddedBlFooterHtml = '';
      if (state.useNewsAdjustment) {
        const postRetCls = blPostPct > blPriorPct + 0.05 ? 'text-emerald-700' : (blPostPct < blPriorPct - 0.05 ? 'text-rose-600' : 'text-slate-800');
        const pillsHtml = blPresets.map(p => {
          const isAct = Math.abs(blViewPct - p.pct) < 0.05;
          let cls = 'qf-bl-view-pill px-2 py-1 rounded-lg text-[11px] font-mono font-semibold border transition cursor-pointer ';
          if (isAct) {
            if (p.pct > 0) cls += 'qf-bl-pill-pos-active bg-emerald-600 text-white border-emerald-600';
            else if (p.pct < 0) cls += 'qf-bl-pill-neg-active bg-rose-600 text-white border-rose-600';
            else cls += 'qf-bl-pill-neu-active bg-slate-900 text-white border-slate-900';
          } else {
            cls += 'bg-white hover:bg-slate-100 text-slate-700 border-slate-200';
          }
          return `<button type="button" data-ticker="${safeT}" data-pct="${p.pct}" onclick="setBLAssetView(this.dataset.ticker, Number(this.dataset.pct))" class="${cls}">${p.label}</button>`;
        }).join('');

        embeddedBlFooterHtml = `
          <div class="qf-bl-asset-row pt-2.5 border-t border-slate-200/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div class="text-[11px] text-slate-600" title="คำแนะนำอัตโนมัติจากข่าว & เทคนิค: ${blSugPct >= 0 ? '+' : ''}${blSugPct.toFixed(1)}%/ปี">
              <span class="font-bold text-slate-800">มุมมอง ${safeT}:</span>
              <span class="font-mono ml-1">ฐาน ${blPriorPct.toFixed(1)}% ➔ <strong class="${postRetCls}">หลังปรับ ${blPostPct.toFixed(1)}%/ปี</strong></span>
            </div>
            <div class="flex items-center gap-1.5 flex-wrap shrink-0">
              <div class="inline-flex items-center gap-1">${pillsHtml}</div>
              <label class="inline-flex items-center gap-1 pl-1.5 border-l border-slate-200 text-[11px] text-slate-500">
                <input
                  type="number"
                  step="0.5"
                  min="-25"
                  max="25"
                  value="${blViewPct.toFixed(1)}"
                  data-ticker="${safeT}"
                  onchange="handleBLCustomViewInput(this)"
                  aria-label="มุมมองส่วนต่างผลตอบแทนรายปีของ ${safeT} (%)"
                  class="qf-bl-custom-input w-14 px-1.5 py-0.5 rounded-lg border border-slate-200 bg-slate-50 text-right font-mono text-xs font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#00D084]/40"
                />
                <span class="font-mono text-[10px]">%</span>
              </label>
            </div>
          </div>
        `;
      }

      return `
        <div class="p-4 rounded-2xl bg-white border border-slate-200/90 shadow-2xs space-y-3 flex flex-col justify-between">
          <div class="space-y-2.5">
            <!-- Row 1: Asset Identity + Price + Plain-Thai Action Verdict Badge -->
            <div class="flex items-start justify-between gap-2 flex-wrap">
              <div class="flex items-center gap-2.5 min-w-0">
                ${renderStockLogoBadge(t, color, 38)}
                <div class="min-w-0">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="font-mono font-bold text-base text-slate-900">${safeT}</span>
                    <span class="text-xs font-mono font-semibold text-slate-600">฿${Number(priceThb).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span class="text-slate-300">|</span> $${Number(priceUsd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  </div>
                  <div class="text-xs text-slate-500 truncate max-w-[220px]">${safeName}</div>
                </div>
              </div>
              <span class="px-2.5 py-1 rounded-full border text-xs font-bold ${badgeCls} shrink-0">
                ${escapeHtmlText(dec.signal_badge_th || 'สมดุล/สะสมตามแผน')}
              </span>
            </div>

            <!-- Row 2: Visual 3-Zone Price Gauge (อ่อนตัว ⇄ ปกติ ⇄ ร้อนแรง) + Quick Filter to News Feed -->
            <div class="p-2.5 rounded-xl bg-slate-50/90 border border-slate-200/70 space-y-1.5">
              <div class="flex items-center justify-between gap-2 text-xs flex-wrap">
                <span class="font-bold ${rsiZoneColor}">${rsiPlainZone}</span>
                <div class="flex items-center gap-2">
                  <span class="font-mono text-[11px] text-slate-500">RSI ${rsiVal.toFixed(0)}</span>
                  ${tierInfo.canViewNews ? `
                  <button type="button" data-ticker="${safeT}" onclick="focusAssetNewsFeed(this.dataset.ticker)" class="text-[11px] font-semibold text-[#008A57] hover:underline cursor-pointer">
                    ดูข่าว (${stockNewsCount}) ↓
                  </button>
                  ` : `
                  <button type="button" onclick="openSupabaseConfigModal('signup')" class="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700 hover:underline cursor-pointer">
                    <svg class="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                    <span>ล็อกอินฟรีดูข่าว</span>
                  </button>
                  `}
                </div>
              </div>
              <div class="relative h-2 w-full rounded-full bg-gradient-to-r from-sky-400 via-emerald-400 to-rose-400">
                <span class="w-3 h-3 rounded-full bg-slate-900 border-2 border-white shadow-sm absolute -top-0.5 -ml-1.5 transition-all" style="left:${rsiVal.toFixed(0)}%;"></span>
              </div>
              <div class="flex items-center justify-between text-[10px] text-slate-500 font-medium">
                <span>อ่อนตัว (น่าสะสม)</span>
                <span>สมดุลปกติ</span>
                <span>ร้อนแรง (ระวังไล่ราคา)</span>
              </div>
            </div>

            <!-- Row 3: 3 Concise Metrics (ทิศทางราคา | กระแสข่าว | ผลต่อพอร์ต) -->
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
              <div class="p-2.5 rounded-xl bg-slate-50 border border-slate-100">
                <div class="text-[11px] text-slate-400">ทิศทางราคา</div>
                <div class="font-bold text-slate-800 mt-0.5 leading-snug">${trendPlain}</div>
                <div class="text-[11px] font-mono text-slate-500 mt-0.5">1ด ${mom1mPct >= 0 ? '+' : ''}${mom1mPct.toFixed(1)}% • 3ด ${mom3mPct >= 0 ? '+' : ''}${mom3mPct.toFixed(1)}%</div>
              </div>
              <div class="p-2.5 rounded-xl bg-slate-50 border border-slate-100">
                <div class="text-[11px] text-slate-400">กระแสข่าวตลาด</div>
                ${tierInfo.canViewNews ? `
                <div class="font-bold ${sentTextCls} mt-0.5">${sentPlain}</div>
                <div class="text-[11px] text-slate-500 mt-0.5">คะแนน ${sentScore >= 0 ? '+' : ''}${sentScore.toFixed(2)} (${stockNewsCount} ข่าว)</div>
                ` : `
                <div class="inline-flex items-center gap-1 font-bold text-amber-700 mt-0.5"><svg class="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg><span>สำหรับสมาชิก (ฟรี)</span></div>
                <button type="button" onclick="openSupabaseConfigModal('signup')" class="text-[11px] font-semibold text-[#008A57] hover:underline mt-0.5 cursor-pointer">เข้าสู่ระบบเพื่อดูข่าว ➔</button>
                `}
              </div>
              <div class="p-2.5 rounded-xl bg-slate-50 border border-slate-100">
                <div class="text-[11px] text-slate-400">ผลต่อสัดส่วนพอร์ต</div>
                <div class="font-bold ${weightImpactCls} mt-0.5 leading-snug">${weightImpactText}</div>
                <div class="text-[11px] text-slate-500 mt-0.5">${weightImpactSubText}</div>
              </div>
            </div>
          </div>

          ${embeddedBlFooterHtml}
        </div>
      `;
    }).join('');
  }

  // 2. Render Asset Signal & Entry Guidance Table (#news-signal-table-body)
  const signalTbody = document.getElementById('news-signal-table-body');
  if (signalTbody) {
    signalTbody.innerHTML = allStats.map(stat => {
      const t = stat.ticker;
      const tech = stat.technical || assetIntelMap[t]?.technical || {};
      const newsObj = stat.news || {};
      const dec = stat.decision || assetIntelMap[t] || {};
      const histW = ((activeStrat.historical_weights?.[t] ?? activeStrat.weights?.[t] ?? 0) * 100).toFixed(1);
      const newsW = ((activeStrat.news_adjusted_weights?.[t] ?? activeStrat.weights?.[t] ?? 0) * 100).toFixed(1);
      const weightDiff = (Number(newsW) - Number(histW)).toFixed(1);

      const natCurr = stat.native_currency || (t.endsWith('.BK') ? 'THB' : 'USD');
      const natPx = Number(stat.native_price || stat.latest_price || 0);
      const priceThb = convertNativePrice(natPx, natCurr, 'THB', fx);
      const priceUsd = convertNativePrice(natPx, natCurr, 'USD', fx);

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

      const diffNum = Number(weightDiff);
      const diffHtml = diffNum > 0
        ? `<span class="text-emerald-700 font-bold">(+${weightDiff}%)</span>`
        : diffNum < 0
        ? `<span class="text-rose-700 font-bold">(${weightDiff}%)</span>`
        : `<span class="text-slate-400">(0.0%)</span>`;

      let tableWeightCellHtml = '';
      if (isNewsActiveOnWeights) {
        tableWeightCellHtml = `
          <div class="text-slate-600">${histW}% ➔ <strong class="text-slate-900">${newsW}%</strong></div>
          <div class="text-[10px]">${diffHtml}</div>
        `;
      } else if (!state.useNewsAdjustment) {
        const previewNote = (isMaxSharpeGoal && Math.abs(diffNum) >= 0.1)
          ? `<span class="text-slate-500 font-sans">ถ้าเปิดข่าว: ${newsW}% (${diffNum > 0 ? '+' : ''}${weightDiff}%)</span>`
          : `<span class="text-slate-400 font-sans">ไม่ปรับตามข่าว</span>`;
        tableWeightCellHtml = `
          <div class="text-slate-900"><strong>${histW}%</strong> <span class="text-[10px] text-slate-400 font-sans">(สถิติล้วน)</span></div>
          <div class="text-[10px]">${previewNote}</div>
        `;
      } else {
        tableWeightCellHtml = `
          <div class="text-slate-900"><strong>${histW}%</strong> <span class="text-[10px] text-slate-400 font-sans">(คงที่)</span></div>
          <div class="text-[10px]"><span class="text-blue-600 font-sans">แผนนี้ไม่ปรับ % จากข่าว</span></div>
        `;
      }

      const mom1mPct = tech.momentum_1m !== undefined ? (tech.momentum_1m * 100) : 0;
      const newsCount = (perTickerArticles[t] ? perTickerArticles[t].length : 0);

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
            <div class="text-[10px] text-slate-500 font-mono">RSI(14): ${tech.rsi_14 !== undefined ? tech.rsi_14.toFixed(1) : '50.0'} | 1ด: ${mom1mPct >= 0 ? '+' : ''}${mom1mPct.toFixed(1)}%</div>
          </td>
          <td class="py-2.5 px-3 text-center font-sans">
            <div>${sentBadge}</div>
            <div class="text-[10px] text-slate-500 mt-0.5">รายการวิเคราะห์: ${newsCount} รายการ</div>
          </td>
          <td class="py-2.5 px-3 text-right font-mono">
            ${tableWeightCellHtml}
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

  // 3. Render Live Market News Articles Grid (Round-Robin with Clean Show-More Pagination)
  const newsGrid = document.getElementById('market-news-articles-grid');
  const toggleWrap = document.getElementById('insights-news-toggle-wrap');
  const toggleBtn = document.getElementById('insights-news-toggle-btn');
  if (!tierInfo.canViewNews) {
    if (newsGrid) newsGrid.innerHTML = '';
    if (toggleWrap) toggleWrap.classList.add('hidden');
    if (window.lucide) lucide.createIcons();
    return;
  }
  if (newsGrid) {
    const initialCollapsedCount = 6;
    const maxExpandedCount = Math.max(12, allStats.length * 4);
    const totalEligible = Math.min(visibleArticles.length, maxExpandedCount);
    const showLimit = state.insightsNewsExpanded
      ? totalEligible
      : Math.min(totalEligible, initialCollapsedCount);
    const displayArts = visibleArticles.slice(0, showLimit);
    if (toggleWrap && toggleBtn) {
      if (totalEligible > initialCollapsedCount) {
        toggleWrap.classList.remove('hidden');
        const hiddenCount = totalEligible - initialCollapsedCount;
        toggleBtn.innerHTML = state.insightsNewsExpanded
          ? `<span>ย่อรายการข่าว</span><i data-lucide="chevron-up" class="w-3.5 h-3.5"></i>`
          : `<span>ดูข่าวเพิ่มเติม (+${hiddenCount} รายการ)</span><i data-lucide="chevron-down" class="w-3.5 h-3.5"></i>`;
      } else {
        toggleWrap.classList.add('hidden');
      }
    }
    if (!displayArts || displayArts.length === 0) {
      newsGrid.innerHTML = `
        <div class="col-span-2 p-4 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-500 text-center">
          ไม่พบหัวข้อข่าวล่าสุดในช่วงเวลานี้ ระบบใช้สัญญาณแนวโน้มราคา (Technical Trend & RSI) เป็นตัวช่วยตัดสินใจหลัก
        </div>
      `;
    } else {
      newsGrid.innerHTML = displayArts.map((art, idx) => {
        const sent = (art.sentiment || art.sentiment_label || 'neutral').toLowerCase();
        const sentPillCls = sent === 'positive'
          ? 'dime-pill-up'
          : sent === 'negative'
          ? 'dime-pill-down'
          : 'px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200 text-xs font-semibold';
        const safeHref = sanitizeExternalUrl(art.link);
        const safeTicker = escapeHtmlText(art.ticker);
        const safePublisher = escapeHtmlText(art.publisher || 'Financial News');
        const safeSentiment = escapeHtmlText(art.sentiment_label_th || 'เป็นกลาง');
        const safeTitle = escapeHtmlText(art.title);
        const safePubAt = escapeHtmlText(art.published_at || 'ล่าสุด');
        const tickerIdx = Math.max(0, (data.metadata?.tickers || []).indexOf(art.ticker));
        const logoHtml = renderStockLogoBadge(art.ticker, ASSET_COLORS[(tickerIdx >= 0 ? tickerIdx : idx) % ASSET_COLORS.length], 34);

        return `
          <a href="${safeHref}" target="_blank" rel="noopener noreferrer"
            class="p-3.5 rounded-2xl bg-white hover:bg-slate-50/90 border border-slate-200/90 transition flex flex-col justify-between gap-2 group">
            <div class="space-y-2">
              <div class="w-full flex items-center justify-between gap-2">
                <div class="flex items-center gap-2 min-w-0">
                  ${logoHtml}
                  <div class="min-w-0">
                    <div class="flex items-center gap-1.5">
                      <span class="font-mono text-xs sm:text-[13px] font-bold text-slate-900">${safeTicker}</span>
                      <span class="text-slate-300">•</span>
                      <span class="text-[11px] text-slate-500 truncate max-w-[160px]">${safePublisher}</span>
                    </div>
                    <div class="text-[10px] text-slate-400">${safePubAt}</div>
                  </div>
                </div>
                <span class="${sentPillCls} shrink-0">${safeSentiment}</span>
              </div>
              <div class="w-full text-sm sm:text-[15px] font-semibold text-slate-900 group-hover:text-[#00A86B] leading-snug line-clamp-2">${safeTitle}</div>
            </div>
            <div class="w-full pt-1.5 border-t border-slate-100 flex items-center justify-end text-xs">
              <span class="text-[#00A86B] font-semibold group-hover:underline">อ่านข่าวต้นฉบับ ↗</span>
            </div>
          </a>
        `;
      }).join('');
    }
  }
  if (window.lucide) lucide.createIcons();
}

async function refreshLiveMarketNews() {
  if (!state.tickers || state.tickers.length === 0) return;
  const tierInfo = getActiveUserTierInfo();
  if (!tierInfo.canViewNews) {
    if (typeof window.openProUpgradeModal === 'function') {
      window.openProUpgradeModal(
        'กรุณาสมัครสมาชิกหรือเข้าสู่ระบบฟรีเพื่อดึงและดูฟีดข่าวตลาดล่าสุดครบทุกสินทรัพย์ในพอร์ต',
        'free'
      );
    }
    return;
  }
  const newsGrid = document.getElementById('market-news-articles-grid');
  const refreshBtn = document.getElementById('btn-refresh-market-news');
  const refreshIcon = document.getElementById('btn-refresh-market-news-icon');
  const refreshLabel = document.getElementById('btn-refresh-market-news-label');
  const newsBadge = document.getElementById('news-count-badge');

  if (refreshBtn) refreshBtn.disabled = true;
  if (refreshIcon) refreshIcon.classList.add('animate-spin');
  if (refreshLabel) refreshLabel.innerText = 'กำลังดึงข่าว...';
  if (newsBadge) {
    newsBadge.innerText = 'กำลังอัปเดตข่าวล่าสุด...';
    newsBadge.className = 'px-2.5 py-1 rounded-full bg-amber-50 text-amber-800 border border-amber-200 text-xs font-semibold';
  }
  if (newsGrid) {
    newsGrid.innerHTML = Array.from({ length: 4 }).map(() => `
      <div class="p-4 rounded-2xl bg-slate-50 border border-slate-200/80 space-y-2.5">
        <div class="flex items-center justify-between gap-2">
          <div class="qf-inline-shimmer h-4 w-24"></div>
          <div class="qf-inline-shimmer h-4 w-16 rounded-full"></div>
        </div>
        <div class="qf-inline-shimmer h-4 w-full"></div>
        <div class="qf-inline-shimmer h-4 w-3/4"></div>
      </div>
    `).join('');
  }
  try {
    const q = encodeURIComponent(state.tickers.join(','));
    const authHeaders = typeof window.getBackendAuthHeaders === 'function' ? window.getBackendAuthHeaders() : {};
    const res = await fetch(`/api/market-news?tickers=${q}&force=true`, { headers: authHeaders });
    if (res.status === 403) {
      let errMsg = 'กรุณาเข้าสู่ระบบฟรีเพื่อดูฟีดข่าวตลาดล่าสุด';
      try {
        const errBody = await res.json();
        if (errBody && errBody.detail) errMsg = errBody.detail;
      } catch (e) {}
      if (typeof window.openProUpgradeModal === 'function') {
        window.openProUpgradeModal(errMsg, 'free');
      }
      return;
    }
    if (!res.ok) throw new Error('ไม่สามารถดึงข่าวตลาดได้');
    const newsData = await res.json();
    if (state.optData) {
      if (state.optData.market_intelligence) {
        state.optData.market_intelligence.articles = newsData.articles || [];
      }
      if (newsData.news && Array.isArray(state.optData.asset_stats)) {
        state.optData.asset_stats.forEach(s => {
          const freshTickerNews = newsData.news[s.ticker];
          if (freshTickerNews) {
            if (Array.isArray(freshTickerNews.articles) && freshTickerNews.articles.length > 0) {
              s.news = freshTickerNews;
            }
            if (typeof freshTickerNews.news_sentiment_score === 'number') {
              if (s.news) s.news.news_sentiment_score = freshTickerNews.news_sentiment_score;
              if (s.decision) s.decision.news_sentiment_score = freshTickerNews.news_sentiment_score;
            }
          }
        });
      }
      renderNewsAndSignalSection();
      showPortfolioToastApp('อัปเดตข่าวตลาดล่าสุดเรียบร้อยแล้ว');
      // If Black-Litterman is active and using automatic news/signal views, re-run optimization to sync weights with fresh news
      if (state.useNewsAdjustment && state.blViews === null && state.tickers.length >= 2) {
        runOptimization(false);
      }
    }
  } catch (err) {
    console.warn('News refresh error:', err);
    if (state.optData) renderNewsAndSignalSection();
  } finally {
    if (refreshBtn) refreshBtn.disabled = false;
    if (refreshIcon) refreshIcon.classList.remove('animate-spin');
    if (refreshLabel) refreshLabel.innerText = 'อัปเดตข่าว';
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

function setAppView(viewName = 'landing', shouldScroll = true) {
  const prevView = state.appView;
  const nextView = viewName === 'workspace' ? 'workspace' : 'landing';
  state.appView = nextView;
  document.body.classList.toggle('qf-view-workspace', nextView === 'workspace');

  const landingEl = document.getElementById('landing-showcase-view');
  const workspaceEl = document.getElementById('main-app-workspace');
  const telemetryEl = document.getElementById('header-workspace-telemetry');
  if (landingEl) {
    landingEl.classList.toggle('hidden', nextView !== 'landing');
  }
  if (workspaceEl) {
    workspaceEl.classList.toggle('hidden', nextView !== 'workspace');
  }
  if (telemetryEl) {
    telemetryEl.classList.toggle('hidden', nextView !== 'workspace');
    telemetryEl.classList.toggle('flex', nextView === 'workspace');
  }
  const workspaceActionsEl = document.getElementById('header-workspace-actions');
  if (workspaceActionsEl) {
    workspaceActionsEl.classList.toggle('hidden', nextView !== 'workspace');
    workspaceActionsEl.classList.toggle('flex', nextView === 'workspace');
  }
  const landingThemeEl = document.getElementById('header-landing-theme-btn');
  if (landingThemeEl) {
    landingThemeEl.classList.toggle('hidden', nextView !== 'landing');
    landingThemeEl.classList.toggle('inline-flex', nextView === 'landing');
  }
  const landingNavEl = document.getElementById('header-landing-nav');
  if (landingNavEl) {
    landingNavEl.classList.add('hidden');
    landingNavEl.classList.remove('xl:flex');
    landingNavEl.classList.toggle('lg:flex', nextView === 'landing');
  }
  const landingCtaEl = document.getElementById('header-landing-cta-btn');
  if (landingCtaEl) {
    // Hidden on Landing Page so the Hero Primary CTA stays the sole focal point
    landingCtaEl.classList.add('hidden');
    landingCtaEl.classList.remove('inline-flex');
  }
  const workspaceFooterEl = document.getElementById('global-workspace-footer');
  if (workspaceFooterEl) {
    workspaceFooterEl.classList.toggle('hidden', nextView !== 'workspace');
  }
  if (nextView === 'landing' && typeof toggleHeaderUtilityMenu === 'function') {
    toggleHeaderUtilityMenu(false);
  }

  const resumeBtn = document.getElementById('landing-resume-results-btn');
  if (resumeBtn) {
    resumeBtn.classList.toggle('hidden', state.resultStatus !== 'ready');
  }

  if (nextView === 'workspace') {
    resizeVisiblePlotlyCharts();
    // Lazy-fetch live quotes once entering Workspace if any selected ticker lacks a live quote
    const missingAnyQuote = state.tickers.some(t => !state.tickerQuotes[t] || state.tickerQuotes[t].price === undefined);
    if (missingAnyQuote && !state.quotesLoading) {
      fetchLiveQuotesForTickers();
    }
    fetchDynamicPopularAssets();
  }
  if (window.lucide) {
    lucide.createIcons();
  }
  if (shouldScroll || (prevView !== nextView && nextView === 'workspace')) {
    window.scrollTo({ top: 0, behavior: 'auto' });
    requestAnimationFrame(() => window.scrollTo(0, 0));
  }
}

function showLandingShowcase() {
  setAppView('landing', true);
}

function switchHeroSampleTab(tabKey = 'frontier') {
  const validKeys = ['frontier', 'backtest', 'orders'];
  const activeKey = validKeys.includes(tabKey) ? tabKey : 'frontier';
  validKeys.forEach(k => {
    const btn = document.getElementById(`hero-sample-tab-${k}`);
    const panel = document.getElementById(`hero-sample-panel-${k}`);
    const isAct = k === activeKey;
    if (btn) {
      btn.setAttribute('aria-selected', isAct ? 'true' : 'false');
      btn.className = isAct
        ? 'qf-sample-tab px-2 py-2 rounded-xl text-xs sm:text-[13px] font-bold bg-white text-slate-900 border border-slate-200/90 shadow-2xs transition cursor-pointer text-center'
        : 'qf-sample-tab px-2 py-2 rounded-xl text-xs sm:text-[13px] font-medium text-slate-600 hover:text-slate-900 border border-transparent transition cursor-pointer text-center';
    }
    if (panel) {
      panel.classList.toggle('hidden', !isAct);
    }
  });
}

const LANDING_RISK_PROFILES = {
  conservative: {
    step: 1,
    badge: 'Conservative',
    titleTh: 'พอร์ตเน้นรักษาเงินต้นและลดความผันผวน',
    subtitleTh: 'ให้น้ำหนักตราสารหนี้และทองคำเป็นแกนหลัก เสริมหุ้นปันผลไทยและสหรัฐฯ เพื่อความมั่นคงในภาวะตลาดผันผวน',
    expectedReturn: '5.4%',
    volatility: '6.2%',
    sharpeRatio: '0.71',
    noteTh: 'กรอบความผันผวนต่ำ เหมาะกับผู้เริ่มต้นและพอร์ตพักเงิน',
    targetStrategy: 'min_volatility',
    targetPreset: 'all_weather',
    targetTickers: ['TLT', 'GLD', 'PTT.BK', 'ADVANC.BK', 'SPY', 'AAPL'],
    allocations: [
      { id: 'bonds', labelEn: 'Bonds', labelTh: 'ตราสารหนี้คุณภาพ (Bonds)', tickers: 'TLT • GOVT', weightPct: 55, color: '#2563EB' },
      { id: 'gold', labelEn: 'Gold', labelTh: 'ทองคำและสินทรัพย์ปลอดภัย (Gold)', tickers: 'GLD', weightPct: 15, color: '#F59E0B' },
      { id: 'thai_eq', labelEn: 'Thai Equities', labelTh: 'หุ้นไทยปันผลมั่นคง (SET50)', tickers: 'ADVANC.BK • PTT.BK', weightPct: 15, color: '#10B981' },
      { id: 'us_eq', labelEn: 'US Equities', labelTh: 'หุ้นขนาดใหญ่สหรัฐฯ (US Core)', tickers: 'SPY • AAPL', weightPct: 15, color: '#6366F1' }
    ],
    newsFeed: [
      { assetClass: 'Bonds', sentiment: 'Positive', headline: 'อัตราผลตอบแทนพันธบัตรรัฐบาลสหรัฐฯ ทรงตัวหนุนแรงซื้อสินทรัพย์ปลอดภัยระยะกลาง', impact: 'หนุนเสถียรภาพพอร์ตตราสารหนี้ (+0.4% Tilt)', timeAgo: '18 นาทีที่แล้ว' },
      { assetClass: 'Gold', sentiment: 'Neutral', headline: 'ราคาทองคำโลกเคลื่อนไหวในกรอบแคบ นักลงทุนรอดูตัวเลขเงินเฟ้อสหรัฐฯ สัปดาห์นี้', impact: 'คงน้ำหนักป้องกันความเสี่ยงตามเกณฑ์มาตรฐาน', timeAgo: '45 นาทีที่แล้ว' },
      { assetClass: 'Thai Equities', sentiment: 'Positive', headline: 'กลุ่มธนาคารและสื่อสารใน SET50 รักษาอัตราจ่ายเงินปันผลต่อเนื่องท่ามกลางเศรษฐกิจชะลอตัว', impact: 'ช่วยสร้างกระแสเงินสดรับสม่ำเสมอให้พอร์ต', timeAgo: '1 ชั่วโมงที่แล้ว' }
    ]
  },
  balanced: {
    step: 2,
    badge: 'Balanced',
    titleTh: 'พอร์ตสมดุลระหว่างการเติบโตและเกราะป้องกันความเสี่ยง',
    subtitleTh: 'กระจายน้ำหนักระหว่างหุ้นสหรัฐฯ หุ้นไทย ตราสารหนี้ และทองคำ เพื่อผลตอบแทนคุ้มค่าความเสี่ยง (Max Sharpe / HRP)',
    expectedReturn: '8.9%',
    volatility: '10.8%',
    sharpeRatio: '0.78',
    noteTh: 'สมดุลความเสี่ยงปานกลาง เหมาะกับการสะสมความมั่งคั่งระยะกลาง-ยาว',
    targetStrategy: 'hrp',
    targetPreset: 'all_weather',
    targetTickers: ['SPY', 'MSFT', 'AAPL', 'TLT', 'PTT.BK', 'BDMS.BK', 'GLD'],
    allocations: [
      { id: 'us_eq', labelEn: 'US Equities', labelTh: 'หุ้นขนาดใหญ่และเทคโนโลยีสหรัฐฯ', tickers: 'SPY • MSFT • AAPL', weightPct: 35, color: '#00D084' },
      { id: 'bonds', labelEn: 'Bonds', labelTh: 'ตราสารหนี้ภาครัฐและเอกชน', tickers: 'TLT • IEF', weightPct: 30, color: '#2563EB' },
      { id: 'thai_eq', labelEn: 'Thai Equities', labelTh: 'หุ้นพื้นฐานแกร่งตลาดไทย (SET50)', tickers: 'PTT.BK • BDMS.BK • AOT.BK', weightPct: 20, color: '#6366F1' },
      { id: 'gold', labelEn: 'Gold', labelTh: 'ทองคำป้องกันความเสี่ยงเงินเฟ้อ', tickers: 'GLD', weightPct: 15, color: '#F59E0B' }
    ],
    newsFeed: [
      { assetClass: 'US Equities', sentiment: 'Positive', headline: 'กลุ่มเทคโนโลยีและโครงสร้างพื้นฐาน AI สหรัฐฯ รายงานกำไรไตรมาสล่าสุดเติบโตเกินคาดการณ์', impact: 'โมเดลเพิ่มน้ำหนักหุ้นเติบโตคุณภาพ (+1.2% Tilt)', timeAgo: '12 นาทีที่แล้ว' },
      { assetClass: 'Thai Equities', sentiment: 'Positive', headline: 'ภาคการท่องเที่ยวและการแพทย์ไทยฟื้นตัวต่อเนื่อง หนุนรายได้กลุ่มบริการในดัชนี SET50', impact: 'รักษาน้ำหนักหุ้นไทยกลุ่ม Defensive Growth', timeAgo: '35 นาทีที่แล้ว' },
      { assetClass: 'Bonds / Gold', sentiment: 'Negative', headline: 'ความตึงเครียดด้านห่วงโซ่อุปทานโลกกดดันต้นทุนพลังงานในระยะสั้น', impact: 'คงสัดส่วนทองคำ 15% เพื่อกันแรงเหวี่ยงของพอร์ต', timeAgo: '1 ชั่วโมงที่แล้ว' }
    ]
  },
  growth: {
    step: 3,
    badge: 'Growth',
    titleTh: 'พอร์ตมุ่งเน้นการเติบโตของเงินทุนระยะยาว',
    subtitleTh: 'ให้น้ำหนักหุ้นเติบโตสหรัฐฯ และไทยเป็นหลัก พร้อมคงตราสารหนี้และทองคำบางส่วนเพื่อลดความเสียหายช่วงตลาดย่อตัว',
    expectedReturn: '12.6%',
    volatility: '16.4%',
    sharpeRatio: '0.82',
    noteTh: 'รับความผันผวนได้สูงขึ้น เพื่อมุ่งสร้างผลตอบแทนทบต้นระยะยาว',
    targetStrategy: 'max_sharpe',
    targetPreset: 'tech_titans',
    targetTickers: ['NVDA', 'AMZN', 'MSFT', 'QQQ', 'DELTA.BK', 'AOT.BK', 'GLD'],
    allocations: [
      { id: 'us_eq', labelEn: 'US Equities', labelTh: 'หุ้นเติบโตและนวัตกรรมสหรัฐฯ', tickers: 'NVDA • AMZN • MSFT • QQQ', weightPct: 55, color: '#00D084' },
      { id: 'thai_eq', labelEn: 'Thai Equities', labelTh: 'หุ้นไทยกลุ่มผู้นำการเติบโต', tickers: 'DELTA.BK • CPALL.BK • AOT.BK', weightPct: 25, color: '#6366F1' },
      { id: 'gold', labelEn: 'Gold', labelTh: 'ทองคำกระจายความเสี่ยง', tickers: 'GLD', weightPct: 10, color: '#F59E0B' },
      { id: 'bonds', labelEn: 'Bonds', labelTh: 'ตราสารหนี้สำรองสภาพคล่อง', tickers: 'TLT', weightPct: 10, color: '#2563EB' }
    ],
    newsFeed: [
      { assetClass: 'US Equities', sentiment: 'Positive', headline: 'ยอดคำสั่งซื้อชิปประมวลผลดาต้าเซ็นเตอร์พุ่งสูง หนุนแนวโน้มรายได้กลุ่ม Semiconductor สหรัฐฯ', impact: 'สัญญาณ Momentum หนุนพอร์ต Growth ชัดเจน', timeAgo: '9 นาทีที่แล้ว' },
      { assetClass: 'Thai Equities', sentiment: 'Neutral', headline: 'ความผันผวนค่าเงินบาทเทียบดอลลาร์เพิ่มขึ้นตามทิศทางฟันด์โฟลว์ต่างชาติ', impact: 'คำนวณผลตอบแทนปรับด้วยเรท USD/THB รายวัน', timeAgo: '28 นาทีที่แล้ว' },
      { assetClass: 'US Equities', sentiment: 'Negative', headline: 'แรงขายทำกำไรระยะสั้นในหุ้นกลุ่ม Valuation สูงหลังดัชนีทำจุดสูงสุดใหม่', impact: 'ระบบคุมเพดานน้ำหนักต่อตัวไม่ให้กระจุกเกินเกณฑ์', timeAgo: '50 นาทีที่แล้ว' }
    ]
  }
};

function selectLandingRiskProfile(profileKey = 'balanced') {
  const key = LANDING_RISK_PROFILES[profileKey] ? profileKey : 'balanced';
  state.landingRiskProfile = key;
  const preset = LANDING_RISK_PROFILES[key];

  ['conservative', 'balanced', 'growth'].forEach(k => {
    const tabBtn = document.getElementById(`landing-risk-tab-${k}`);
    if (tabBtn) {
      const isAct = k === key;
      tabBtn.setAttribute('aria-selected', isAct ? 'true' : 'false');
      tabBtn.className = isAct
        ? 'qf-risk-tab px-3.5 py-1.5 rounded-xl text-xs sm:text-sm font-bold bg-[#0F172A] text-[#00D084] shadow-2xs transition cursor-pointer'
        : 'qf-risk-tab px-3.5 py-1.5 rounded-xl text-xs sm:text-sm font-bold text-slate-600 hover:text-slate-900 transition cursor-pointer';
    }
  });

  const sliderEl = document.getElementById('landing-risk-slider');
  if (sliderEl) sliderEl.value = String(preset.step);
  const stepLbl = document.getElementById('landing-risk-step-label');
  if (stepLbl) stepLbl.innerText = `${preset.step}/3`;

  const badgeEl = document.getElementById('landing-risk-badge');
  if (badgeEl) badgeEl.innerText = `${preset.badge} Profile`;
  const titleEl = document.getElementById('landing-risk-title');
  if (titleEl) titleEl.innerText = preset.titleTh;
  const subEl = document.getElementById('landing-risk-subtitle');
  if (subEl) subEl.innerText = preset.subtitleTh;
  const noteEl = document.getElementById('landing-risk-note');
  if (noteEl) noteEl.innerText = preset.noteTh;

  const retEl = document.getElementById('landing-metric-return');
  if (retEl) retEl.innerText = preset.expectedReturn;
  const volEl = document.getElementById('landing-metric-vol');
  if (volEl) volEl.innerText = preset.volatility;
  const sharpeEl = document.getElementById('landing-metric-sharpe');
  if (sharpeEl) sharpeEl.innerText = preset.sharpeRatio;

  const topSlice = preset.allocations[0];
  const dLabel = document.getElementById('landing-risk-donut-label');
  if (dLabel && topSlice) dLabel.innerText = topSlice.labelEn;
  const dPct = document.getElementById('landing-risk-donut-pct');
  if (dPct && topSlice) dPct.innerText = `${topSlice.weightPct}%`;
  const dTickers = document.getElementById('landing-risk-donut-tickers');
  if (dTickers && topSlice) dTickers.innerText = topSlice.tickers;

  const svgEl = document.getElementById('landing-risk-donut-svg');
  if (svgEl) {
    const r = 56;
    const circ = 2 * Math.PI * r;
    let cum = 0;
    const circles = preset.allocations.map(s => {
      const dash = `${(s.weightPct / 100) * circ} ${circ}`;
      const offset = -((cum / 100) * circ);
      cum += s.weightPct;
      return `<circle cx="70" cy="70" r="${r}" fill="none" stroke="${s.color}" stroke-width="18" stroke-dasharray="${dash}" stroke-dashoffset="${offset}"></circle>`;
    }).join('');
    svgEl.innerHTML = `<circle cx="70" cy="70" r="${r}" fill="none" class="qf-donut-track" stroke-width="18"></circle>${circles}`;
  }

  const barsEl = document.getElementById('landing-risk-bars-list');
  if (barsEl) {
    barsEl.innerHTML = preset.allocations.map(s => `
      <div class="p-2.5 rounded-xl bg-white border border-slate-100 hover:border-slate-200 transition">
        <div class="flex items-center justify-between text-xs mb-1.5 gap-2">
          <div class="flex items-center gap-2 min-w-0">
            <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background-color:${s.color};"></span>
            <span class="font-bold text-slate-800 truncate">${escapeHtmlText(s.labelEn)}</span>
            <span class="text-slate-500 truncate hidden sm:inline">• ${escapeHtmlText(s.labelTh)}</span>
          </div>
          <span class="font-mono font-bold text-slate-900 tabular-nums shrink-0">${s.weightPct}%</span>
        </div>
        <div class="w-full h-2 rounded-full bg-slate-100 overflow-hidden">
          <div class="h-full rounded-full transition-all duration-300" style="width:${s.weightPct}%;background-color:${s.color};"></div>
        </div>
      </div>
    `).join('');
  }

  const newsEl = document.getElementById('landing-risk-news-list');
  if (newsEl) {
    const sentStyles = {
      Positive: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      Neutral: 'bg-slate-100 text-slate-700 border-slate-200',
      Negative: 'bg-rose-50 text-rose-700 border-rose-200'
    };
    newsEl.innerHTML = preset.newsFeed.map(item => `
      <article class="p-3 rounded-2xl bg-white border border-slate-200/80 space-y-1.5 shadow-2xs">
        <div class="flex items-center justify-between gap-2 flex-wrap">
          <span class="text-[11px] font-mono font-bold px-2 py-0.5 rounded bg-slate-100 text-slate-700">${escapeHtmlText(item.assetClass)}</span>
          <span class="text-[11px] font-bold px-2.5 py-0.5 rounded-full border ${sentStyles[item.sentiment] || sentStyles.Neutral}">${escapeHtmlText(item.sentiment)}</span>
        </div>
        <h5 class="text-xs sm:text-sm font-semibold text-slate-900 leading-snug">${escapeHtmlText(item.headline)}</h5>
        <div class="flex items-center justify-between text-[11px] text-slate-500 pt-1 border-t border-slate-100 gap-2">
          <span class="truncate">${escapeHtmlText(item.impact)}</span>
          <span class="shrink-0 font-mono">${escapeHtmlText(item.timeAgo)}</span>
        </div>
      </article>
    `).join('');
  }
}

function selectLandingRiskProfileByStep(stepVal) {
  const num = parseInt(stepVal, 10);
  const map = { 1: 'conservative', 2: 'balanced', 3: 'growth' };
  selectLandingRiskProfile(map[num] || 'balanced');
}

function enterWorkspaceWithRiskProfile(profileKey = 'balanced') {
  const key = LANDING_RISK_PROFILES[profileKey] ? profileKey : (state.landingRiskProfile || 'balanced');
  const preset = LANDING_RISK_PROFILES[key];
  selectLandingRiskProfile(key);
  selectLandingPreset(preset.targetPreset);

  // Set final target tickers BEFORE entering Workspace so live quotes fire exactly ONCE (zero cancelled duplicate requests)
  const maxAssets = getActiveUserTierInfo().maxAssets || 5;
  if (Array.isArray(preset.targetTickers) && preset.targetTickers.length >= 2) {
    state.tickers = preset.targetTickers.slice(0, maxAssets);
  } else if (PRESETS[preset.targetPreset]) {
    state.tickers = PRESETS[preset.targetPreset].tickers.slice(0, maxAssets);
  }

  setAppView('workspace', false);
  switchAppTab('setup');
  renderTickersList();
  updateMaxWeightLabel(document.getElementById('max-weight-slider')?.value || 100);
  refreshAdvancedSummaryLabel();

  state.activeGoal = preset.targetStrategy;
  if (typeof selectGoal === 'function') {
    selectGoal(preset.targetStrategy);
  }
  const optTargetSelect = document.getElementById('opt-target');
  if (optTargetSelect) {
    optTargetSelect.value = preset.targetStrategy;
  }

  // Keep page anchored cleanly at top (y=0) so sticky #main-nav-tabs never covers Tab 1 heading
  window.scrollTo({ top: 0, behavior: 'auto' });
  requestAnimationFrame(() => window.scrollTo(0, 0));
}

const LANDING_PRESET_LABELS = {
  colab_original: 'US Tech + BTC',
  tech_titans: 'Big Tech 7',
  all_weather: 'All-Weather',
  thai_set50: 'หุ้นไทย SET50'
};

function selectLandingPreset(presetKey) {
  const p = PRESETS[presetKey];
  if (!p) return;
  state.landingSelectedPreset = presetKey;

  Object.keys(PRESETS).forEach(k => {
    const card = document.getElementById(`landing-preset-card-${k}`);
    if (card) {
      const isSelected = k === presetKey;
      card.className = isSelected
        ? 'qf-landing-preset-btn active text-left px-3.5 py-2.5 rounded-2xl bg-[#E6FBF3]/80 border-2 border-[#00D084] transition cursor-pointer'
        : 'qf-landing-preset-btn text-left px-3.5 py-2.5 rounded-2xl bg-slate-50 hover:bg-slate-100 border border-slate-200 transition cursor-pointer';
    }
  });

  const titleEl = document.getElementById('landing-preview-preset-title');
  if (titleEl) {
    const label = LANDING_PRESET_LABELS[presetKey] || presetKey;
    titleEl.innerText = `${label} • ตัวอย่างหน้าจอผลลัพธ์`;
  }

  const tickersWrap = document.getElementById('landing-preview-tickers');
  if (tickersWrap) {
    const badgeStyles = [
      'bg-[#00D084]/15 text-[#00E593] border-[#00D084]/30',
      'bg-sky-500/15 text-sky-300 border-sky-400/30',
      'bg-indigo-500/15 text-indigo-300 border-indigo-400/30',
      'bg-amber-500/15 text-amber-300 border-amber-400/30',
      'bg-slate-700/70 text-slate-200 border-slate-600'
    ];
    tickersWrap.innerHTML = (p.tickers || []).map((sym, idx) => {
      const cls = badgeStyles[idx % badgeStyles.length];
      return `<span class="px-2.5 py-1 rounded-lg border text-xs font-mono font-bold ${cls}">${escapeHtmlText(sym)}</span>`;
    }).join('');
  }
}

function enterWorkspaceFromLanding(tabKey = 'setup') {
  const landingBudget = parseNumericInput(document.getElementById('landing-budget-input')?.value);
  if (tabKey === 'setup' && state.resultStatus === 'idle') {
    const chosenKey = state.landingSelectedPreset || 'colab_original';
    applyPreset(chosenKey, false, true);
    if (landingBudget >= 10) {
      state.budget = landingBudget;
      const fmt = formatNumberWithCommas(landingBudget, state.currency === 'USD' ? 2 : 0);
      syncAllBudgetInputs(fmt, '');
    }
  }
  setAppView('workspace', false);
  switchAppTab(tabKey);
}

function enterWorkspaceWithPreset(presetKey) {
  selectLandingPreset(presetKey);
  setAppView('workspace', false);
  switchAppTab('setup');
  applyPreset(presetKey, true, false);
}

function enterWorkspaceAndCalculate() {
  const landingBudget = parseNumericInput(document.getElementById('landing-budget-input')?.value);
  const effectiveBudget = landingBudget >= 10 ? landingBudget : (state.budget || 100000);
  const chosenKey = state.landingSelectedPreset || 'colab_original';

  setAppView('workspace', false);
  applyPreset(chosenKey, false, true);
  state.budget = effectiveBudget;
  const fmt = formatNumberWithCommas(effectiveBudget, state.currency === 'USD' ? 2 : 0);
  syncAllBudgetInputs(fmt, '');

  switchAppTab('trade-plan');
  runOptimization(true);
}

function selectLandingPreviewTab(tabKey) {
  const validPreviewTabs = ['allocation', 'orders', 'insights', 'backtest', 'goals'];
  const nextKey = validPreviewTabs.includes(tabKey) ? tabKey : 'allocation';
  state.landingPreviewTab = nextKey;

  validPreviewTabs.forEach(k => {
    const btn = document.getElementById(`landing-preview-tab-${k}`);
    if (btn) {
      const isActive = k === nextKey;
      btn.className = isActive
        ? 'qf-landing-preview-tab active px-3 py-1.5 rounded-xl text-xs font-bold bg-[#00D084] text-[#0A0D12] whitespace-nowrap transition cursor-pointer'
        : 'qf-landing-preview-tab px-3 py-1.5 rounded-xl text-xs font-medium bg-white/5 text-slate-300 hover:text-white whitespace-nowrap transition cursor-pointer';
    }
    const panel = document.getElementById(`landing-preview-panel-${k}`);
    if (panel) {
      panel.classList.toggle('hidden', k !== nextKey);
    }
  });
}

function switchAppTab(tabKey) {
  if (state.appView !== 'workspace') {
    setAppView('workspace', false);
  }
  const validTabs = ['setup', 'trade-plan', 'insights', 'backtest', 'goals'];
  const nextTab = validTabs.includes(tabKey) ? tabKey : 'setup';
  state.activeTab = nextTab;

  validTabs.forEach(k => {
    const viewEl = document.getElementById(`tab-view-${k}`);
    if (viewEl) {
      const isTarget = k === nextTab;
      viewEl.classList.toggle('hidden', !isTarget);
      if (isTarget) {
        viewEl.classList.remove('qf-tab-enter');
        void viewEl.offsetWidth;
        viewEl.classList.add('qf-tab-enter');
      }
    }

    const btnEl = document.getElementById(`main-tab-${k}`);
    if (btnEl) btnEl.classList.toggle('active', k === nextTab);
  });

  renderTabStateBanners();

  setTimeout(() => {
    if (nextTab === 'trade-plan' && state.optData) {
      const strat = state.optData.strategies?.[state.activeGoal];
      if (strat) renderDonutAllocationChart(strat.weights, state.optData.metadata?.tickers || []);
    } else if (nextTab === 'backtest' && state.optData) {
      renderPortfolioGrowthChart();
      renderEfficientFrontierPlot();
      renderCorrelationAndGrowthPlots();
    } else if (nextTab === 'goals') {
      const mainBudgetVal = document.getElementById('budget-input')?.value || formatNumberWithCommas(state.budget || 100000, 0);
      syncAllBudgetInputs(mainBudgetVal, '');
      recalculateGoalProjection();
      if (typeof window.refreshSavedPortfoliosUI === 'function') {
        window.refreshSavedPortfoliosUI();
      }
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
  window.scrollTo({ top: 0, behavior: 'auto' });
  requestAnimationFrame(() => window.scrollTo(0, 0));
}

function resizeVisiblePlotlyCharts() {
  setTimeout(() => {
    ['allocation-donut-chart', 'portfolio-growth-chart', 'frontier-plot-container', 'correlation-plot-container', 'growth-plot-container', 'goal-projection-chart'].forEach(id => {
      const chartEl = document.getElementById(id);
      if (chartEl && chartEl.data && window.Plotly?.Plots?.resize) {
        try { Plotly.Plots.resize(chartEl); } catch (e) {}
      }
    });
    window.dispatchEvent(new Event('resize'));
  }, 50);
}

function toggleDeepDiveSection(sectionKey) {
  const bodyEl = document.getElementById(`deep-dive-body-${sectionKey}`);
  const chevEl = document.getElementById(`deep-dive-chevron-${sectionKey}`);
  if (!bodyEl) return;

  const willOpen = bodyEl.classList.contains('hidden');
  bodyEl.classList.toggle('hidden', !willOpen);
  if (chevEl) {
    chevEl.style.transform = willOpen ? 'rotate(180deg)' : 'rotate(0deg)';
  }

  if (willOpen) {
    if (state.optData) {
      if (sectionKey === 'trade-plan') {
        const strat = state.optData.strategies?.[state.activeGoal];
        if (strat) renderDonutAllocationChart(strat.weights, state.optData.metadata?.tickers || []);
      } else if (sectionKey === 'backtest') {
        renderEfficientFrontierPlot();
        renderCorrelationAndGrowthPlots();
      }
      resizeVisiblePlotlyCharts();
    }
    setTimeout(() => {
      bodyEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 60);
  }
}

function setGlobalViewDepth(mode) {
  const isPro = mode === 'pro';
  state.viewDepth = isPro ? 'pro' : 'simple';

  const activeCls = 'qf-seg-btn qf-seg-active px-2.5 py-1 rounded-md text-[11px] font-semibold transition cursor-pointer inline-flex items-center gap-1 whitespace-nowrap';
  const inactiveCls = 'qf-seg-btn qf-seg-inactive px-2.5 py-1 rounded-md text-[11px] font-medium transition cursor-pointer inline-flex items-center gap-1 whitespace-nowrap';

  const btnSimple = document.getElementById('view-depth-btn-simple');
  const btnPro = document.getElementById('view-depth-btn-pro');
  if (btnSimple && btnPro) {
    btnSimple.className = !isPro ? activeCls : inactiveCls;
    btnPro.className = isPro ? activeCls : inactiveCls;
  }

  // Tab 1: Sync Advanced Settings drawer so Simple/Detailed works consistently on Tab 1 too
  const advDrawer = document.getElementById('setup-advanced-drawer');
  const advChev = document.getElementById('setup-advanced-chevron');
  if (advDrawer) advDrawer.classList.toggle('hidden', !isPro);
  if (advChev) advChev.style.transform = isPro ? 'rotate(180deg)' : 'rotate(0deg)';

  // Tabs 2-5: Sync all Deep-Dive sections
  ['trade-plan', 'insights', 'backtest', 'milestones'].forEach(k => {
    const bodyEl = document.getElementById(`deep-dive-body-${k}`);
    const chevEl = document.getElementById(`deep-dive-chevron-${k}`);
    if (bodyEl) bodyEl.classList.toggle('hidden', !isPro);
    if (chevEl) chevEl.style.transform = isPro ? 'rotate(180deg)' : 'rotate(0deg)';
  });

  if (isPro && state.optData) {
    const strat = state.optData.strategies?.[state.activeGoal];
    if (strat) renderDonutAllocationChart(strat.weights, state.optData.metadata?.tickers || []);
    renderEfficientFrontierPlot();
    renderCorrelationAndGrowthPlots();
    resizeVisiblePlotlyCharts();
  }

  if (typeof showPortfolioToastApp === 'function') {
    showPortfolioToastApp(
      isPro
        ? 'โหมดละเอียด + กราฟ: เปิดตั้งค่าขั้นสูงและส่วนวิเคราะห์เชิงลึกครบทุกแท็บ'
        : 'โหมดอ่านง่าย: ซ่อนรายละเอียดเชิงลึกเพื่อให้อ่านสรุปหลักได้เร็วขึ้น'
    );
  }
}

function toggleBalancePrivacy() {
  state.balancePrivacyHidden = !state.balancePrivacyHidden;
  document.body.classList.toggle('qf-privacy-hidden', state.balancePrivacyHidden);
  const iconEl = document.getElementById('balance-privacy-icon');
  if (iconEl) {
    iconEl.setAttribute('data-lucide', state.balancePrivacyHidden ? 'eye-off' : 'eye');
  }
  const quickPrivBtn = document.getElementById('header-quick-privacy-btn');
  if (quickPrivBtn) {
    quickPrivBtn.innerHTML = `<i id="header-quick-privacy-icon" data-lucide="${state.balancePrivacyHidden ? 'eye-off' : 'eye'}" class="w-4 h-4"></i>`;
    quickPrivBtn.className = state.balancePrivacyHidden
      ? 'inline-flex items-center justify-center w-9 h-9 rounded-xl bg-[#00D084] text-[#0A0D12] border border-[#00D084] transition cursor-pointer'
      : 'inline-flex items-center justify-center w-9 h-9 rounded-xl bg-slate-100/90 hover:bg-slate-200/70 text-slate-700 border border-slate-200/80 transition cursor-pointer';
  }
  if (window.lucide) lucide.createIcons();
  const hdrTxt = document.getElementById('header-privacy-status-text');
  if (hdrTxt) {
    hdrTxt.innerText = state.balancePrivacyHidden ? 'ซ่อนอยู่' : 'แสดง';
  }
  if (state.optData) {
    renderActiveGoalView();
    renderBacktestStressCard();
    renderPortfolioGrowthChart();
    renderStrategyCompareTable();
    renderAssetStatsTable();
    recalculateGoalProjection();
    if (state.rebalanceMode === 'custom') {
      renderCustomHoldingsInputs();
    }
    updateCustomTotalPortfolioLabel();
  } else {
    renderDimeWealthOverview();
    recalculateGoalProjection();
  }
  if (typeof window.refreshSavedPortfoliosUI === 'function') {
    window.refreshSavedPortfoliosUI();
  }
}

function selectStrategyCompareMetric(metric) {
  const valid = ['return', 'volatility', 'sharpe'].includes(metric) ? metric : 'return';
  state.strategyCompareMetric = valid;
  renderDimeWealthOverview();
}

function toggleHoldingsListExpand() {
  state.holdingsListExpanded = !state.holdingsListExpanded;
  renderDimeWealthOverview();
}

function renderStrategyComparisonCard(data, strat, budget) {
  const verdictEl = document.getElementById('strat-compare-verdict');
  const barsEl = document.getElementById('strat-compare-bars');
  const hintEl = document.getElementById('strat-compare-metric-hint');
  if (!barsEl) return;

  const metric = state.strategyCompareMetric || 'return';
  const dark = isDarkTheme();

  // Sync 3 metric switcher tabs
  const tabMeta = {
    return: { id: 'strat-cmp-tab-return', hint: 'เหนือเส้นประ = กำไรคาดหวังสูงกว่า 1/N' },
    volatility: { id: 'strat-cmp-tab-volatility', hint: 'ใต้เส้นประ = พอร์ตนิ่งกว่า 1/N' },
    sharpe: { id: 'strat-cmp-tab-sharpe', hint: 'เหนือเส้นประ = คุ้มค่าต่อความเสี่ยงกว่า 1/N' }
  };
  Object.entries(tabMeta).forEach(([k, info]) => {
    const btn = document.getElementById(info.id);
    if (!btn) return;
    const isAct = k === metric;
    btn.classList.toggle('active', isAct);
    btn.setAttribute('aria-selected', isAct ? 'true' : 'false');
    if (isAct) {
      btn.classList.remove('text-slate-600', 'hover:text-slate-900');
    } else {
      btn.classList.add('text-slate-600', 'hover:text-slate-900');
    }
  });
  if (hintEl && tabMeta[metric]) {
    hintEl.innerText = tabMeta[metric].hint;
  }

  const stratCatalog = [
    { key: 'max_sharpe', title: 'คุ้มความเสี่ยงสูงสุด', shortAxis: 'คุ้มความเสี่ยง' },
    { key: 'min_volatility', title: 'ผันผวนต่ำ', shortAxis: 'ผันผวนต่ำ' },
    { key: 'hrp', title: 'กระจายเสี่ยงสมดุล', shortAxis: 'กระจายสมดุล' },
    { key: 'equal_weight', title: 'ซื้อหารเท่ากัน (1/N)', shortAxis: 'หารเท่ากัน 1/N', isBaseline: true }
  ];

  if (!strat || !data?.strategies) {
    barsEl.innerHTML = `
      <div class="text-center py-10 text-xs text-slate-500">
        กด <b>"คำนวณพอร์ต &amp; ดูผลลัพธ์"</b> เพื่อแสดงกราฟแท่งเปรียบเทียบทั้ง 4 แผน
      </div>
    `;
    if (verdictEl) {
      verdictEl.innerHTML = `<div class="text-xs font-medium text-slate-500 text-center py-1">รอผลการคำนวณพอร์ต</div>`;
    }
    return;
  }

  const strategies = data.strategies;
  const activeKey = state.activeGoal;

  // 1. Collect metric rows across all available strategies
  const rows = stratCatalog
    .filter(item => Boolean(strategies[item.key]))
    .map(item => {
      const s = strategies[item.key];
      const retVal = Number(s.expected_return || 0) * 100;
      const volVal = Number(s.volatility || 0) * 100;
      const srVal = Number(s.sharpe_ratio || 0);
      const mddPct = Math.abs(Number(s.max_drawdown || 0) * 100);
      const val = metric === 'volatility' ? volVal : (metric === 'sharpe' ? srVal : retVal);
      return { ...item, s, retVal, volVal, srVal, mddPct, val };
    });

  let bestKey = null;
  if (rows.length > 0) {
    bestKey = metric === 'volatility'
      ? rows.reduce((best, r) => (r.val < best.val ? r : best), rows[0]).key
      : rows.reduce((best, r) => (r.val > best.val ? r : best), rows[0]).key;
  }
  const bestLabel = metric === 'volatility' ? 'นิ่งสุด' : (metric === 'sharpe' ? 'คุ้มสุด' : 'สูงสุด');
  const eqRow = rows.find(r => r.key === 'equal_weight');

  const formatMetricVal = (v, compact = false) => {
    if (metric === 'return') return `${v >= 0 ? '+' : ''}${v.toFixed(compact ? 1 : 2)}%`;
    if (metric === 'volatility') return `${v.toFixed(compact ? 1 : 2)}%`;
    return v.toFixed(2);
  };

  // 2. Build Clean Responsive Vertical Column Chart SVG with Y-Axis & Dashed 1/N Reference Line
  const W = 560;
  const H = 316;
  const plotLeft = 48;
  const plotRight = 452;
  const plotTop = 44;
  const plotBottom = 262;
  const plotW = plotRight - plotLeft;
  const plotH = plotBottom - plotTop;

  const vals = rows.map(r => r.val);
  const rawMax = Math.max(0, ...vals);
  const rawMin = Math.min(0, ...vals);
  const rawSpan = Math.max(rawMax - rawMin, metric === 'sharpe' ? 0.5 : 4);

  const niceStep = (targetStep) => {
    const pow10 = Math.pow(10, Math.floor(Math.log10(Math.max(targetStep, 1e-6))));
    const norm = targetStep / pow10;
    const mult = norm <= 1 ? 1 : (norm <= 2 ? 2 : (norm <= 5 ? 5 : 10));
    return mult * pow10;
  };
  const step = niceStep(rawSpan / 4.2);
  const yMax = rawMax > 0 ? Math.ceil((rawMax + step * 0.35) / step) * step : (rawMin < 0 ? 0 : step * 4);
  const yMin = rawMin < 0 ? -Math.ceil((Math.abs(rawMin) + step * 0.35) / step) * step : 0;
  const yRange = Math.max(yMax - yMin, 1e-6);
  const toY = (v) => plotTop + ((yMax - v) / yRange) * plotH;
  const zeroY = toY(0);

  // Palette tokens for Light vs Dark Mode
  const cStageBg = dark ? '#151C28' : '#F8FAFC';
  const cGrid = dark ? '#263248' : '#E2E8F0';
  const cZero = dark ? '#475569' : '#94A3B8';
  const cAxisTxt = dark ? '#94A3B8' : '#64748B';
  const cLabelNorm = dark ? '#CBD5E1' : '#334155';
  const cLabelAct = dark ? '#34D399' : '#047857';
  const cBarActive = dark ? '#10B981' : '#059669';
  const cValNorm = dark ? '#E2E8F0' : '#0F172A';
  const cBarOther = dark ? '#334155' : '#CBD5E1';
  const cBarBase = dark ? '#52637A' : '#64748B';
  const cDashLine = dark ? '#94A3B8' : '#475569';
  const cRefPillBg = dark ? '#0F172A' : '#0F172A';
  const cRefPillBorder = dark ? '#334155' : '#0F172A';

  // Horizontal gridlines + Y-axis ticks
  const ticks = [];
  for (let t = yMin; t <= yMax + step * 0.001; t += step) {
    ticks.push(Number(t.toFixed(4)));
  }
  const gridSvg = ticks.map(t => {
    const ty = toY(t);
    const isZero = Math.abs(t) < 1e-4;
    const tickTxt = metric === 'sharpe'
      ? t.toFixed(1)
      : `${t > 0 && metric === 'return' ? '+' : ''}${Number.isInteger(t) ? t : t.toFixed(1)}%`;
    return `
      <line x1="${plotLeft}" y1="${ty.toFixed(1)}" x2="${plotRight}" y2="${ty.toFixed(1)}"
        stroke="${isZero ? cZero : cGrid}" stroke-width="${isZero ? 1.5 : 1}" ${isZero ? '' : 'stroke-dasharray="3 3"'} />
      <text x="${plotLeft - 8}" y="${(ty + 4).toFixed(1)}" text-anchor="end"
        fill="${cAxisTxt}" font-size="11" font-family="JetBrains Mono, monospace" font-weight="600">${tickTxt}</text>
    `;
  }).join('');

  // 4 Interactive Vertical Columns
  const colSlotW = plotW / Math.max(rows.length, 1);
  const barW = Math.min(58, Math.max(38, colSlotW * 0.54));

  const colsSvg = rows.map((r, i) => {
    const isActive = r.key === activeKey;
    const isBest = r.key === bestKey;
    const slotX = plotLeft + i * colSlotW;
    const cx = slotX + colSlotW / 2;
    const bx = cx - barW / 2;

    const valY = toY(r.val);
    const isNeg = r.val < 0;
    const barTop = isNeg ? zeroY : valY;
    const barH = Math.max(5, Math.abs(zeroY - valY));

    const fillVal = isNeg
      ? '#E11D48'
      : (isActive ? cBarActive : (r.isBaseline ? cBarBase : cBarOther));

    const valLabelY = isNeg ? Math.min(plotBottom - 4, zeroY + barH + 16) : Math.max(24, barTop - 9);
    const valColor = isNeg ? '#E11D48' : (isActive ? cLabelAct : cValNorm);

    const bestPillSvg = (isBest && !isNeg) ? `
      <rect x="${(cx - 25).toFixed(1)}" y="${Math.max(4, valLabelY - 28).toFixed(1)}" width="50" height="17" rx="8.5"
        fill="${dark ? 'rgba(16, 185, 129, 0.14)' : '#ECFDF5'}" stroke="${dark ? 'rgba(16, 185, 129, 0.40)' : '#A7F3D0'}" stroke-width="1" />
      <text x="${cx.toFixed(1)}" y="${Math.max(15.5, valLabelY - 16.5).toFixed(1)}" text-anchor="middle"
        fill="${dark ? '#34D399' : '#047857'}" font-size="9.5" font-weight="700" font-family="Anuphan, Plus Jakarta Sans, sans-serif">${bestLabel}</text>
    ` : '';

    const activeDotPillSvg = isActive ? `
      <rect x="${(cx - 26).toFixed(1)}" y="${(plotBottom + 32).toFixed(1)}" width="52" height="17" rx="8.5" fill="${cBarActive}" />
      <text x="${cx.toFixed(1)}" y="${(plotBottom + 43.5).toFixed(1)}" text-anchor="middle"
        fill="${dark ? '#052E16' : '#FFFFFF'}" font-size="9.5" font-weight="700" font-family="Anuphan, Plus Jakarta Sans, sans-serif">กำลังใช้</text>
    ` : (r.isBaseline ? `
      <text x="${cx.toFixed(1)}" y="${(plotBottom + 43).toFixed(1)}" text-anchor="middle"
        fill="${cAxisTxt}" font-size="9.5" font-weight="600" font-family="Anuphan, Plus Jakarta Sans, sans-serif">ไม่จัดสัดส่วน</text>
    ` : '');

    const tooltipTxt = `${r.title} | ผลตอบแทน ${r.retVal >= 0 ? '+' : ''}${r.retVal.toFixed(2)}%/ปี • ความผันผวน ${r.volVal.toFixed(2)}% • ลงหนักสุด -${r.mddPct.toFixed(2)}% • Sharpe ${r.srVal.toFixed(2)} (คลิกเพื่อสลับแผน)`;

    return `
      <g class="qf-vbar-col" role="button" tabindex="0" aria-label="เลือกแผน ${r.title}" aria-pressed="${isActive ? 'true' : 'false'}"
        onclick="selectGoal('${r.key}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();selectGoal('${r.key}');}">
        <title>${escapeHtmlText(tooltipTxt)}</title>
        <rect class="qf-vbar-hover-bg" x="${(slotX + 4).toFixed(1)}" y="${(plotTop - 36).toFixed(1)}" width="${(colSlotW - 8).toFixed(1)}" height="${(plotBottom - plotTop + 88).toFixed(1)}" rx="12" />
        ${bestPillSvg}
        <rect class="qf-vbar-rect" x="${bx.toFixed(1)}" y="${barTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="8"
          fill="${fillVal}" />
        <text x="${cx.toFixed(1)}" y="${valLabelY.toFixed(1)}" text-anchor="middle"
          fill="${valColor}" stroke="${cStageBg}" stroke-width="5" stroke-linejoin="round" paint-order="stroke"
          font-size="13" font-weight="800" font-family="JetBrains Mono, monospace">${formatMetricVal(r.val, true)}</text>
        <text x="${cx.toFixed(1)}" y="${(plotBottom + 22).toFixed(1)}" text-anchor="middle"
          fill="${isActive ? cLabelAct : cLabelNorm}" font-size="12" font-weight="${isActive ? '800' : '600'}"
          font-family="Anuphan, Plus Jakarta Sans, sans-serif">${r.shortAxis}</text>
        ${activeDotPillSvg}
      </g>
    `;
  }).join('');

  // Horizontal Dashed Baseline Reference Line (rendered BEHIND bars/labels so it never cuts across digits or badges)
  let baselineLineSvg = '';
  let baselinePillSvg = '';
  if (eqRow) {
    const baseY = toY(eqRow.val);
    const pillH = 34;
    const pillW = 84;
    const pillX = plotRight + 8;
    const pillY = Math.max(8, Math.min(plotBottom - pillH, baseY - pillH / 2));
    baselineLineSvg = `
      <line x1="${plotLeft}" y1="${baseY.toFixed(1)}" x2="${pillX.toFixed(1)}" y2="${baseY.toFixed(1)}"
        stroke="${cDashLine}" stroke-width="1.75" stroke-dasharray="6 4" pointer-events="none" />
    `;
    baselinePillSvg = `
      <g pointer-events="none">
        <circle cx="${plotRight.toFixed(1)}" cy="${baseY.toFixed(1)}" r="3.2" fill="${cDashLine}" />
        <rect x="${pillX}" y="${pillY.toFixed(1)}" width="${pillW}" height="${pillH}" rx="9"
          fill="${cRefPillBg}" stroke="${cRefPillBorder}" stroke-width="1" />
        <text x="${pillX + pillW / 2}" y="${(pillY + 13).toFixed(1)}" text-anchor="middle"
          fill="#94A3B8" font-size="9.5" font-weight="600" font-family="Anuphan, Plus Jakarta Sans, sans-serif">แผนฐาน 1/N</text>
        <text x="${pillX + pillW / 2}" y="${(pillY + 26.5).toFixed(1)}" text-anchor="middle"
          fill="#FFFFFF" font-size="11.5" font-weight="800" font-family="JetBrains Mono, monospace">${formatMetricVal(eqRow.val, true)}</text>
      </g>
    `;
  }

  barsEl.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="w-full h-auto block select-none overflow-visible" role="img" aria-label="กราฟแท่งแนวตั้งเปรียบเทียบแผนพอร์ตทั้ง 4 แบบ">
      ${gridSvg}
      ${baselineLineSvg}
      ${colsSvg}
      ${baselinePillSvg}
    </svg>
  `;

  // 3. Render 3-Tile Comparison Delta Strip directly UNDER the Vertical Column Chart
  if (verdictEl) {
    const isBaselineActive = activeKey === 'equal_weight';
    const refStrat = isBaselineActive ? strategies.max_sharpe : strategies.equal_weight;
    const refShort = isBaselineActive ? 'คุ้มความเสี่ยง' : 'หารเท่ากัน 1/N';

    if (refStrat) {
      const dRet = (Number(strat.expected_return || 0) - Number(refStrat.expected_return || 0)) * 100;
      const dVol = (Number(strat.volatility || 0) - Number(refStrat.volatility || 0)) * 100;
      const stratMddAmt = strat.max_drawdown_amount !== undefined ? Number(strat.max_drawdown_amount) : Math.abs(Number(strat.max_drawdown || 0)) * budget;
      const refMddAmt = refStrat.max_drawdown_amount !== undefined ? Number(refStrat.max_drawdown_amount) : Math.abs(Number(refStrat.max_drawdown || 0)) * budget;
      const dMddAmt = stratMddAmt - refMddAmt;

      const retTone = Math.abs(dRet) < 0.05 ? '' : (dRet > 0 ? 'is-good' : '');
      const retNumCls = dRet > 0.05 ? (dark ? 'text-[#00E593]' : 'text-emerald-700') : (dark ? 'text-slate-200' : 'text-slate-800');
      const retSub = Math.abs(dRet) < 0.05 ? `ใกล้เคียง ${refShort}` : (dRet > 0 ? `สูงกว่า ${refShort}` : `ต่ำกว่า ${refShort}`);

      const volTone = Math.abs(dVol) < 0.05 ? '' : (dVol < 0 ? 'is-good' : 'is-warn');
      const volNumCls = dVol < -0.05 ? (dark ? 'text-[#00E593]' : 'text-emerald-700') : (dVol > 0.05 ? (dark ? 'text-amber-300' : 'text-amber-700') : (dark ? 'text-slate-200' : 'text-slate-800'));
      const volSub = Math.abs(dVol) < 0.05 ? `ใกล้เคียง ${refShort}` : (dVol < 0 ? `นิ่งกว่า ${refShort}` : `เหวี่ยงกว่า ${refShort}`);

      const mddTone = Math.abs(dMddAmt) < 5 ? '' : (dMddAmt < 0 ? 'is-good' : 'is-bad');
      const mddNumCls = dMddAmt < -5 ? (dark ? 'text-[#00E593]' : 'text-emerald-700') : (dMddAmt > 5 ? (dark ? 'text-rose-300' : 'text-rose-700') : (dark ? 'text-slate-200' : 'text-slate-800'));
      const mddValStr = state.balancePrivacyHidden
        ? `${state.currencySymbol} ••••`
        : (Math.abs(dMddAmt) < 5 ? 'เท่ากัน' : `${dMddAmt < 0 ? '-' : '+'}${formatMoney(Math.abs(dMddAmt), 0, false)}`);
      const mddSub = Math.abs(dMddAmt) < 5 ? `ใกล้เคียง ${refShort}` : (dMddAmt < 0 ? `ลงน้อยกว่า ${refShort}` : `ลงลึกกว่า ${refShort}`);

      const headerCaption = isBaselineActive
        ? `คุณกำลังดูแผนฐาน 1/N • เทียบกับ "คุ้มความเสี่ยงสูงสุด"`
        : `ส่วนต่างแผนนี้เทียบกับ "ซื้อหารเท่ากัน (1/N)"`;

      verdictEl.innerHTML = `
        <div class="text-xs font-bold text-slate-600">${headerCaption}</div>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          <div class="qf-delta-tile ${retTone} min-w-0">
            <div class="text-[11px] font-semibold text-slate-500">ผลตอบแทน/ปี</div>
            <div class="text-base sm:text-lg font-extrabold font-mono ${retNumCls} mt-0.5 tabular-nums">${dRet >= 0 ? '+' : ''}${dRet.toFixed(1)}%</div>
            <div class="text-[11px] font-medium text-slate-600">${retSub}</div>
          </div>
          <div class="qf-delta-tile ${volTone} min-w-0">
            <div class="text-[11px] font-semibold text-slate-500">ความผันผวน/ปี</div>
            <div class="text-base sm:text-lg font-extrabold font-mono ${volNumCls} mt-0.5 tabular-nums">${dVol >= 0 ? '+' : ''}${dVol.toFixed(1)}%</div>
            <div class="text-[11px] font-medium text-slate-600">${volSub}</div>
          </div>
          <div class="qf-delta-tile ${mddTone} min-w-0">
            <div class="text-[11px] font-semibold text-slate-500">ช่วงลงหนักสุด</div>
            <div class="text-base sm:text-lg font-extrabold font-mono ${mddNumCls} mt-0.5 tabular-nums">${mddValStr}</div>
            <div class="text-[11px] font-medium text-slate-600">${mddSub}</div>
          </div>
        </div>
      `;
    }
  }
}

function renderDimeWealthOverview() {
  const netWorthEl = document.getElementById('dime-total-net-worth');
  if (!netWorthEl) return;

  const fx = state.fxRate > 0 ? state.fxRate : 34.50;
  const isThb = state.currency === 'THB';
  const mainBudget = parseNumericInput(document.getElementById('budget-input')?.value) || state.budget || (isThb ? 100000 : 3000);
  const usingCustomBudget = state.rebalanceMode === 'custom' && state.lastRebalancePlan && state.lastRebalancePlan.totalPortfolioBudget > 0;
  const budget = usingCustomBudget ? state.lastRebalancePlan.totalPortfolioBudget : mainBudget;
  const totalThb = isThb ? budget : budget * fx;
  const totalUsd = isThb ? (budget / fx) : budget;

  const data = state.optData;
  const hasStrat = Boolean(data?.strategies?.[state.activeGoal] && (state.resultStatus === 'ready' || state.resultStatus === 'stale'));
  const strat = hasStrat ? data.strategies[state.activeGoal] : null;
  const allTickers = data?.metadata?.tickers || state.tickers || [];

  const subEl = document.getElementById('dime-total-net-worth-sub');
  const stratLabelEl = document.getElementById('dime-active-strat-label');
  const modeLabelEl = document.getElementById('dime-alloc-mode-label');
  const allocMetaEl = document.getElementById('dime-holdings-allocated-meta');

  // 1. Render Left Card: Visual Strategy Comparison vs Equal Weight (1/N) & Other Plans
  renderStrategyComparisonCard(data, strat, mainBudget);

  if (!strat) {
    netWorthEl.innerText = state.balancePrivacyHidden ? `${state.currencySymbol} ••••••••` : formatMoney(budget, 2, false);
    if (subEl) subEl.innerText = 'ยังไม่ได้คำนวณผลพอร์ต';
    if (stratLabelEl) stratLabelEl.innerText = 'ยังไม่ได้คำนวณผลพอร์ต';
    if (modeLabelEl) modeLabelEl.innerText = `${allTickers.length} สินทรัพย์`;
    if (allocMetaEl) allocMetaEl.innerText = 'กดคำนวณเพื่อดูสัดส่วนเป้าหมาย';
  } else {
    if (stratLabelEl) {
      const thNames = {
        max_sharpe: 'คุ้มความเสี่ยงสูงสุด',
        min_volatility: 'ผันผวนต่ำ',
        hrp: 'กระจายเสี่ยงสมดุล',
        equal_weight: 'ซื้อหารเท่ากัน (1/N)'
      };
      stratLabelEl.innerText = `แผนที่เลือก: ${thNames[state.activeGoal] || strat.name}`;
    }
    if (state.balancePrivacyHidden) {
      netWorthEl.innerText = `${state.currencySymbol} ••••••••`;
      if (subEl) subEl.innerText = isThb ? '≈ $ •••••• USD' : '≈ ฿ •••••••• THB';
    } else {
      netWorthEl.innerText = formatMoney(budget, 2, false);
      if (subEl) {
        subEl.innerText = isThb
          ? `≈ $${totalUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`
          : `≈ ฿${totalThb.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} THB`;
      }
    }
  }

  // Build sorted list of portfolio assets with their real calculated weights
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

  const activeWeighted = stockItems.filter(it => it.weight > 0.0005);
  const totalWeightPct = stockItems.reduce((acc, it) => acc + it.weight, 0) * 100;

  if (strat) {
    if (modeLabelEl) modeLabelEl.innerText = `${stockItems.length} สินทรัพย์ • ${totalWeightPct.toFixed(0)}%`;
    const customSuffix = (usingCustomBudget && Math.abs(budget - mainBudget) > 0.5) ? ' (อิงพอร์ตเดิม)' : '';
    if (allocMetaEl) allocMetaEl.innerText = `จัดสรร ${activeWeighted.length} จาก ${stockItems.length} สินทรัพย์ • รวม ${totalWeightPct.toFixed(1)}%${customSuffix}`;
  }

  // 2. Render Unified Stacked Allocation Ribbon (Top of Right Card)
  const barEl = document.getElementById('dime-alloc-stacked-bar');
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

  // 3. Render Complete Per-Asset Breakdown List (Top-Aligned, Zero Clipping)
  const listEl = document.getElementById('dime-holdings-card-list');
  const expandWrap = document.getElementById('dime-holdings-expand-wrap');
  const expandBtn = document.getElementById('dime-holdings-expand-btn');
  if (!listEl) return;

  if (stockItems.length === 0) {
    listEl.innerHTML = `<div class="p-4 text-center dime-label-12">กรุณาเลือกสินทรัพย์ในพอร์ตอย่างน้อย 2 รายการ</div>`;
    if (expandWrap) expandWrap.classList.add('hidden');
    return;
  }

  const MAX_INITIAL_ROWS = 6;
  const shouldTruncate = stockItems.length > MAX_INITIAL_ROWS && !state.holdingsListExpanded;
  const visibleItems = shouldTruncate ? stockItems.slice(0, MAX_INITIAL_ROWS) : stockItems;

  if (expandWrap && expandBtn) {
    if (stockItems.length > MAX_INITIAL_ROWS) {
      expandWrap.classList.remove('hidden');
      expandBtn.innerText = state.holdingsListExpanded
        ? 'ย่อรายการสินทรัพย์'
        : `ดูสินทรัพย์ครบทั้งหมด (${stockItems.length} ตัว)`;
    } else {
      expandWrap.classList.add('hidden');
    }
  }

  const roundedWeightMap = roundWeightsToOneDecimalSum100(stockItems);

  listEl.innerHTML = visibleItems.map(it => {
    const safeTicker = escapeHtmlText(it.ticker);
    const safeName = escapeHtmlText(it.name !== it.ticker ? it.name : (it.ticker.endsWith('.BK') ? 'ตลาดหลักทรัพย์ไทย (SET)' : 'Global Asset'));
    const wPctNum = it.weight * 100;
    const wPct = roundedWeightMap.get(it.ticker) || wPctNum.toFixed(1);
    const isZero = it.weight <= 0.0005;
    const targetValCurrent = budget * it.weight;
    const targetValThb = isThb ? targetValCurrent : targetValCurrent * fx;
    const targetValUsd = isThb ? (targetValCurrent / fx) : targetValCurrent;

    // Price per unit in current currency using unified FX converter
    let unitPriceCurrent = getEffectiveAssetPrice(it.ticker, state.currency, fx);
    const estUnits = (unitPriceCurrent > 0 && targetValCurrent > 0)
      ? formatShareUnits(targetValCurrent / unitPriceCurrent, targetValCurrent / unitPriceCurrent < 1 ? 4 : 2)
      : '0';

    const assetRet = it.stat.expected_return !== undefined
      ? Number(it.stat.expected_return)
      : ((it.quote.change_pct || 0) / 100);
    const assetRetPct = (Math.abs(assetRet) * 100).toFixed(2);
    const assetIsUp = assetRet >= 0;
    const retLabel = it.stat.expected_return !== undefined
      ? `${assetIsUp ? '+' : '-'}${assetRetPct}%/ปี`
      : `${assetIsUp ? '+' : '-'}${assetRetPct}% วันนี้`;

    const primaryStr = isThb
      ? `฿${targetValThb.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : `$${targetValUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const secondaryStr = isThb
      ? `$${targetValUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : `฿${targetValThb.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

    const valDisplay = state.balancePrivacyHidden
      ? `${state.currencySymbol} ••••••`
      : `${primaryStr} <span class="hidden sm:inline text-xs font-normal text-slate-500">(${secondaryStr})</span>`;

    const weightPill = isZero
      ? `<span class="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-slate-100 text-slate-500 border border-slate-200/80 tabular-nums">ไม่จัดสรร 0%</span>`
      : `<span class="text-xs font-mono font-semibold px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 border border-slate-200/90 tabular-nums">${wPct}%</span>`;

    const barWidth = isZero ? 0 : Math.max(2, Math.min(100, wPctNum));

    return `
      <div class="dime-holding-row ${isZero ? 'qf-holding-row-zero' : ''} !flex-col !items-stretch !gap-2 !py-2.5 !px-3.5 cursor-pointer" onclick="syncHoldingsWithQuantPlan()">
        <div class="flex items-center justify-between gap-2.5">
          <div class="flex items-center gap-2.5 min-w-0">
            ${renderStockLogoBadge(it.ticker, it.color, 36)}
            <div class="min-w-0">
              <div class="flex items-center gap-1.5 flex-wrap">
                <span class="font-bold text-sm text-[#1A1D1F] font-mono">${safeTicker}</span>
                ${weightPill}
              </div>
              <div class="dime-label-12 !text-xs mt-0.5 flex flex-wrap items-center gap-x-1.5">
                <span class="truncate max-w-[130px] sm:max-w-[200px]">${safeName}</span>
                ${isZero ? '' : `<span class="whitespace-nowrap font-mono">• ~${estUnits} หน่วย</span>`}
              </div>
            </div>
          </div>
          <div class="text-right shrink-0">
            <div class="font-bold text-sm text-[#1A1D1F] tabular-nums">${valDisplay}</div>
            <div class="mt-0.5"><span class="${assetIsUp ? 'dime-pill-up' : 'dime-pill-down'} !text-[11px] !py-0 !px-2">${retLabel}</span></div>
          </div>
        </div>
        <div class="w-full h-1.5 rounded-full bg-slate-100 overflow-hidden">
          <div class="h-full rounded-full transition-all duration-300" style="width: ${barWidth.toFixed(1)}%; background-color: ${it.color};"></div>
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
      ? 'qf-seg-btn qf-seg-active px-2.5 py-1.5 rounded-lg font-semibold transition cursor-pointer inline-flex items-center gap-1'
      : 'qf-seg-btn qf-seg-inactive px-2.5 py-1.5 rounded-lg font-medium transition cursor-pointer inline-flex items-center gap-1';
  }
  if (btnTable) {
    btnTable.className = nextMode === 'table'
      ? 'qf-seg-btn qf-seg-active px-2.5 py-1.5 rounded-lg font-semibold transition cursor-pointer inline-flex items-center gap-1'
      : 'qf-seg-btn qf-seg-inactive px-2.5 py-1.5 rounded-lg font-medium transition cursor-pointer inline-flex items-center gap-1';
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
  const blPct = Math.round((Number.isFinite(state.blConfidence) ? state.blConfidence : 0.5) * 100);
  const newsText = state.useNewsAdjustment ? `Black-Litterman (${blPct}%)` : 'สถิติอดีตล้วน';
  el.innerText = `FX ${fxVal.toFixed(2)} • ${yearsText} • ${weightText} • ${newsText}`;
}

function switchHelpGuideTab(tabKey = 'guide') {
  const valid = ['guide', 'privacy', 'terms'];
  const active = valid.includes(tabKey) ? tabKey : 'guide';
  const titleMap = {
    guide: 'คู่มือการใช้งานแบบรวดเร็ว (Quick Guide)',
    privacy: 'นโยบายความเป็นส่วนตัวและการคุ้มครองข้อมูล (PDPA)',
    terms: 'เงื่อนไขการใช้งานและข้อจำกัดของระบบ (Terms of Use)'
  };
  const titleEl = document.getElementById('help-guide-modal-title');
  if (titleEl) titleEl.textContent = titleMap[active];

  valid.forEach(k => {
    const btn = document.getElementById(`help-tab-btn-${k}`);
    const panel = document.getElementById(`help-tab-panel-${k}`);
    const isAct = k === active;
    if (btn) {
      btn.classList.toggle('active', isAct);
      btn.setAttribute('aria-selected', isAct ? 'true' : 'false');
      if (isAct) {
        btn.classList.add('bg-white', 'text-slate-900', 'shadow-2xs');
        btn.classList.remove('text-slate-600');
      } else {
        btn.classList.remove('bg-white', 'text-slate-900', 'shadow-2xs');
        btn.classList.add('text-slate-600');
      }
    }
    if (panel) panel.classList.toggle('hidden', !isAct);
  });
}

function openHelpGuideModal(initialTab = 'guide') {
  const modal = document.getElementById('help-guide-modal');
  if (modal) {
    switchHelpGuideTab(initialTab);
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

function setGoalInflationRate(rate, shouldRecalc = true) {
  const numRate = Number(rate);
  state.goalInflationRate = [0, 2.5, 3, 3.0].includes(numRate) ? numRate : 0;

  const btnMap = [
    ['goal-infl-0', 0],
    ['goal-infl-25', 2.5],
    ['goal-infl-30', 3.0]
  ];
  btnMap.forEach(([id, r]) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    const isActive = Math.abs(state.goalInflationRate - r) < 0.05;
    btn.className = isActive
      ? 'qf-seg-btn qf-seg-active px-2.5 py-1 rounded-lg font-semibold transition cursor-pointer'
      : 'qf-seg-btn qf-seg-inactive px-2.5 py-1 rounded-lg font-medium transition cursor-pointer';
  });

  const helperEl = document.getElementById('goal-inflation-helper');
  if (helperEl) {
    helperEl.innerText = state.goalInflationRate > 0
      ? `คำนวณเปรียบเทียบมูลค่าอำนาจซื้อเทียบเท่าเงินวันนี้ (หักเงินเฟ้อ ${state.goalInflationRate.toFixed(1)}%/ปี)`
      : 'แสดงมูลค่าพอร์ตตามตัวเลขจริง (Nominal)';
  }

  if (shouldRecalc) recalculateGoalProjection();
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
  const goalInitEl = document.getElementById('save-initial-budget');

  const tplBudget = isThb ? tpl.budget_thb : tpl.budget_usd;
  const tplTarget = isThb ? tpl.target_thb : tpl.target_usd;
  const tplDca = isThb ? tpl.dca_thb : tpl.dca_usd;
  const formattedBudget = formatNumberWithCommas(tplBudget, 0);
  if (nameEl) nameEl.value = tpl.name;
  if (catEl) catEl.value = tpl.category;
  if (targetEl) targetEl.value = formatNumberWithCommas(tplTarget, 0);
  if (dcaEl) dcaEl.value = formatNumberWithCommas(tplDca, 0);
  if (yearsEl) yearsEl.value = tpl.years;
  if (budgetEl) budgetEl.value = formattedBudget;
  if (stripBudgetEl) stripBudgetEl.value = formattedBudget;
  if (goalInitEl) goalInitEl.value = formattedBudget;
  state.budget = tplBudget;
  setCanonicalFxField('budget', tplBudget, state.currency);
  setCanonicalFxField('target', tplTarget, state.currency);
  setCanonicalFxField('dca', tplDca, state.currency);

  if (typeof cancelEditingSavedPortfolio === 'function') {
    cancelEditingSavedPortfolio();
  }

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
  const shouldApplyTickers = applyTickersToggle ? applyTickersToggle.checked : false;

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

function allocateExactIntegers(totalAmount, weightsArr) {
  const targetInt = Math.round(Number(totalAmount || 0));
  if (!Array.isArray(weightsArr) || weightsArr.length === 0 || targetInt <= 0) {
    return (weightsArr || []).map(() => 0);
  }
  const sumW = weightsArr.reduce((acc, w) => acc + Math.max(0, Number(w || 0)), 0);
  if (sumW <= 0) return weightsArr.map(() => 0);

  const exact = weightsArr.map(w => (Math.max(0, Number(w || 0)) / sumW) * targetInt);
  const floors = exact.map(v => Math.floor(v));
  const remainder = targetInt - floors.reduce((a, b) => a + b, 0);

  const order = exact
    .map((v, idx) => ({ idx, frac: v - floors[idx], weight: Number(weightsArr[idx] || 0) }))
    .sort((a, b) => (b.frac - a.frac) || (b.weight - a.weight) || (a.idx - b.idx));

  for (let i = 0; i < remainder && i < order.length; i++) {
    floors[order[i].idx] += 1;
  }
  return floors;
}

function computeGoalProjectionMetrics(overridePortfolio = null) {
  const isOverride = Boolean(overridePortfolio && typeof overridePortfolio === 'object');
  const initialBudget = isOverride
    ? (Number(overridePortfolio.initial_budget) || 100000)
    : (parseNumericInput(document.getElementById('save-initial-budget')?.value) || parseNumericInput(document.getElementById('budget-input')?.value) || 100000);
  const targetAmount = isOverride
    ? (Number(overridePortfolio.target_amount) || 1000000)
    : (parseNumericInput(document.getElementById('save-target-amount')?.value) || 1000000);
  const monthlyDca = isOverride
    ? Math.max(0, Number(overridePortfolio.monthly_dca ?? 0))
    : Math.max(0, parseNumericInput(document.getElementById('save-monthly-dca')?.value) || 0);
  const years = isOverride
    ? Math.max(1, Math.min(50, parseInt(overridePortfolio.investment_period_years, 10) || 5))
    : Math.max(1, Math.min(50, parseInt(document.getElementById('save-period-years')?.value, 10) || 5));
  const goalCategory = isOverride
    ? (overridePortfolio.goal_type || 'retirement')
    : (document.getElementById('save-goal-category')?.value || 'retirement');
  const inflationRate = isOverride
    ? Math.max(0, Number(overridePortfolio.inflation_rate || 0))
    : Math.max(0, Number(state.goalInflationRate || 0));

  const goalCategoryLabels = {
    retirement: 'พอร์ตเกษียณมั่นคง',
    dividend: 'พอร์ตสร้างเงินปันผล',
    growth: 'พอร์ตเติบโตสูง',
    preservation: 'พอร์ตพักเงินปลอดภัย',
    custom: 'กำหนดเป้าหมายเอง'
  };
  const strategyThaiMap = {
    max_sharpe: 'คุ้มความเสี่ยงสูงสุด (Max Sharpe)',
    min_volatility: 'ผันผวนต่ำ (Min Volatility)',
    hrp: 'กระจายสมดุล (Risk Parity / HRP)',
    equal_weight: 'แบ่งเท่ากันทุกตัว (Equal Weight 1/N)'
  };

  const stratKey = isOverride ? (overridePortfolio.strategy_key || state.activeGoal) : state.activeGoal;
  const hasRealOptData = isOverride
    ? true
    : Boolean(state.optData && state.optData.strategies && state.optData.strategies[stratKey]);

  let rawExpectedReturn = 0.0;
  let annualVol = 0.0;
  let divYield = 0.0;
  let strategyName = strategyThaiMap[stratKey] || 'ยังไม่ได้คำนวณ';
  let weightsDecimal = {};

  if (isOverride) {
    rawExpectedReturn = Number(overridePortfolio.expected_return ?? 0.08);
    annualVol = Number(overridePortfolio.expected_volatility ?? 0.14);
    divYield = Number(overridePortfolio.dividend_yield ?? 0.02);
    const aw = overridePortfolio.asset_weights || {};
    Object.entries(aw).forEach(([t, pct]) => {
      const dec = Number(pct) > 1 ? Number(pct) / 100 : Number(pct);
      if (dec > 0) weightsDecimal[t] = dec;
    });
  } else if (hasRealOptData) {
    const strat = state.optData.strategies[stratKey];
    rawExpectedReturn = Number(strat.expected_return || 0);
    annualVol = Number(strat.volatility || 0);
    divYield = Number(strat.dividend_yield !== undefined ? strat.dividend_yield : 0);
    weightsDecimal = strat.weights || {};
  }

  // Prudent long-term compounding cap (prevent extreme multi-year distortion while preserving strategy differences)
  const effectiveAnnualReturn = hasRealOptData ? Math.max(0.02, Math.min(0.28, rawExpectedReturn)) : 0.0;
  const bullAnnualReturn = hasRealOptData ? Math.min(0.36, effectiveAnnualReturn + 0.25 * annualVol) : 0.0;
  const conservativeAnnualReturn = hasRealOptData ? Math.max(-0.05, effectiveAnnualReturn - 0.30 * annualVol) : 0.0;

  const yearsAxis = [];
  const principalSeries = [];
  const baseWealthSeries = [];
  const bullWealthSeries = [];
  const consWealthSeries = [];
  const realBaseWealthSeries = [];

  let curPrincipal = initialBudget;
  let curBase = initialBudget;
  let curBull = initialBudget;
  let curCons = initialBudget;

  const rBaseMonth = Math.pow(1 + effectiveAnnualReturn, 1 / 12) - 1;
  const rBullMonth = Math.pow(1 + bullAnnualReturn, 1 / 12) - 1;
  const rConsMonth = Math.pow(1 + conservativeAnnualReturn, 1 / 12) - 1;
  const inflDec = inflationRate / 100;

  for (let y = 0; y <= years; y++) {
    yearsAxis.push(`ปีที่ ${y}`);
    principalSeries.push(Math.round(curPrincipal));
    baseWealthSeries.push(Math.round(curBase));
    bullWealthSeries.push(Math.round(curBull));
    consWealthSeries.push(Math.round(curCons));
    const discount = inflDec > 0 ? Math.pow(1 + inflDec, y) : 1;
    realBaseWealthSeries.push(Math.round(curBase / discount));

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
  const consFinalWealth = consWealthSeries[consWealthSeries.length - 1];
  const bullFinalWealth = bullWealthSeries[bullWealthSeries.length - 1];
  const discountFinal = inflDec > 0 ? Math.pow(1 + inflDec, years) : 1;
  const realProjectedFinalWealth = Math.round(projectedFinalWealth / discountFinal);
  const realConsFinalWealth = Math.round(consFinalWealth / discountFinal);
  const realBullFinalWealth = Math.round(bullFinalWealth / discountFinal);

  const evalWealth = inflDec > 0 ? realProjectedFinalWealth : projectedFinalWealth;
  const netProfit = Math.max(0, projectedFinalWealth - totalPrincipal);
  const achievementPct = targetAmount > 0 ? Number(((evalWealth / targetAmount) * 100).toFixed(1)) : 100;
  const gapAmount = evalWealth - targetAmount;
  const estAnnualDividendAtEnd = Math.round(projectedFinalWealth * divYield);
  const estMonthlyDividendAtEnd = Math.round(estAnnualDividendAtEnd / 12);

  // Calculate required monthly DCA to reach targetAmount (adjusted for inflation when active)
  const totalMonths = years * 12;
  const nominalTargetNeeded = inflDec > 0 ? (targetAmount * discountFinal) : targetAmount;
  const fvInitial = initialBudget * Math.pow(1 + rBaseMonth, totalMonths);
  const annuityFactor = rBaseMonth > 0 ? ((Math.pow(1 + rBaseMonth, totalMonths) - 1) / rBaseMonth) : totalMonths;
  const requiredMonthlyDca = Math.max(0, Math.ceil((nominalTargetNeeded - fvInitial) / Math.max(1, annuityFactor)));

  // Build Per-Asset Allocation & Monthly DCA Schedule (Exact Largest-Remainder Rounding so rows ALWAYS sum to exact total)
  const assetStatsMap = {};
  (state.optData?.asset_stats || []).forEach(a => { assetStatsMap[a.ticker] = a; });
  const fx = Number(state.optData?.metadata?.usd_thb_rate || state.fxRate || 34.50);
  const curr = isOverride ? (overridePortfolio.currency || state.currency || 'THB') : (state.currency || 'THB');

  const activeWeightEntries = Object.entries(weightsDecimal)
    .filter(([, w]) => Number(w) > 0.0005)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  const rawWeightVals = activeWeightEntries.map(([, w]) => Number(w));
  const exactInitialAmts = allocateExactIntegers(initialBudget, rawWeightVals);
  const exactMonthlyDcaAmts = allocateExactIntegers(monthlyDca, rawWeightVals);
  const exactWeightBps = allocateExactIntegers(10000, rawWeightVals);

  const dcaSchedule = activeWeightEntries.map(([ticker, wDec], idx) => {
    const stat = assetStatsMap[ticker] || null;
    const initialAmt = exactInitialAmts[idx] ?? 0;
    const monthlyDcaAmt = exactMonthlyDcaAmts[idx] ?? 0;
    const weightPct = Number(((exactWeightBps[idx] ?? 0) / 100).toFixed(2));
    let estUnits = null;
    if (stat) {
      const natCurr = stat.native_currency || (ticker.endsWith('.BK') ? 'THB' : 'USD');
      const natPx = Number(stat.native_price || stat.latest_price || 0);
      const unitPx = convertNativePrice(natPx, natCurr, curr, fx);
      if (unitPx > 0) estUnits = initialAmt / unitPx;
    }
    return {
      ticker,
      name: stat && stat.name && stat.name !== ticker ? stat.name : '',
      weightPct,
      initialAmt,
      monthlyDcaAmt,
      estUnits,
      divYield: stat && stat.dividend_yield !== undefined ? Number(stat.dividend_yield) : divYield
    };
  });

  // Sample crisp yearly milestones (up to 7 rows including Year 1 and Final Year)
  const milestoneYearsSet = new Set([1, years]);
  if (years <= 6) {
    for (let y = 1; y <= years; y++) milestoneYearsSet.add(y);
  } else {
    const step = Math.max(1, Math.round(years / 5));
    for (let y = step; y < years; y += step) milestoneYearsSet.add(y);
  }
  const yearlyMilestones = Array.from(milestoneYearsSet)
    .filter(y => y >= 1 && y <= years)
    .sort((a, b) => a - b)
    .map(y => {
      const yDiscount = inflDec > 0 ? Math.pow(1 + inflDec, y) : 1;
      return {
        year: y,
        principal: principalSeries[y],
        conservative: consWealthSeries[y],
        base: baseWealthSeries[y],
        realBase: Math.round(baseWealthSeries[y] / yDiscount),
        bull: bullWealthSeries[y],
        estAnnualDividend: Math.round(baseWealthSeries[y] * divYield)
      };
    });

  return {
    hasRealOptData,
    strategyKey: stratKey,
    currency: curr,
    initialBudget,
    targetAmount,
    monthlyDca,
    years,
    inflationRate,
    goalCategory,
    goalLabel: (isOverride && overridePortfolio.goal_label) ? overridePortfolio.goal_label : (goalCategoryLabels[goalCategory] || 'พอร์ตตามเป้าหมาย'),
    strategyName,
    rawExpectedReturn,
    effectiveAnnualReturn,
    bullAnnualReturn,
    conservativeAnnualReturn,
    annualVol,
    divYield,
    totalPrincipal,
    projectedFinalWealth,
    consFinalWealth,
    bullFinalWealth,
    realProjectedFinalWealth,
    realConsFinalWealth,
    realBullFinalWealth,
    netProfit,
    achievementPct,
    gapAmount,
    estAnnualDividendAtEnd,
    estMonthlyDividendAtEnd,
    requiredMonthlyDca,
    yearsAxis,
    principalSeries,
    baseWealthSeries,
    realBaseWealthSeries,
    bullWealthSeries,
    consWealthSeries,
    dcaSchedule,
    yearlyMilestones
  };
}

function recalculateGoalProjection() {
  const m = computeGoalProjectionMetrics();
  window.lastGoalProjection = m;
  const isPrivate = !!state.balancePrivacyHidden;
  const hasInfl = m.inflationRate > 0;

  const subEl = document.getElementById('goal-projection-subtitle');
  if (subEl) {
    const wasCapped = m.rawExpectedReturn > 0.28 || m.rawExpectedReturn < 0.02;
    const capNote = wasCapped ? ' (คุมเพดานทบต้น 2%–28%/ปี)' : '';
    const inflNote = hasInfl ? ` • หักเงินเฟ้อ ${m.inflationRate.toFixed(1)}%/ปี` : '';
    subEl.innerText = `กลยุทธ์: ${m.strategyName} • ผลตอบแทนทบต้นจำลอง ${(m.effectiveAnnualReturn * 100).toFixed(2)}%/ปี${capNote} • ปันผลเฉลี่ย ${(m.divYield * 100).toFixed(2)}%/ปี${inflNote}`;
  }

  const totalPrinEl = document.getElementById('goal-proj-total-principal');
  const prinBreakEl = document.getElementById('goal-proj-principal-breakdown');
  if (totalPrinEl) totalPrinEl.innerText = maskIfPrivate(formatMoney(m.totalPrincipal, 0, true), true);
  if (prinBreakEl) {
    const dcaTotal = m.monthlyDca * 12 * m.years;
    prinBreakEl.innerText = `ก้อนแรก ${maskIfPrivate(formatMoney(m.initialBudget, 0, false))} + ออมสะสม ${maskIfPrivate(formatMoney(dcaTotal, 0, false))}`;
  }

  const finalWealthEl = document.getElementById('goal-proj-final-wealth');
  const netProfitEl = document.getElementById('goal-proj-net-profit');
  if (finalWealthEl) {
    const headlineWealth = hasInfl ? m.realProjectedFinalWealth : m.projectedFinalWealth;
    finalWealthEl.innerText = maskIfPrivate(formatMoney(headlineWealth, 0, true), true);
  }
  if (netProfitEl) {
    if (hasInfl) {
      netProfitEl.innerText = `มูลค่าจริงวันนี้ (ตัวเลขรวม ${maskIfPrivate(formatMoney(m.projectedFinalWealth, 0, false))})`;
    } else {
      netProfitEl.innerText = `กำไรทบต้นสุทธิ +${maskIfPrivate(formatMoney(m.netProfit, 0, true), true)}`;
    }
  }

  const annDivEl = document.getElementById('goal-proj-annual-dividend');
  const monDivEl = document.getElementById('goal-proj-monthly-dividend');
  if (annDivEl) annDivEl.innerText = `${maskIfPrivate(formatMoney(m.estAnnualDividendAtEnd, 0, true), true)} / ปี`;
  if (monDivEl) {
    monDivEl.innerText = `เฉลี่ยเดือนละ ${maskIfPrivate(formatMoney(m.estMonthlyDividendAtEnd, 0, true), true)} (Yield ${(m.divYield * 100).toFixed(2)}%)`;
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

  const shownFinal = hasInfl ? m.realProjectedFinalWealth : m.projectedFinalWealth;
  const shownLabel = hasInfl ? `มูลค่าจริงเทียบเงินวันนี้` : `มูลค่าพอร์ตคาดการณ์`;

  if (m.achievementPct >= 100) {
    if (gapEl) {
      gapEl.innerText = `เกินเป้า +${maskIfPrivate(formatMoney(Math.abs(m.gapAmount), 0, false))}`;
      gapEl.className = 'text-xs font-bold text-emerald-700';
    }
    if (statusBadge) {
      statusBadge.innerText = `บรรลุเป้าหมาย (${m.achievementPct}%)`;
      statusBadge.className = 'px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 border border-emerald-300 self-start sm:self-center';
    }
    if (adviceBox) {
      adviceBox.className = 'p-4 rounded-2xl bg-emerald-50/40 border border-emerald-200 text-xs text-slate-800 leading-relaxed';
      adviceBox.innerHTML = `
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <b class="text-emerald-900">สรุปแผนพิชิตเป้าหมาย: มีความเป็นไปได้สูงที่จะบรรลุเป้า ${maskIfPrivate(formatMoney(m.targetAmount, 0, true), true)} ภายใน ${m.years} ปี</b>
            <div class="text-xs text-slate-600 mt-1">
              เริ่มเงินก้อนแรก <b>${maskIfPrivate(formatMoney(m.initialBudget, 0, true), true)}</b> + ออมเพิ่ม <b>${maskIfPrivate(formatMoney(m.monthlyDca, 0, true), true)}/เดือน</b> ภายใต้กลยุทธ์ <b>${m.strategyName}</b> คาดว่า${shownLabel}จะอยู่ที่ <b>${maskIfPrivate(formatMoney(shownFinal, 0, true), true)}</b> (ปันผลปลายทางราว <b>${maskIfPrivate(formatMoney(m.estMonthlyDividendAtEnd, 0, true), true)}/เดือน</b>)
            </div>
          </div>
        </div>
      `;
    }
  } else {
    const extraDcaNeeded = Math.max(0, m.requiredMonthlyDca - m.monthlyDca);
    if (gapEl) {
      gapEl.innerText = `ขาดอีก ${maskIfPrivate(formatMoney(Math.abs(m.gapAmount), 0, false))}`;
      gapEl.className = 'text-xs font-bold text-amber-700';
    }
    if (statusBadge) {
      statusBadge.innerText = `คาดว่าจะได้ ${m.achievementPct}% ของเป้าหมาย`;
      statusBadge.className = 'px-2.5 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-900 border border-amber-300 self-start sm:self-center';
    }
    if (adviceBox) {
      adviceBox.className = 'p-4 rounded-2xl bg-amber-50 border border-amber-300 text-xs text-slate-800 leading-relaxed';
      adviceBox.innerHTML = `
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <b class="text-amber-950">คำแนะนำเพื่อพิชิตเป้า ${maskIfPrivate(formatMoney(m.targetAmount, 0, true), true)} ให้ครบ 100% ภายใน ${m.years} ปี:</b>
            <div class="text-xs text-slate-700 mt-1">
              ปัจจุบัน${shownLabel}อยู่ที่ <b>${maskIfPrivate(formatMoney(shownFinal, 0, true), true)}</b> (ยังขาดอีก <b>${maskIfPrivate(formatMoney(Math.abs(m.gapAmount), 0, true), true)}</b>) แนะนำเพิ่มออมรายเดือน (DCA) อีก <b>+${maskIfPrivate(formatMoney(extraDcaNeeded, 0, true), true)}/เดือน</b> เป็นเดือนละ <b>${maskIfPrivate(formatMoney(m.requiredMonthlyDca, 0, true), true)}</b>
            </div>
          </div>
          <button
            type="button"
            onclick="document.getElementById('save-monthly-dca').value='${formatNumberWithCommas(m.requiredMonthlyDca, 0)}'; recalculateGoalProjection();"
            class="px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold shrink-0 transition cursor-pointer"
          >
            ปรับ DCA เป็น ${maskIfPrivate(formatMoney(m.requiredMonthlyDca, 0, false))}/เดือน ทันที
          </button>
        </div>
      `;
    }
  }

  // Render 3-Scenario Comparison Strip (Conservative / Base / Bull)
  const scenStripEl = document.getElementById('goal-scenarios-strip');
  if (scenStripEl) {
    const scenarios = [
      {
        title: 'กรณีตลาดซบเซา (Conservative)',
        rate: m.conservativeAnnualReturn,
        val: hasInfl ? m.realConsFinalWealth : m.consFinalWealth,
        nominalVal: m.consFinalWealth,
        cardCls: 'bg-rose-50/40 border-rose-200',
        titleCls: 'text-rose-800',
        valCls: 'text-rose-700'
      },
      {
        title: 'กรณีฐาน (Base Case)',
        rate: m.effectiveAnnualReturn,
        val: hasInfl ? m.realProjectedFinalWealth : m.projectedFinalWealth,
        nominalVal: m.projectedFinalWealth,
        cardCls: 'bg-emerald-50/35 border-emerald-200',
        titleCls: 'text-emerald-800',
        valCls: 'text-emerald-700'
      },
      {
        title: 'กรณีตลาดดี (Bull Case)',
        rate: m.bullAnnualReturn,
        val: hasInfl ? m.realBullFinalWealth : m.bullFinalWealth,
        nominalVal: m.bullFinalWealth,
        cardCls: 'bg-blue-50/35 border-blue-200',
        titleCls: 'text-blue-800',
        valCls: 'text-blue-700'
      }
    ];
    scenStripEl.innerHTML = scenarios.map(sc => {
      const pctOfTarget = m.targetAmount > 0 ? ((sc.val / m.targetAmount) * 100).toFixed(0) : '100';
      const inflSub = hasInfl ? ` • ตัวเลขจริง ${maskIfPrivate(formatMoney(sc.nominalVal, 0, false))}` : '';
      return `
        <div class="px-3.5 py-2.5 rounded-2xl border ${sc.cardCls} min-w-0">
          <div class="flex items-center justify-between gap-1 text-[11px] font-semibold ${sc.titleCls}">
            <span class="truncate">${sc.title}</span>
            <span class="font-mono shrink-0">${(sc.rate * 100).toFixed(1)}%/ปี</span>
          </div>
          <div class="flex items-baseline justify-between gap-2 mt-0.5 flex-wrap">
            <span class="font-mono text-sm sm:text-[15px] font-bold ${sc.valCls} tabular-nums">${maskIfPrivate(formatMoney(sc.val, 0, true), true)}</span>
            <span class="font-mono text-[11px] font-semibold text-slate-600 tabular-nums">${pctOfTarget}% ของเป้า${inflSub}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  // Render Per-Asset Monthly DCA Allocation Table
  const dcaBodyEl = document.getElementById('goal-dca-schedule-body');
  const dcaTotalPill = document.getElementById('goal-dca-schedule-total-pill');
  if (dcaTotalPill) {
    dcaTotalPill.innerText = `DCA: ${maskIfPrivate(formatMoney(m.monthlyDca, 0, true), true)}/เดือน`;
  }
  if (dcaBodyEl) {
    if (!m.dcaSchedule || m.dcaSchedule.length === 0) {
      dcaBodyEl.innerHTML = `<tr><td colspan="5" class="py-4 px-3 text-center text-slate-500 font-sans">กดคำนวณพอร์ตในหน้าตั้งค่าเพื่อดูตารางแบ่งเงิน DCA รายสินทรัพย์</td></tr>`;
    } else {
      const rowsHtml = m.dcaSchedule.map((row, idx) => {
        const color = ASSET_COLORS[idx % ASSET_COLORS.length];
        return `
          <tr>
            <td class="py-2 px-3 font-sans">
              <div class="flex items-center gap-2 min-w-0">
                ${renderStockLogoBadge(row.ticker, color, 22)}
                <div class="min-w-0">
                  <div class="font-mono font-bold text-slate-900 leading-tight">${escapeHtmlText(row.ticker)}</div>
                  ${row.name ? `<div class="text-[10px] text-slate-500 truncate max-w-[160px]">${escapeHtmlText(row.name)}</div>` : ''}
                </div>
              </div>
            </td>
            <td class="py-2 px-3 text-right font-bold text-slate-800 tabular-nums whitespace-nowrap">${row.weightPct.toFixed(2)}%</td>
            <td class="py-2 px-3 text-right text-slate-700 tabular-nums whitespace-nowrap">${maskIfPrivate(formatMoney(row.initialAmt, 0, false))}</td>
            <td class="py-2 px-3 text-right font-bold text-emerald-700 tabular-nums whitespace-nowrap">${maskIfPrivate(formatMoney(row.monthlyDcaAmt, 0, false))}/ด.</td>
            <td class="py-2 px-3 text-right text-slate-600 tabular-nums whitespace-nowrap">${(row.divYield * 100).toFixed(2)}%</td>
          </tr>
        `;
      }).join('');
      const totalRowHtml = `
        <tr class="bg-slate-50 font-bold border-t border-slate-200">
          <td class="py-2.5 px-3 font-sans text-slate-900">รวมทั้งหมด (${m.dcaSchedule.length} สินทรัพย์)</td>
          <td class="py-2.5 px-3 text-right text-slate-900 tabular-nums">100.00%</td>
          <td class="py-2.5 px-3 text-right text-slate-900 tabular-nums">${maskIfPrivate(formatMoney(Math.round(m.initialBudget), 0, false))}</td>
          <td class="py-2.5 px-3 text-right text-emerald-700 tabular-nums">${maskIfPrivate(formatMoney(Math.round(m.monthlyDca), 0, false))}/ด.</td>
          <td class="py-2.5 px-3 text-right text-blue-700 tabular-nums">${(m.divYield * 100).toFixed(2)}%</td>
        </tr>
      `;
      dcaBodyEl.innerHTML = rowsHtml + totalRowHtml;
    }
  }

  // Populate Tab 5 Deep-Dive: Yearly 3-Scenario Milestone Table (#goal-milestone-table-body)
  const msBodyEl = document.getElementById('goal-milestone-table-body');
  if (msBodyEl && Array.isArray(m.yearlyMilestones)) {
    msBodyEl.innerHTML = m.yearlyMilestones.map(ms => {
      const yDiscount = hasInfl ? Math.pow(1 + (m.inflationRate / 100), ms.year) : 1;
      const consVal = hasInfl ? Math.round(ms.conservative / yDiscount) : ms.conservative;
      const baseVal = hasInfl ? ms.realBase : ms.base;
      const bullVal = hasInfl ? Math.round(ms.bull / yDiscount) : ms.bull;
      const isFinal = ms.year === m.years;
      return `
        <tr class="${isFinal ? 'bg-emerald-50/40 font-bold' : ''}">
          <td class="py-2 px-3 font-sans font-semibold text-slate-800 whitespace-nowrap">ปีที่ ${ms.year}${isFinal ? ' (เป้าหมาย)' : ''}</td>
          <td class="py-2 px-3 text-right text-slate-700 tabular-nums whitespace-nowrap">${maskIfPrivate(formatMoney(ms.principal, 0, false))}</td>
          <td class="py-2 px-3 text-right text-amber-700 tabular-nums whitespace-nowrap">${maskIfPrivate(formatMoney(consVal, 0, false))}</td>
          <td class="py-2 px-3 text-right font-bold text-emerald-700 tabular-nums whitespace-nowrap">${maskIfPrivate(formatMoney(baseVal, 0, false))}</td>
          <td class="py-2 px-3 text-right text-blue-700 tabular-nums whitespace-nowrap">${maskIfPrivate(formatMoney(bullVal, 0, false))}</td>
          <td class="py-2 px-3 text-right text-slate-600 tabular-nums whitespace-nowrap">${maskIfPrivate(formatMoney(ms.estAnnualDividend, 0, false))}/ปี</td>
        </tr>
      `;
    }).join('');
  }

  clearTimeout(state.goalChartDebounceTimer);
  state.goalChartDebounceTimer = setTimeout(() => {
    renderGoalProjectionChart(m);
  }, 90);
}

function renderGoalProjectionChart(m) {
  const chartEl = document.getElementById('goal-projection-chart');
  if (!chartEl || typeof Plotly === 'undefined') return;

  const sym = state.currencySymbol;
  const isPrivate = !!state.balancePrivacyHidden;
  const hasInfl = m.inflationRate > 0;
  const baseSeriesToPlot = hasInfl ? m.realBaseWealthSeries : m.baseWealthSeries;
  const toPrivPct = (arr) => arr.map((v, idx) => {
    const p = Math.max(1, Number(m.principalSeries[idx] || m.initialBudget));
    return Number((((Number(v) - p) / p) * 100).toFixed(1));
  });

  const yBull = isPrivate ? toPrivPct(m.bullWealthSeries) : m.bullWealthSeries;
  const yBase = isPrivate ? toPrivPct(baseSeriesToPlot) : baseSeriesToPlot;
  const yCons = isPrivate ? toPrivPct(m.consWealthSeries) : m.consWealthSeries;
  const yPrin = isPrivate ? m.principalSeries.map(() => 0) : m.principalSeries;
  const yTarget = isPrivate
    ? m.yearsAxis.map((_, idx) => Number((((m.targetAmount - Math.max(1, m.principalSeries[idx])) / Math.max(1, m.principalSeries[idx])) * 100).toFixed(1)))
    : m.yearsAxis.map(() => m.targetAmount);

  const traceBull = {
    x: m.yearsAxis,
    y: yBull,
    name: 'กรณีตลาดดี (Bull)',
    type: 'scatter',
    mode: 'lines',
    line: { color: '#10b981', width: 1.5, dash: 'dot' },
    hovertemplate: isPrivate ? `%{x}: %{y:+.1f}%<extra>กรณีตลาดดี</extra>` : `%{x}: ${sym}%{y:,.0f}<extra>กรณีตลาดดี</extra>`
  };

  const dcaPrimary = isDarkTheme() ? '#10B981' : '#059669';
  const dcaFill = isDarkTheme() ? 'rgba(16, 185, 129, 0.14)' : 'rgba(5, 150, 105, 0.10)';
  const traceBase = {
    x: m.yearsAxis,
    y: yBase,
    name: hasInfl ? `มูลค่าจริงหลังเงินเฟ้อ (Base)` : 'พอร์ตคาดการณ์ (Base)',
    type: 'scatter',
    mode: 'lines+markers',
    marker: { size: 6, color: dcaPrimary },
    line: { color: dcaPrimary, width: 2.8 },
    fill: 'tonexty',
    fillcolor: dcaFill,
    hovertemplate: isPrivate ? `%{x}: %{y:+.1f}%<extra>พอร์ตคาดการณ์</extra>` : `%{x}: ${sym}%{y:,.0f}<extra>พอร์ตคาดการณ์</extra>`
  };

  const traceConservative = {
    x: m.yearsAxis,
    y: yCons,
    name: 'กรณีตลาดซบเซา (Conservative)',
    type: 'scatter',
    mode: 'lines',
    line: { color: '#E11D48', width: 1.8, dash: 'dot' },
    hovertemplate: isPrivate ? `%{x}: %{y:+.1f}%<extra>กรณีตลาดซบเซา</extra>` : `%{x}: ${sym}%{y:,.0f}<extra>กรณีตลาดซบเซา</extra>`
  };

  const tracePrincipal = {
    x: m.yearsAxis,
    y: yPrin,
    name: isPrivate ? 'ฐานเงินต้นสะสม (0%)' : 'เงินต้นสะสม (ก้อนแรก + DCA)',
    type: 'scatter',
    mode: 'lines+markers',
    marker: { size: 4, color: '#94A3B8' },
    line: { color: '#94A3B8', width: 2, dash: 'dash' },
    hovertemplate: isPrivate ? `%{x}: 0.0%<extra>เงินต้นสะสม</extra>` : `%{x}: ${sym}%{y:,.0f}<extra>เงินต้นสะสม</extra>`
  };

  const traceTarget = {
    x: m.yearsAxis,
    y: yTarget,
    name: isPrivate ? 'เป้าหมายที่ตั้งไว้' : `เป้าหมาย (${formatMoney(m.targetAmount, 0, false)})`,
    type: 'scatter',
    mode: 'lines',
    line: { color: '#FBBF24', width: 2, dash: 'dashdot' },
    hovertemplate: isPrivate ? `เป้าหมาย: %{y:+.1f}%<extra></extra>` : `เป้าหมาย: ${sym}%{y:,.0f}<extra></extra>`
  };

  const ct = getChartThemeTokens();
  const layout = {
    margin: { t: 22, r: 16, b: 36, l: isMobileViewport() ? 48 : 68 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: ct.plotBg,
    hoverlabel: ct.hoverLabel,
    dragmode: isMobileViewport() ? false : 'zoom',
    font: { family: 'Plus Jakarta Sans, Anuphan, sans-serif', size: isMobileViewport() ? 10 : 11, color: ct.axisText },
    xaxis: { gridcolor: ct.grid, linecolor: ct.line, color: ct.axisText },
    yaxis: isPrivate
      ? { title: 'กำไรเทียบเงินต้นสะสม (%)', gridcolor: ct.grid, linecolor: ct.line, color: ct.axisText, ticksuffix: '%', tickformat: '+.0f', automargin: true }
      : { gridcolor: ct.grid, linecolor: ct.line, color: ct.axisText, tickprefix: sym, separatethousands: true, automargin: true },
    legend: { orientation: 'h', y: 1.18, x: 0, font: { size: 10, color: ct.legendText } },
    hovermode: isMobileViewport() ? 'closest' : 'x unified'
  };

  Plotly.react(chartEl, [tracePrincipal, traceConservative, traceBase, traceBull, traceTarget], layout, getPlotlyConfig());
}

/* ==========================================================================
 * INSTITUTIONAL CLIENT PDF REPORT MODAL & 2-PAGE A4 VECTOR GENERATOR
 * Dual Compliance Mode: Public Simulation Report (default) + Licensed IC/IFA White-label
 * Typography: IBM Plex Sans Thai (Heading/Body) + IBM Plex Mono (Data/Tables)
 * ========================================================================== */
const PDF_PREPARER_PROFILE_KEY = 'qf_pdf_preparer_profile_v1';

const PDF_LICENSE_TYPE_META = {
  ic_plain: {
    code: 'ic_plain',
    roleGroup: 'IC',
    shortLabel: 'IC Plain (กลุ่ม 1)',
    fullLabel: 'ผู้แนะนำการลงทุนตราสารทั่วไป (IC Plain • กลุ่ม 1)',
    roleTitleTh: 'ผู้แนะนำการลงทุน (IC)',
    allocationScopeTh: 'สำรับการลงทุนเบื้องต้นตามหลักวิชาการมาตรฐาน (Basic Asset Allocation)',
    canCustomizeIndividual: false
  },
  ic_complex_2: {
    code: 'ic_complex_2',
    roleGroup: 'IC',
    shortLabel: 'IC Complex 2 (กลุ่ม 2)',
    fullLabel: 'ผู้แนะนำการลงทุนตราสารซับซ้อน ประเภท 2 (IC Complex 2 • กลุ่ม 2)',
    roleTitleTh: 'ผู้แนะนำการลงทุน (IC)',
    allocationScopeTh: 'สำรับการลงทุนเบื้องต้นตามหลักวิชาการมาตรฐาน (Basic Asset Allocation)',
    canCustomizeIndividual: false
  },
  ic_complex_3: {
    code: 'ic_complex_3',
    roleGroup: 'IC',
    shortLabel: 'IC Complex 3 (กลุ่ม 3)',
    fullLabel: 'ผู้แนะนำการลงทุนตราสารซับซ้อน ประเภท 3 (IC Complex 3 • กลุ่ม 3)',
    roleTitleTh: 'ผู้แนะนำการลงทุน (IC)',
    allocationScopeTh: 'สำรับการลงทุนเบื้องต้นตามหลักวิชาการมาตรฐาน (Basic Asset Allocation)',
    canCustomizeIndividual: false
  },
  ic_complex_1: {
    code: 'ic_complex_1',
    roleGroup: 'IC',
    shortLabel: 'IC Complex 1 (กลุ่ม 4)',
    fullLabel: 'ผู้แนะนำการลงทุนตราสารซับซ้อน ประเภท 1 (IC Complex 1 • กลุ่ม 4)',
    roleTitleTh: 'ผู้แนะนำการลงทุน (IC)',
    allocationScopeTh: 'สำรับการลงทุนเบื้องต้นตามหลักวิชาการมาตรฐาน (Basic Asset Allocation)',
    canCustomizeIndividual: false
  },
  ip: {
    code: 'ip',
    roleGroup: 'IP',
    shortLabel: 'IP (ผู้วางแผนการลงทุน • กลุ่ม 5)',
    fullLabel: 'ผู้วางแผนการลงทุน (IP : Investment Planner • กลุ่ม 5)',
    roleTitleTh: 'ผู้วางแผนการลงทุน (IP)',
    allocationScopeTh: 'การออกแบบแผนและจัดพอร์ตการลงทุนเฉพาะเจาะจงรายบุคคล (Customized Asset Allocation)',
    canCustomizeIndividual: true
  }
};

const PDF_CLIENT_SEGMENT_META = {
  general: { code: 'general', shortLabel: 'ลูกค้าทั่วไป (Retail)', fullLabel: 'กลุ่ม 6: ลูกค้าทั่วไป (Retail / General Investor)', isVulnerable: false, isSenior: false },
  senior_exp: { code: 'senior_exp', shortLabel: 'ผู้สูงอายุ ≥60 ปี (มีประสบการณ์)', fullLabel: 'กลุ่ม 5: ลูกค้าสูงอายุ (อายุ ≥ 60 ปี) มีประสบการณ์และระบุเจตจำนง', isVulnerable: false, isSenior: true },
  vulnerable: { code: 'vulnerable', shortLabel: 'ผู้ลงทุนเปราะบาง (Vulnerable ≥60 ปี)', fullLabel: 'กลุ่ม 4: ลูกค้าที่มีความเปราะบาง (Vulnerable Investors: อายุ ≥ 60 ปี / ความรู้จำกัด)', isVulnerable: true, isSenior: true },
  hnw: { code: 'hnw', shortLabel: 'ผู้ลงทุนรายใหญ่ (HNW)', fullLabel: 'กลุ่ม 3: ผู้ลงทุนรายใหญ่ (HNW : High Net Worth)', isVulnerable: false, isSenior: false },
  uhnw: { code: 'uhnw', shortLabel: 'ผู้ลงทุนรายใหญ่พิเศษ (UHNW)', fullLabel: 'กลุ่ม 2: ผู้ลงทุนรายใหญ่พิเศษ (UHNW : Ultra High Net Worth)', isVulnerable: false, isSenior: false },
  institutional: { code: 'institutional', shortLabel: 'ผู้ลงทุนสถาบัน (II)', fullLabel: 'กลุ่ม 1: ผู้ลงทุนสถาบัน (II : Institutional Investor)', isVulnerable: false, isSenior: false }
};

const PDF_SUITABILITY_LEVEL_META = {
  auto: { code: 'auto', label: 'ตามกลยุทธ์ที่เลือก', maxVol: null, allowHighRisk: true },
  risk_1_low: { code: 'risk_1_low', label: 'ระดับ 1–2 (ความเสี่ยงต่ำ • ผันผวน ≤ 8%/ปี)', maxVol: 0.08, allowHighRisk: false },
  risk_2_mod_low: { code: 'risk_2_mod_low', label: 'ระดับ 3–4 (ปานกลางค่อนข้างต่ำ • ผันผวน ≤ 12%/ปี)', maxVol: 0.12, allowHighRisk: false },
  risk_3_mod_high: { code: 'risk_3_mod_high', label: 'ระดับ 5 (ปานกลางค่อนข้างสูง • ผันผวน ≤ 18%/ปี)', maxVol: 0.18, allowHighRisk: false },
  risk_4_high: { code: 'risk_4_high', label: 'ระดับ 6–7 (ความเสี่ยงสูง • ผันผวน ≤ 28%/ปี)', maxVol: 0.28, allowHighRisk: false },
  risk_5_very_high: { code: 'risk_5_very_high', label: 'ระดับ 8 (ความเสี่ยงสูงมาก / ซับซ้อน > 28%/ปี)', maxVol: 1.50, allowHighRisk: true }
};

function evaluatePdfFairDealingCompliance(metrics, opts = {}) {
  const m = metrics || computeGoalProjectionMetrics();
  const reportMode = opts.reportMode === 'advisor' ? 'advisor' : 'simulation';
  const advisorName = String(opts.advisorName || '').trim();
  const licenseNo = String(opts.licenseNo || '').trim();
  const isAdvisorMode = reportMode === 'advisor' && Boolean(advisorName && licenseNo);
  const licenseMeta = PDF_LICENSE_TYPE_META[opts.licenseType] || PDF_LICENSE_TYPE_META.ic_plain;
  const isIpLicense = isAdvisorMode && licenseMeta.roleGroup === 'IP';
  const isIcLicense = isAdvisorMode && licenseMeta.roleGroup === 'IC';

  const segMeta = isAdvisorMode
    ? (PDF_CLIENT_SEGMENT_META[opts.clientSegment] || PDF_CLIENT_SEGMENT_META.general)
    : PDF_CLIENT_SEGMENT_META.general;
  const suitMeta = isAdvisorMode
    ? (PDF_SUITABILITY_LEVEL_META[opts.clientSuitability] || PDF_SUITABILITY_LEVEL_META.auto)
    : PDF_SUITABILITY_LEVEL_META.auto;

  const schedule = Array.isArray(m.dcaSchedule) ? m.dcaSchedule : [];
  const highRiskTickers = [];
  const foreignTickers = [];
  schedule.forEach(item => {
    const t = String(item.ticker || '').toUpperCase();
    if (!t) return;
    if (t.endsWith('-USD') || ['BTC', 'ETH', 'SOL', 'DOGE', 'TQQQ', 'SOXL', 'ARKK'].includes(t)) {
      highRiskTickers.push(t);
    }
    if (!t.endsWith('.BK')) {
      foreignTickers.push(t);
    }
  });

  const annualVol = Number(m.annualVol || 0);
  const volPctText = `${(annualVol * 100).toFixed(2)}%/ปี`;
  const volExceedsSuitability = suitMeta.maxVol !== null && annualVol > (suitMeta.maxVol + 0.002);
  const highRiskExceedsSuitability = !suitMeta.allowHighRisk && highRiskTickers.length > 0;
  const vulnerableHighRiskAlert = segMeta.isVulnerable && (annualVol > 0.14 || highRiskTickers.length > 0);
  const suitabilityMismatch = Boolean(volExceedsSuitability || highRiskExceedsSuitability || vulnerableHighRiskAlert);
  const icPlainScopeWarning = Boolean((opts.licenseType || 'ic_plain') === 'ic_plain' && highRiskTickers.length > 0);

  // [2.3] Single-source compliance warning text shared identically between Config Modal live badge and PDF Page 2
  const hrSuffix = highRiskTickers.length ? ` หรือสินทรัพย์เสี่ยงสูง (${highRiskTickers.join(', ')})` : '';
  let mismatchReasonText = '';
  if ((volExceedsSuitability || highRiskExceedsSuitability) && vulnerableHighRiskAlert) {
    mismatchReasonText = `ความผันผวนพอร์ต (${volPctText})${hrSuffix} สูงกว่าระดับความเสี่ยงที่ระบุ (${suitMeta.label}) และสูงกว่าเกณฑ์แนะนำสำหรับผู้ลงทุนเปราะบาง (≤ 14%/ปี) ควรอธิบายความเสี่ยงและบันทึกความยินยอมเพิ่มเติม`;
  } else if (volExceedsSuitability || highRiskExceedsSuitability) {
    mismatchReasonText = `ความผันผวนพอร์ต (${volPctText})${hrSuffix} สูงกว่าระดับความเสี่ยงที่ระบุ (${suitMeta.label}) ผู้ลงทุนต้องรับทราบคำเตือนความเสี่ยงก่อนตัดสินใจ`;
  } else if (vulnerableHighRiskAlert) {
    mismatchReasonText = `ความผันผวนพอร์ต (${volPctText})${hrSuffix} สูงกว่าเกณฑ์แนะนำสำหรับผู้ลงทุนเปราะบาง (≤ 14%/ปี) ควรอธิบายความเสี่ยงและบันทึกความยินยอมเพิ่มเติม`;
  }

  let allocationScopeCode = 'SIMULATION';
  if (isIpLicense) {
    allocationScopeCode = 'CUSTOMIZED_ASSET_ALLOCATION';
  } else if (isIcLicense) {
    allocationScopeCode = 'BASIC_ASSET_ALLOCATION';
  }

  return {
    isAdvisorMode,
    isIpLicense,
    isIcLicense,
    allocationScopeCode,
    licenseMeta,
    segMeta,
    suitMeta,
    annualVol,
    volPctText,
    mismatchReasonText,
    highRiskTickers,
    foreignTickers,
    volExceedsSuitability,
    highRiskExceedsSuitability,
    vulnerableHighRiskAlert,
    suitabilityMismatch,
    icPlainScopeWarning,
    requiresKnowledgeAssessment: highRiskTickers.length > 0,
    hasFxRisk: foreignTickers.length > 0,
    chkFactsheet: opts.chkFactsheet !== false,
    chkKnowledge: opts.chkKnowledge !== false,
    chkNoforce: opts.chkNoforce !== false
  };
}

function readSavedPdfPreparerProfile() {
  try {
    const raw = localStorage.getItem(PDF_PREPARER_PROFILE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

function savePdfPreparerProfile(profile) {
  try {
    localStorage.setItem(PDF_PREPARER_PROFILE_KEY, JSON.stringify({
      reportMode: profile.reportMode === 'advisor' ? 'advisor' : 'simulation',
      licenseType: PDF_LICENSE_TYPE_META[profile.licenseType] ? profile.licenseType : 'ic_plain',
      advisorName: String(profile.advisorName || '').trim(),
      licenseNo: String(profile.licenseNo || '').trim(),
      firmName: String(profile.firmName || '').trim(),
      customLogoDataUrl: String(profile.customLogoDataUrl || '')
    }));
  } catch (e) {
    console.warn('PDF profile storage notice:', e);
  }
}

function updatePdfLogoPreviewUI(dataUrl) {
  const preview = document.getElementById('pdf-cfg-logo-preview');
  const statusEl = document.getElementById('pdf-cfg-logo-status');
  const clearBtn = document.getElementById('btn-clear-pdf-logo');
  const hasCustom = Boolean(dataUrl && String(dataUrl).startsWith('data:image/'));
  if (preview) {
    preview.src = hasCustom ? dataUrl : '/static/quantfolio-logo.svg?v=1';
  }
  if (statusEl) {
    statusEl.innerText = hasCustom
      ? 'กำลังใช้โลโก้แบรนด์ของคุณแทนโลโก้ QuantFolio (White-label)'
      : 'ใช้โลโก้ QuantFolio (อัปโหลด PNG/JPG/SVG แทนที่ได้)';
  }
  if (clearBtn) {
    clearBtn.classList.toggle('hidden', !hasCustom);
  }
}

function syncPdfReportModeFields() {
  const tierInfo = getActiveUserTierInfo();
  const simRadio = document.getElementById('pdf-cfg-report-mode-sim');
  const advRadio = document.getElementById('pdf-cfg-report-mode-advisor');
  if (advRadio && advRadio.checked && !tierInfo.canWhitelabelAdvisorPdf) {
    if (simRadio) simRadio.checked = true;
    advRadio.checked = false;
    if (typeof window.openProUpgradeModal === 'function') {
      window.openProUpgradeModal(
        'โหมดผู้มีใบอนุญาต IC / IP (White-label โลโก้บริษัท, เลขใบอนุญาต, คัดกรองลูกค้าเปราะบาง & Fair Dealing Checklist) สงวนไว้สำหรับแพ็กเกจ Advisor Pro',
        'advisor'
      );
    }
  }
  const isAdvisor = Boolean(advRadio && advRadio.checked && tierInfo.canWhitelabelAdvisorPdf);
  const advisorBadgeEl = document.getElementById('pdf-cfg-advisor-pro-badge');
  if (advisorBadgeEl) {
    if (tierInfo.canWhitelabelAdvisorPdf) {
      advisorBadgeEl.textContent = '✓ ปลดล็อกแล้ว';
      advisorBadgeEl.className = 'text-[9.5px] font-extrabold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-300';
    } else {
      advisorBadgeEl.textContent = 'ADVISOR PRO';
      advisorBadgeEl.className = 'text-[9.5px] font-extrabold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300';
    }
  }
  const wlPanel = document.getElementById('pdf-cfg-whitelabel-fields');
  const reqStar = document.getElementById('pdf-cfg-advisor-req');
  const commentEl = document.getElementById('pdf-cfg-commentary');
  const alertEl = document.getElementById('pdf-cfg-alert');
  const licenseTypeEl = document.getElementById('pdf-cfg-license-type');
  const licenseHintEl = document.getElementById('pdf-cfg-license-scope-hint');
  const suitBadgeEl = document.getElementById('pdf-cfg-suitability-live-badge');

  if (wlPanel) wlPanel.classList.toggle('hidden', !isAdvisor);
  if (reqStar) reqStar.classList.toggle('hidden', !isAdvisor);
  if (alertEl) alertEl.classList.add('hidden');

  // P0-3 Strict Gate: In non-Advisor (Simulation) mode reset & ignore any stale 6-group / suitability selections
  const segSelectEl = document.getElementById('pdf-cfg-client-segment');
  const suitSelectEl = document.getElementById('pdf-cfg-client-suitability');
  if (!isAdvisor) {
    if (segSelectEl) segSelectEl.value = 'general';
    if (suitSelectEl) suitSelectEl.value = 'auto';
  }

  const licenseType = licenseTypeEl ? licenseTypeEl.value : 'ic_plain';
  const clientSegment = isAdvisor ? (segSelectEl?.value || 'general') : 'general';
  const clientSuitability = isAdvisor ? (suitSelectEl?.value || 'auto') : 'auto';
  const savedItem = state.pendingPdfPortfolioId && Array.isArray(window.savedPortfoliosList)
    ? window.savedPortfoliosList.find(p => String(p.id) === String(state.pendingPdfPortfolioId))
    : null;
  const m = computeGoalProjectionMetrics(savedItem);
  const comp = evaluatePdfFairDealingCompliance(m, {
    reportMode: isAdvisor ? 'advisor' : 'simulation',
    advisorName: 'preview',
    licenseNo: 'preview',
    licenseType,
    clientSegment,
    clientSuitability
  });

  const alertTriIcon = '<svg class="w-3.5 h-3.5 inline-block align-[-2px] mr-1 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
  const shieldAlertIcon = '<svg class="w-3.5 h-3.5 inline-block align-[-2px] mr-1 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>';

  if (licenseHintEl) {
    if (licenseType === 'ip') {
      licenseHintEl.innerHTML = `<span class="font-bold text-emerald-800">สิทธิ์ผู้วางแผนการลงทุน (IP กลุ่ม 5):</span> ตามคู่มือ ก.ล.ต. หน้า 6 สามารถออกแบบแผนและจัดพอร์ตเฉพาะเจาะจงให้กับลูกค้าเฉพาะราย (<b>Customized Asset Allocation / Executive Investment Proposal</b>) ได้ โดยต้องมีการตรวจสอบตามระเบียบบริษัท`;
    } else if (comp.icPlainScopeWarning) {
      licenseHintEl.innerHTML = `<span class="font-bold text-amber-800">${alertTriIcon}แจ้งเตือนขอบเขต IC Plain (ตารางหน้า 7):</span> พอร์ตนี้มีสินทรัพย์เสี่ยงสูง/ดิจิทัล (<b>${escapeHtmlText(comp.highRiskTickers.join(', '))}</b>) ซึ่งอยู่นอกกลุ่มตราสารทั่วไปไม่ซับซ้อน และผู้ทำหน้าที่ <b>IC ห้ามจัดพอร์ตเฉพาะเจาะจงรายบุคคล</b> (นำเสนอได้เฉพาะ <b>Basic Asset Allocation</b> มาตรฐานตามหลักวิชาการ หน้า 6 และ 8)`;
    } else {
      licenseHintEl.innerHTML = `<span class="font-bold text-blue-800">ขอบเขตผู้แนะนำการลงทุน (${escapeHtmlText(comp.licenseMeta.shortLabel)}):</span> ตามคู่มือ ก.ล.ต. หน้า 6 และ 8 (ข้อไม่ควรทำ Don't) ผู้ทำหน้าที่ IC <b>ไม่สามารถจัดพอร์ตแบบเฉพาะเจาะจงรายบุคคลได้</b> ระบบจะออกเอกสารในรูปแบบ <b>สำรับการลงทุนเบื้องต้นตามหลักวิชาการมาตรฐาน (Basic Asset Allocation)</b> อัตโนมัติ`;
    }
  }

  if (suitBadgeEl) {
    const volPctText = comp.volPctText || `${(comp.annualVol * 100).toFixed(2)}%/ปี`;
    const notes = [];
    if (comp.segMeta.isVulnerable) {
      notes.push(`<span class="text-amber-800">${shieldAlertIcon}<b>ผู้ลงทุนเปราะบาง (อายุ ≥ 60 ปี / ความรู้จำกัด):</b></span> ระบบจะเพิ่มกรอบแจ้งเตือนความระมัดระวังพิเศษ การอธิบายโอกาสขาดทุนสูงสุด และห้ามเร่งรัดการตัดสินใจ (หน้า 2, 6, 8)`);
    } else if (comp.segMeta.isSenior) {
      notes.push(`ผู้ลงทุนอายุ ≥ 60 ปีที่มีประสบการณ์และระบุเจตจำนง (กลุ่มที่ 5 ตามคู่มือหน้า 6)`);
    }
    if (comp.suitabilityMismatch) {
      notes.push(`<span class="text-rose-700">${alertTriIcon}<b>แจ้งเตือนความเหมาะสม (Mis-selling Prevention):</b></span> ${escapeHtmlText(comp.mismatchReasonText)} • ป้ายเตือนชุดนี้จะแสดงตรงกันบน PDF หน้า 2`);
      suitBadgeEl.className = 'px-2.5 py-1.5 rounded-lg bg-amber-50 border border-amber-300 text-[11px] text-amber-950 leading-snug';
    } else {
      notes.push(`✓ ความผันผวนพอร์ต (${volPctText}) อยู่ในกรอบความสามารถรับความเสี่ยง (${escapeHtmlText(comp.suitMeta.label)})${comp.requiresKnowledgeAssessment ? ` • มีสินทรัพย์เสี่ยงสูง (${escapeHtmlText(comp.highRiskTickers.join(', '))}) ต้องทำ Knowledge Assessment` : ''}`);
      suitBadgeEl.className = comp.segMeta.isVulnerable
        ? 'px-2.5 py-1.5 rounded-lg bg-amber-50/70 border border-amber-200 text-[11px] text-amber-950 leading-snug'
        : 'px-2.5 py-1.5 rounded-lg bg-emerald-50/70 border border-emerald-200 text-[11px] text-emerald-950 leading-snug';
    }
    suitBadgeEl.innerHTML = notes.join('<br/>');
  }

  if (commentEl) {
    if (!isAdvisor) {
      commentEl.placeholder = 'เว้นว่างไว้เพื่อให้ระบบสร้างบทสรุปผลการจำลอง (Planning Summary) ให้อัตโนมัติ...';
    } else if (licenseType === 'ip') {
      commentEl.placeholder = 'เว้นว่างไว้เพื่อให้ระบบสร้างบทสรุปแผนจัดพอร์ตเฉพาะราย (IP Executive Commentary) ให้อัตโนมัติ...';
    } else {
      commentEl.placeholder = 'เว้นว่างไว้เพื่อให้ระบบสร้างบทสรุปสำรับการลงทุนมาตรฐานตามหลักวิชาการ (IC Basic Asset Allocation) ให้อัตโนมัติ...';
    }
  }
}

function handlePdfCustomLogoUpload(inputEl) {
  const file = inputEl?.files?.[0];
  const alertEl = document.getElementById('pdf-cfg-alert');
  if (alertEl) alertEl.classList.add('hidden');
  if (!file) return;

  const allowedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
  if (!allowedTypes.includes(file.type)) {
    if (alertEl) {
      alertEl.innerText = 'รองรับเฉพาะไฟล์ภาพ PNG, JPG, WEBP หรือ SVG เท่านั้น';
      alertEl.classList.remove('hidden');
    }
    inputEl.value = '';
    return;
  }
  if (file.size > 400 * 1024) {
    if (alertEl) {
      alertEl.innerText = 'ขนาดไฟล์โลโก้ต้องไม่เกิน 400 KB เพื่อให้ไฟล์ PDF โหลดเร็วและคมชัด';
      alertEl.classList.remove('hidden');
    }
    inputEl.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = String(reader.result || '');
    if (file.type === 'image/svg+xml') {
      // Block unsafe scripts/event handlers inside uploaded SVGs
      const decoded = atob((dataUrl.split(',')[1] || '').replace(/\s/g, ''));
      if (/<script\b|on\w+\s*=|javascript:/i.test(decoded)) {
        if (alertEl) {
          alertEl.innerText = 'ไฟล์ SVG นี้มีสคริปต์ที่ไม่อนุญาต กรุณาใช้ไฟล์ PNG/JPG หรือ SVG ภาพเวกเตอร์ปกติ';
          alertEl.classList.remove('hidden');
        }
        return;
      }
    }
    state.pdfCustomLogoDataUrl = dataUrl;
    updatePdfLogoPreviewUI(dataUrl);
  };
  reader.readAsDataURL(file);
}

function clearPdfCustomLogo() {
  state.pdfCustomLogoDataUrl = '';
  const inputEl = document.getElementById('pdf-cfg-logo-input');
  if (inputEl) inputEl.value = '';
  updatePdfLogoPreviewUI('');
}

function clearSavedPdfProfile() {
  try {
    localStorage.removeItem(PDF_PREPARER_PROFILE_KEY);
  } catch (e) {}
  state.pdfCustomLogoDataUrl = '';
  const simRadio = document.getElementById('pdf-cfg-report-mode-sim');
  if (simRadio) simRadio.checked = true;
  const licTypeEl = document.getElementById('pdf-cfg-license-type');
  if (licTypeEl) licTypeEl.value = 'ic_plain';
  ['pdf-cfg-advisor-name', 'pdf-cfg-license-no', 'pdf-cfg-firm-name'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  updatePdfLogoPreviewUI('');
  syncPdfReportModeFields();
  showPortfolioToastApp('ล้างโปรไฟล์ผู้จัดทำที่บันทึกไว้ในเครื่องเรียบร้อยแล้ว');
}

function openPdfReportConfigModal(savedPortfolioId = null) {
  state.pendingPdfPortfolioId = savedPortfolioId || null;
  const modal = document.getElementById('pdf-report-config-modal');
  if (!modal) {
    openPrintableGoalReport({ savedPortfolioId });
    return;
  }

  const tierInfo = getActiveUserTierInfo();
  const savedProf = readSavedPdfPreparerProfile();
  const simRadio = document.getElementById('pdf-cfg-report-mode-sim');
  const advRadio = document.getElementById('pdf-cfg-report-mode-advisor');
  if (savedProf.reportMode === 'advisor' && advRadio && tierInfo.canWhitelabelAdvisorPdf) {
    advRadio.checked = true;
  } else if (simRadio) {
    simRadio.checked = true;
  }

  const licenseTypeEl = document.getElementById('pdf-cfg-license-type');
  if (licenseTypeEl && savedProf.licenseType && PDF_LICENSE_TYPE_META[savedProf.licenseType]) {
    licenseTypeEl.value = savedProf.licenseType;
  }

  // Never auto-fill raw email prefix (e.g. "amon"): restore only explicit saved real-name profile
  const advisorInput = document.getElementById('pdf-cfg-advisor-name');
  const licenseInput = document.getElementById('pdf-cfg-license-no');
  const firmInput = document.getElementById('pdf-cfg-firm-name');
  if (advisorInput && !advisorInput.value.trim() && savedProf.advisorName) {
    advisorInput.value = savedProf.advisorName;
  }
  if (licenseInput && !licenseInput.value.trim() && savedProf.licenseNo) {
    licenseInput.value = savedProf.licenseNo;
  }
  if (firmInput && !firmInput.value.trim() && savedProf.firmName) {
    firmInput.value = savedProf.firmName;
  }
  state.pdfCustomLogoDataUrl = state.pdfCustomLogoDataUrl || savedProf.customLogoDataUrl || '';
  updatePdfLogoPreviewUI(state.pdfCustomLogoDataUrl);
  syncPdfReportModeFields();

  modal.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function closePdfReportConfigModal() {
  const modal = document.getElementById('pdf-report-config-modal');
  if (modal) modal.classList.add('hidden');
  state.pendingPdfPortfolioId = null;
}

function confirmAndOpenInstitutionalPdf() {
  const tierInfo = getActiveUserTierInfo();
  const reportModeRadio = document.querySelector('input[name="pdf-cfg-report-mode"]:checked');
  const rawReportMode = reportModeRadio && reportModeRadio.value === 'advisor' ? 'advisor' : 'simulation';
  if (rawReportMode === 'advisor' && !tierInfo.canWhitelabelAdvisorPdf) {
    const simRadio = document.getElementById('pdf-cfg-report-mode-sim');
    if (simRadio) simRadio.checked = true;
    syncPdfReportModeFields();
    if (typeof window.openProUpgradeModal === 'function') {
      window.openProUpgradeModal(
        'โหมดผู้มีใบอนุญาต IC / IP (White-label โลโก้บริษัท, เลขใบอนุญาต, คัดกรองลูกค้าเปราะบาง & Fair Dealing Checklist) สงวนไว้สำหรับแพ็กเกจ Advisor Pro',
        'advisor'
      );
    }
    return;
  }
  const reportMode = rawReportMode;
  const licenseType = document.getElementById('pdf-cfg-license-type')?.value || 'ic_plain';
  // P0-3: Client Grouping 6 groups & Suitability override apply strictly in Advisor Pro IC/IP mode
  const clientSegment = reportMode === 'advisor'
    ? (document.getElementById('pdf-cfg-client-segment')?.value || 'general')
    : 'general';
  const clientSuitability = reportMode === 'advisor'
    ? (document.getElementById('pdf-cfg-client-suitability')?.value || 'auto')
    : 'auto';
  const chkFactsheet = document.getElementById('pdf-cfg-chk-factsheet') ? Boolean(document.getElementById('pdf-cfg-chk-factsheet').checked) : true;
  const chkKnowledge = document.getElementById('pdf-cfg-chk-knowledge') ? Boolean(document.getElementById('pdf-cfg-chk-knowledge').checked) : true;
  const chkNoforce = document.getElementById('pdf-cfg-chk-noforce') ? Boolean(document.getElementById('pdf-cfg-chk-noforce').checked) : true;
  const clientName = (document.getElementById('pdf-cfg-client-name')?.value || '').trim();
  const advisorName = (document.getElementById('pdf-cfg-advisor-name')?.value || '').trim();
  const licenseNo = (document.getElementById('pdf-cfg-license-no')?.value || '').trim();
  const firmName = (document.getElementById('pdf-cfg-firm-name')?.value || '').trim();
  const customLogoDataUrl = String(state.pdfCustomLogoDataUrl || '');
  const customCommentary = (document.getElementById('pdf-cfg-commentary')?.value || '').trim();
  const pctRadio = document.getElementById('pdf-cfg-mode-pct');
  const modeRadio = document.querySelector('input[name="pdf-cfg-amount-mode"]:checked');
  const pctOnly = Boolean((pctRadio && pctRadio.checked) || (modeRadio && modeRadio.value === 'pct_only'));
  const alertEl = document.getElementById('pdf-cfg-alert');

  if (alertEl) alertEl.classList.add('hidden');

  // Strict compliance guardrail: Advisor / White-label mode requires real full name + IC/IP license number
  if (reportMode === 'advisor') {
    if (!advisorName) {
      if (alertEl) {
        alertEl.innerText = 'โหมดที่ปรึกษาการเงิน (IC/IFA) กรุณากรอกชื่อ–นามสกุลจริงของผู้จัดทำ';
        alertEl.classList.remove('hidden');
      }
      document.getElementById('pdf-cfg-advisor-name')?.focus();
      return;
    }
    if (!licenseNo) {
      if (alertEl) {
        alertEl.innerText = 'โหมดที่ปรึกษาการเงิน (IC/IFA) กรุณากรอกเลขที่ใบอนุญาต IC / IP (หากไม่มีใบอนุญาต กรุณาเลือก "รายงานจำลองพอร์ตทั่วไป")';
        alertEl.classList.remove('hidden');
      }
      document.getElementById('pdf-cfg-license-no')?.focus();
      return;
    }
  }

  savePdfPreparerProfile({ reportMode, licenseType, advisorName, licenseNo, firmName, customLogoDataUrl });

  const savedPortfolioId = state.pendingPdfPortfolioId;
  closePdfReportConfigModal();
  openPrintableGoalReport({
    reportMode,
    licenseType,
    clientSegment,
    clientSuitability,
    chkFactsheet,
    chkKnowledge,
    chkNoforce,
    clientName,
    advisorName,
    licenseNo,
    firmName,
    customLogoDataUrl,
    customCommentary,
    pctOnly,
    savedPortfolioId
  });
}

function closePdfA4PreviewOverlay() {
  const overlay = document.getElementById('pdf-a4-preview-overlay');
  if (overlay) overlay.classList.add('hidden');
  document.body.style.overflow = '';
}

function reopenPdfConfigFromPreview() {
  const prevSavedId = window.__lastPdfReportOptions?.savedPortfolioId || null;
  closePdfA4PreviewOverlay();
  openPdfReportConfigModal(prevSavedId);
}

function printInstitutionalPdfPreview() {
  const tierInfo = getActiveUserTierInfo();
  if (!tierInfo.canDownloadSimPdf) {
    closePdfA4PreviewOverlay();
    if (typeof window.openSupabaseConfigModal === 'function') {
      window.openSupabaseConfigModal('signup');
    } else if (typeof window.openProUpgradeModal === 'function') {
      window.openProUpgradeModal(
        'โหมด Guest สามารถเปิดดูตัวอย่างรายงาน A4 ได้บนหน้าจอ กรุณาสมัครสมาชิกหรือเข้าสู่ระบบฟรีเพื่อสั่งพิมพ์และดาวน์โหลดรายงาน PDF มาตรฐาน A4 ได้ทันที',
        'free'
      );
    }
    showPortfolioToastApp('สมัครสมาชิกหรือเข้าสู่ระบบฟรีเพื่อสั่งพิมพ์และดาวน์โหลดรายงาน PDF มาตรฐาน A4 ได้ทันที');
    return;
  }
  const iframe = document.getElementById('pdf-a4-preview-iframe');
  if (iframe && iframe.contentWindow) {
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
  }
}

function openInstitutionalPdfInNewTab() {
  const tierInfo = getActiveUserTierInfo();
  if (!tierInfo.canDownloadSimPdf) {
    closePdfA4PreviewOverlay();
    if (typeof window.openSupabaseConfigModal === 'function') {
      window.openSupabaseConfigModal('signup');
    } else if (typeof window.openProUpgradeModal === 'function') {
      window.openProUpgradeModal(
        'โหมด Guest สามารถเปิดดูตัวอย่างรายงาน A4 ได้บนหน้าจอ กรุณาสมัครสมาชิกหรือเข้าสู่ระบบฟรีเพื่อเปิดแท็บพิมพ์หรือดาวน์โหลดไฟล์ PDF',
        'free'
      );
    }
    showPortfolioToastApp('สมัครสมาชิกหรือเข้าสู่ระบบฟรีเพื่อสั่งพิมพ์และดาวน์โหลดรายงาน PDF มาตรฐาน A4 ได้ทันที');
    return;
  }
  const htmlDoc = window.__lastInstitutionalPdfStandaloneHtml || '';
  if (!htmlDoc) return;
  const win = window.open('', '_blank', 'width=980,height=860');
  if (!win) {
    alert('เบราว์เซอร์บล็อก Pop-up — สามารถกดปุ่ม "สั่งพิมพ์ / บันทึกเป็น PDF" บนหน้าตัวอย่างนี้ได้ทันทีโดยไม่ต้องเปิดแท็บใหม่');
    return;
  }
  win.document.write(htmlDoc);
  win.document.close();
}

function buildPdfMasterLogoInlineSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72" width="42" height="42" fill="none" style="flex-shrink:0;">
    <rect x="2" y="2" width="68" height="68" rx="18" fill="#059669"/>
    <line x1="16.5" y1="53.5" x2="55.5" y2="53.5" stroke="#FFFFFF" stroke-opacity="0.34" stroke-width="1.5" stroke-linecap="round"/>
    <rect x="19" y="39.5" width="7.8" height="12.5" rx="2.6" fill="#FFFFFF" fill-opacity="0.62"/>
    <rect x="32.1" y="31.5" width="7.8" height="20.5" rx="2.6" fill="#FFFFFF" fill-opacity="0.82"/>
    <rect x="45.2" y="23.5" width="7.8" height="28.5" rx="2.6" fill="#FFFFFF"/>
    <path d="M19 34.5 C25.8 32.5 31 26.2 37 25.0 C43 23.8 47.2 19.4 52 16.2" stroke="#FFFFFF" stroke-width="2.6" stroke-linecap="round"/>
    <circle cx="52" cy="16.2" r="3.4" fill="#FFFFFF"/>
  </svg>`;
}

function buildPdfAllocationDonutSvg(dcaSchedule) {
  const palette = ASSET_COLORS;
  const items = Array.isArray(dcaSchedule) && dcaSchedule.length > 0 ? dcaSchedule : [];
  const totalPct = items.reduce((acc, it) => acc + Number(it.weightPct || 0), 0) || 100;
  const radius = 44;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  const circles = items.map((it, idx) => {
    const frac = Number(it.weightPct || 0) / totalPct;
    const len = Math.max(0.5, frac * circumference);
    const seg = `<circle cx="58" cy="58" r="${radius}" fill="none" stroke="${palette[idx % palette.length]}" stroke-width="15" stroke-dasharray="${len.toFixed(2)} ${circumference.toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 58 58)"/>`;
    offset += len;
    return seg;
  }).join('');

  const hasOverflowLegend = items.length > 8;
  const visibleLegendItems = hasOverflowLegend ? items.slice(0, 7) : items;
  let legendRows = visibleLegendItems.map((it, idx) => `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10.5px;line-height:1.45;">
      <span style="display:inline-flex;align-items:center;gap:5px;min-width:0;color:#1E293B;font-weight:600;">
        <span style="width:8px;height:8px;border-radius:2px;background:${palette[idx % palette.length]};flex-shrink:0;"></span>
        <span style="font-family:'IBM Plex Mono',monospace;">${escapeHtmlText(it.ticker)}</span>
      </span>
      <span style="font-family:'IBM Plex Mono',monospace;font-weight:600;color:#0F172A;font-variant-numeric:tabular-nums;">${Number(it.weightPct).toFixed(1)}%</span>
    </div>
  `).join('');

  if (hasOverflowLegend) {
    const restItems = items.slice(7);
    const restPct = restItems.reduce((acc, it) => acc + Number(it.weightPct || 0), 0);
    legendRows += `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10px;line-height:1.45;padding-top:2px;border-top:1px dashed #CBD5E1;margin-top:1px;">
        <span style="display:inline-flex;align-items:center;gap:5px;min-width:0;color:#475569;font-weight:600;">
          <span style="width:8px;height:8px;border-radius:2px;background:#94A3B8;flex-shrink:0;"></span>
          <span>+ อีก ${restItems.length} สินทรัพย์อื่นๆ</span>
        </span>
        <span style="font-family:'IBM Plex Mono',monospace;font-weight:600;color:#475569;font-variant-numeric:tabular-nums;">${restPct.toFixed(1)}%</span>
      </div>
    `;
  }

  return `
    <div style="display:flex;align-items:center;gap:14px;">
      <svg viewBox="0 0 116 116" width="112" height="112" style="flex-shrink:0;">
        <circle cx="58" cy="58" r="${radius}" fill="none" stroke="#E2E8F0" stroke-width="15"/>
        ${circles}
        <text x="58" y="54" text-anchor="middle" font-family="'IBM Plex Mono',monospace" font-size="15" font-weight="700" fill="#0F172A">${items.length}</text>
        <text x="58" y="68" text-anchor="middle" font-family="'IBM Plex Sans Thai',sans-serif" font-size="9" font-weight="600" fill="#64748B">สินทรัพย์</text>
      </svg>
      <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;">
        ${legendRows || '<div style="font-size:11px;color:#64748B;">ยังไม่มีข้อมูลสัดส่วน</div>'}
      </div>
    </div>
  `;
}

function buildPdfGoalTrajectorySvg(m, sym, pctOnly) {
  const W = 360;
  const H = 148;
  const padL = 48;
  const padR = 14;
  const padT = 14;
  const padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = Math.max(1, m.yearsAxis.length - 1);
  const hasInfl = m.inflationRate > 0;
  const baseArr = hasInfl ? m.realBaseWealthSeries : m.baseWealthSeries;

  const valsAll = [...m.bullWealthSeries, ...baseArr, ...m.consWealthSeries, ...m.principalSeries, m.targetAmount];
  const maxVal = Math.max(100, ...valsAll) * 1.08;
  const minVal = 0;

  const toX = (i) => padL + (i / n) * plotW;
  const toY = (v) => padT + plotH - ((Math.max(0, v) - minVal) / Math.max(1, maxVal - minVal)) * plotH;
  const poly = (arr) => arr.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');

  const conePoints = `${poly(m.bullWealthSeries)} ${m.consWealthSeries.slice().reverse().map((v, ri) => `${toX(n - ri).toFixed(1)},${toY(v).toFixed(1)}`).join(' ')}`;

  const yTicks = [0, 0.33, 0.66, 1.0].map(frac => {
    const val = maxVal * frac;
    const y = toY(val);
    let lbl = '';
    if (pctOnly) {
      const pct = ((val - m.initialBudget) / Math.max(1, m.initialBudget)) * 100;
      lbl = `${pct >= 0 ? '+' : ''}${Math.round(pct)}%`;
    } else if (val >= 1000000) {
      lbl = `${sym}${(val / 1000000).toFixed(1)}M`;
    } else if (val >= 1000) {
      lbl = `${sym}${Math.round(val / 1000)}k`;
    } else {
      lbl = `${sym}${Math.round(val)}`;
    }
    return `
      <line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="#E2E8F0" stroke-width="0.8"/>
      <text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-family="'IBM Plex Mono',monospace" font-size="8.5" fill="#64748B">${lbl}</text>
    `;
  }).join('');

  const xLabelIdx = Array.from(new Set([0, Math.floor(n / 2), n]));
  const xLabels = xLabelIdx.map(i => `<text x="${toX(i).toFixed(1)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : (i === n ? 'end' : 'middle')}" font-family="'IBM Plex Sans Thai',sans-serif" font-size="8.5" fill="#64748B">ปีที่ ${i}</text>`).join('');

  const targetY = toY(m.targetAmount);
  const endBaseY = toY(baseArr[n]);

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="148" style="display:block;">
      ${yTicks}
      <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="#CBD5E1" stroke-width="1"/>
      <polygon points="${conePoints}" fill="#00D084" fill-opacity="0.10"/>
      <line x1="${padL}" y1="${targetY.toFixed(1)}" x2="${W - padR}" y2="${targetY.toFixed(1)}" stroke="#D97706" stroke-width="1.4" stroke-dasharray="4 3"/>
      <polyline points="${poly(m.principalSeries)}" fill="none" stroke="#94A3B8" stroke-width="1.5" stroke-dasharray="3 3"/>
      <polyline points="${poly(m.consWealthSeries)}" fill="none" stroke="#EF4444" stroke-width="1.2" stroke-dasharray="2 2"/>
      <polyline points="${poly(m.bullWealthSeries)}" fill="none" stroke="#10B981" stroke-width="1.2" stroke-dasharray="2 2"/>
      <polyline points="${poly(baseArr)}" fill="none" stroke="#00A86B" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${toX(n).toFixed(1)}" cy="${endBaseY.toFixed(1)}" r="3.4" fill="#00A86B" stroke="#FFFFFF" stroke-width="1.5"/>
      ${xLabels}
    </svg>
    <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:4px;font-size:9px;color:#475569;">
      <span style="display:inline-flex;align-items:center;gap:4px;"><span style="width:12px;height:2.5px;background:#00A86B;display:inline-block;"></span>${hasInfl ? 'มูลค่าจริง (Base)' : 'กรณีฐาน (Base)'}</span>
      <span style="display:inline-flex;align-items:center;gap:4px;"><span style="width:12px;height:0;border-top:1.5px dashed #94A3B8;display:inline-block;"></span>เงินต้นสะสม</span>
      <span style="display:inline-flex;align-items:center;gap:4px;"><span style="width:12px;height:0;border-top:1.5px dashed #D97706;display:inline-block;"></span>เป้าหมาย (${m.achievementPct}%)</span>
      <span style="display:inline-flex;align-items:center;gap:4px;"><span style="width:10px;height:8px;background:rgba(0,208,132,0.18);display:inline-block;border-radius:2px;"></span>ช่วงตลาดดี–ซบเซา</span>
    </div>
  `;
}

function openPrintableGoalReport(options = {}) {
  const {
    reportMode = 'simulation',
    licenseType = 'ic_plain',
    clientSegment = 'general',
    clientSuitability = 'auto',
    chkFactsheet = true,
    chkKnowledge = true,
    chkNoforce = true,
    clientName = '',
    advisorName = '',
    licenseNo = '',
    firmName = '',
    customLogoDataUrl = '',
    customCommentary = '',
    pctOnly = false,
    savedPortfolioId = null
  } = options || {};

  const savedItem = savedPortfolioId && Array.isArray(window.savedPortfoliosList)
    ? window.savedPortfoliosList.find(p => String(p.id) === String(savedPortfolioId))
    : null;

  // P0-3 Defense-in-Depth: Always re-verify Advisor Pro entitlement before allowing Advisor mode, 6-group Client Grouping, or Suitability overrides
  const activeTierInfo = getActiveUserTierInfo();
  const effectiveReportMode = (reportMode === 'advisor' && activeTierInfo.canWhitelabelAdvisorPdf) ? 'advisor' : 'simulation';
  const effectiveClientSegment = effectiveReportMode === 'advisor' ? clientSegment : 'general';
  const effectiveClientSuitability = effectiveReportMode === 'advisor' ? clientSuitability : 'auto';

  const m = computeGoalProjectionMetrics(savedItem);
  const comp = evaluatePdfFairDealingCompliance(m, {
    reportMode: effectiveReportMode,
    licenseType: effectiveReportMode === 'advisor' ? licenseType : 'ic_plain',
    clientSegment: effectiveClientSegment,
    clientSuitability: effectiveClientSuitability,
    chkFactsheet,
    chkKnowledge,
    chkNoforce,
    advisorName: effectiveReportMode === 'advisor' ? advisorName : '',
    licenseNo: effectiveReportMode === 'advisor' ? licenseNo : ''
  });

  const isAdvisorMode = comp.isAdvisorMode;
  const isIpLicense = comp.isIpLicense;
  const isIcLicense = comp.isIcLicense;
  const brandDisplayName = (isAdvisorMode && firmName) ? firmName : 'QuantFolio Wealth Analytics';
  const brandEyebrowPrefix = brandDisplayName.toUpperCase();

  // SEC / SET Fair Dealing & IC vs IP Role-Specific Headers (Pages 2, 6, 7, 8 of Manual)
  const docModeEyebrow = !isAdvisorMode
    ? 'PORTFOLIO SIMULATION REPORT'
    : (isIpLicense ? 'EXECUTIVE INVESTMENT PROPOSAL • IP ASSET ALLOCATION' : 'BASIC ASSET ALLOCATION REPORT • IC STANDARD MODEL');
  const docModeTitleTh = !isAdvisorMode
    ? 'รายงานจำลองการจัดสรรพอร์ตและเป้าหมายการลงทุน'
    : (isIpLicense
        ? 'รายงานสรุปแผนจัดสรรพอร์ตและเป้าหมายการลงทุนเฉพาะราย (IP Asset Allocation)'
        : 'รายงานนำเสนอสำรับการลงทุนเบื้องต้นตามหลักวิชาการมาตรฐาน (Basic Asset Allocation)');
  const docPageTitlePrefix = !isAdvisorMode
    ? 'QuantFolio Portfolio Simulation Report'
    : (isIpLicense
        ? `${brandDisplayName} Executive Investment Proposal (IP)`
        : `${brandDisplayName} Basic Asset Allocation Report (IC)`);
  const section4Title = !isAdvisorMode
    ? '4. บทสรุปผลการจำลองและกรอบการวางแผน (Planning Summary)'
    : (isIpLicense
        ? '4. บทสรุปและข้อเสนอแนะเชิงกลยุทธ์เฉพาะราย (Executive Commentary — IP)'
        : '4. บทสรุปและข้อเสนอแนะเชิงกลยุทธ์ — สำรับการลงทุนเบื้องต้น (Basic Asset Allocation — IC)');
  const section4Tag = !isAdvisorMode
    ? 'PLANNING SUMMARY'
    : (isIpLicense ? 'ADVISORY NOTE • IP' : 'BASIC ASSET ALLOCATION • IC');
  const rawPortfolioName = savedItem
    ? savedItem.portfolio_name
    : (document.getElementById('save-portfolio-name')?.value || 'แผนพอร์ตการลงทุนตามเป้าหมาย').trim();
  const portfolioName = escapeHtmlText(rawPortfolioName);
  const sym = m.currency === 'USD' ? '$' : '฿';
  const unitTxt = m.currency === 'USD' ? 'USD' : 'บาท';
  const fmtAmt = (val, dec = 0, withUnit = true) => {
    if (pctOnly) return '— (ไม่ระบุวงเงิน)';
    const num = Number(val || 0);
    const formatted = Math.abs(num).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    const sign = num < 0 ? '-' : '';
    return withUnit ? `${sign}${formatted} ${unitTxt}` : `${sign}${sym}${formatted}`;
  };

  const strat = (!savedItem && state.optData && state.optData.strategies && state.optData.strategies[m.strategyKey]) || null;
  const dd = strat?.drawdown_details || {};
  const peakVal = dd.peak_value !== undefined ? Number(dd.peak_value) : (strat ? Number(strat.min_capital_remaining || 0) + Number(strat.max_drawdown_amount || 0) : m.initialBudget);
  const lossVal = strat?.max_drawdown_amount !== undefined ? Number(strat.max_drawdown_amount) : 0;
  const troughVal = strat?.min_capital_remaining !== undefined ? Number(strat.min_capital_remaining) : m.initialBudget;
  const scaledLoss = dd.initial_budget_scaled_loss !== undefined ? Number(dd.initial_budget_scaled_loss) : (strat ? Math.abs(Number(strat.max_drawdown || 0)) * m.initialBudget : 0);
  const mddPctStr = strat ? `${(Number(strat.max_drawdown || 0) * 100).toFixed(2)}%` : '--';

  const now = new Date();
  const todayStr = now.toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' });
  const docRef = `QF-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const dataAsOf = state.optData?.metadata?.data_as_of || state.optData?.metadata?.end_date || now.toISOString().slice(0, 10);
  const fxVal = Number(state.optData?.metadata?.usd_thb_rate || state.fxRate || 34.50).toFixed(2);
  const hasInfl = m.inflationRate > 0;

  // Allocation + Monthly DCA rows (Page 1 + Auto-Annex Page 3 when > 12 assets)
  const allSchedule = Array.isArray(m.dcaSchedule) ? m.dcaSchedule : [];
  const needsAnnexPage = allSchedule.length > 12;
  const totalPages = needsAnnexPage ? 3 : 2;
  const pageCountBadgeText = needsAnnexPage ? 'A4 • 3 หน้า พร้อมภาคผนวก' : 'A4 • 2 หน้า';

  const renderAllocRow = (row, compactIdx = null) => `
    <tr>
      ${compactIdx !== null ? `<td class="num muted" style="width:28px;">${compactIdx}</td>` : ''}
      <td class="col-asset">
        <div class="ticker">${escapeHtmlText(row.ticker)}</div>
        ${row.name ? `<div class="sub-name${compactIdx !== null ? ' annex-sub-name' : ''}">${escapeHtmlText(row.name)}</div>` : ''}
      </td>
      <td class="num bold">${row.weightPct.toFixed(2)}%</td>
      <td class="num">${pctOnly ? '—' : fmtAmt(row.initialAmt, 0, false)}</td>
      <td class="num muted">${pctOnly ? '—' : (row.estUnits !== null ? `${row.estUnits.toFixed(row.estUnits >= 10 ? 2 : 4)} หน่วย` : '—')}</td>
      <td class="num accent">${pctOnly ? '—' : `${fmtAmt(row.monthlyDcaAmt, 0, false)}/ด.`}</td>
      <td class="num muted">${(row.divYield * 100).toFixed(2)}%</td>
    </tr>
  `;

  let allocRowsHtml = '';
  if (allSchedule.length === 0) {
    allocRowsHtml = `<tr><td colspan="6" style="text-align:center;color:#64748B;padding:12px;">ยังไม่มีข้อมูลสัดส่วนสินทรัพย์</td></tr>`;
  } else if (!needsAnnexPage) {
    allocRowsHtml = allSchedule.map(row => renderAllocRow(row, null)).join('');
  } else {
    const topRows = allSchedule.slice(0, 10);
    const restRows = allSchedule.slice(10);
    const restWeightPct = restRows.reduce((s, r) => s + Number(r.weightPct || 0), 0);
    const restInitialAmt = restRows.reduce((s, r) => s + Number(r.initialAmt || 0), 0);
    const restMonthlyDca = restRows.reduce((s, r) => s + Number(r.monthlyDcaAmt || 0), 0);
    const restWeightedDiv = restWeightPct > 0
      ? restRows.reduce((s, r) => s + Number(r.weightPct || 0) * Number(r.divYield || 0), 0) / restWeightPct
      : 0;
    allocRowsHtml = topRows.map(row => renderAllocRow(row, null)).join('') + `
      <tr style="background:#F8FAFC;">
        <td class="col-asset">
          <div class="ticker" style="color:#334155;">+ อีก ${restRows.length} สินทรัพย์อื่นๆ</div>
          <div class="sub-name">ดูรายละเอียดครบทุก ${allSchedule.length} ตัวในภาคผนวก หน้า 3</div>
        </td>
        <td class="num bold">${restWeightPct.toFixed(2)}%</td>
        <td class="num">${pctOnly ? '—' : fmtAmt(Math.round(restInitialAmt), 0, false)}</td>
        <td class="num muted">ดูหน้า 3</td>
        <td class="num accent">${pctOnly ? '—' : `${fmtAmt(Math.round(restMonthlyDca), 0, false)}/ด.`}</td>
        <td class="num muted">${(restWeightedDiv * 100).toFixed(2)}%</td>
      </tr>
    `;
  }

  const annexAllRowsHtml = needsAnnexPage
    ? allSchedule.map((row, idx) => renderAllocRow(row, idx + 1)).join('')
    : '';

  // 4-Strategy Quantitative Comparison Table (Page 2)
  const stratOrder = ['max_sharpe', 'min_volatility', 'hrp', 'equal_weight'];
  const stratLabelMap = {
    max_sharpe: 'คุ้มความเสี่ยงสูงสุด (Max Sharpe)',
    min_volatility: 'ผันผวนต่ำ (Min Volatility)',
    hrp: 'กระจายสมดุล (Risk Parity / HRP)',
    equal_weight: 'แบ่งเท่ากันทุกตัว (1/N)'
  };
  const compareRowsHtml = (state.optData && state.optData.strategies)
    ? stratOrder.map(k => {
        const s = state.optData.strategies[k];
        if (!s) return '';
        const active = k === m.strategyKey;
        return `
          <tr class="${active ? 'active-row' : ''}">
            <td>
              <span style="font-weight:${active ? '700' : '500'};color:#0F172A;">${stratLabelMap[k]}</span>
              ${active ? `<span class="badge-selected">แผนที่เลือก</span>` : ''}
            </td>
            <td class="num ${s.expected_return >= 0 ? 'accent' : 'danger'}">${(s.expected_return * 100).toFixed(2)}%</td>
            <td class="num">${(s.volatility * 100).toFixed(2)}%</td>
            <td class="num danger">${(s.max_drawdown * 100).toFixed(2)}%</td>
            <td class="num bold">${Number(s.sharpe_ratio || 0).toFixed(2)}</td>
            <td class="num bold">${pctOnly ? '—' : fmtAmt(s.final_historical_value, 0, false)}</td>
          </tr>
        `;
      }).join('')
    : `<tr><td colspan="6" style="text-align:center;color:#64748B;padding:10px;">ข้อมูลเปรียบเทียบ 4 กลยุทธ์จะแสดงเมื่อคำนวณจากพอร์ตปัจจุบัน</td></tr>`;

  // Yearly Milestones rows (Page 2)
  const milestoneRowsHtml = (m.yearlyMilestones || []).map((row, idx, arr) => {
    const isFinal = idx === arr.length - 1;
    return `
      <tr class="${isFinal ? 'active-row' : ''}">
        <td style="font-weight:${isFinal ? '700' : '600'};">ปีที่ ${row.year}${isFinal ? ' (ครบกำหนด)' : ''}</td>
        <td class="num muted">${pctOnly ? '—' : fmtAmt(row.principal, 0, false)}</td>
        <td class="num danger">${pctOnly ? `${(((row.conservative - row.principal) / Math.max(1, row.principal)) * 100).toFixed(1)}%` : fmtAmt(row.conservative, 0, false)}</td>
        <td class="num accent bold">${pctOnly ? `${(((row.base - row.principal) / Math.max(1, row.principal)) * 100).toFixed(1)}%` : fmtAmt(hasInfl ? row.realBase : row.base, 0, false)}</td>
        <td class="num">${pctOnly ? `${(((row.bull - row.principal) / Math.max(1, row.principal)) * 100).toFixed(1)}%` : fmtAmt(row.bull, 0, false)}</td>
        <td class="num muted">${pctOnly ? `${(m.divYield * 100).toFixed(2)}%` : `${fmtAmt(row.estAnnualDividend, 0, false)}/ปี`}</td>
      </tr>
    `;
  }).join('');

  // Mode-compliant Auto Commentary (Simulation Mode strictly avoids "แนะนำให้"; IC uses Basic Asset Allocation standard framing; IP uses Customized Asset Allocation)
  let autoCommentary = '';
  if (isIpLicense) {
    autoCommentary = m.achievementPct >= 100
      ? `ภายใต้แผนจัดพอร์ตเฉพาะราย (Customized Asset Allocation) "${rawPortfolioName}" ด้วยกลยุทธ์ ${m.strategyName} ระยะเวลา ${m.years} ปี มีโอกาสบรรลุเป้าหมายสูง (${m.achievementPct}% ของเป้าหมาย${hasInfl ? ` หลังปรับลดด้วยเงินเฟ้อ ${m.inflationRate.toFixed(1)}%/ปี` : ''}) โดยแนะนำให้รักษาวินัยการออมรายเดือนตามสัดส่วนเป้าหมาย และทบทวนปรับสมดุลพอร์ต (Rebalance) ทุก 3–6 เดือนเพื่อควบคุมความผันผวนให้อยู่ในกรอบ ${((m.annualVol || 0) * 100).toFixed(2)}%/ปี`
      : `ภายใต้สมมติฐานปัจจุบัน แผนจัดพอร์ตเฉพาะราย "${rawPortfolioName}" คาดว่าจะบรรลุได้ประมาณ ${m.achievementPct}% ของเป้าหมายภายใน ${m.years} ปี เพื่อปิดช่องว่างให้ครบ 100% แนะนำให้พิจารณาเพิ่มเงินออมรายเดือน (DCA) เป็น ${pctOnly ? 'ระดับที่สอดคล้องกับเป้าหมาย' : fmtAmt(m.requiredMonthlyDca, 0, true) + '/เดือน'} หรือขยายระยะเวลาลงทุนควบคู่กับการปรับสมดุลพอร์ตทุกไตรมาส`;
  } else if (isIcLicense) {
    autoCommentary = m.achievementPct >= 100
      ? `ตามสำรับการลงทุนเบื้องต้นในรูปแบบมาตรฐานตามหลักวิชาการ (Basic Asset Allocation: ${m.strategyName}) สำหรับแผน "${rawPortfolioName}" ระยะเวลา ${m.years} ปี มูลค่าคาดการณ์อยู่ที่ ${m.achievementPct}% ของเป้าหมาย${hasInfl ? ` (หลังปรับลดเงินเฟ้อ ${m.inflationRate.toFixed(1)}%/ปี)` : ''} ผู้ลงทุนสามารถใช้สัดส่วนมาตรฐานนี้เป็นกรอบอ้างอิงในการทยอยสะสมรายเดือนและปรับสมดุลพอร์ต (Rebalance) ทุก 3–6 เดือนเพื่อคุมความผันผวนในกรอบ ${((m.annualVol || 0) * 100).toFixed(2)}%/ปี (หมายเหตุ: เป็นการนำเสนอสำรับการลงทุนมาตรฐานโดยผู้แนะนำการลงทุน IC มิใช่การจัดพอร์ตเฉพาะเจาะจงรายบุคคล)`
      : `ตามสำรับการลงทุนเบื้องต้นในรูปแบบมาตรฐานตามหลักวิชาการ (Basic Asset Allocation: ${m.strategyName}) แผน "${rawPortfolioName}" คาดว่าจะบรรลุได้ราว ${m.achievementPct}% ของเป้าหมายภายใน ${m.years} ปี หากผู้ลงทุนต้องการให้ยอดสะสมเข้าใกล้เป้าหมาย 100% กรอบคำนวณมาตรฐานบ่งชี้ว่าต้องใช้ยอดออมรายเดือนราว ${pctOnly ? 'ระดับที่สอดคล้องกับเป้าหมาย' : fmtAmt(m.requiredMonthlyDca, 0, true) + '/เดือน'} หรือขยายระยะเวลาลงทุน (หมายเหตุ: เป็นการนำเสนอสำรับมาตรฐานโดย IC มิใช่การจัดพอร์ตเฉพาะเจาะจงรายบุคคล)`;
  } else {
    autoCommentary = m.achievementPct >= 100
      ? `จากผลการจำลองแบบแผน "${rawPortfolioName}" ด้วยกลยุทธ์ ${m.strategyName} ระยะเวลา ${m.years} ปี มูลค่าคาดการณ์ตามสมมติฐานอยู่ที่ ${m.achievementPct}% ของเป้าหมาย${hasInfl ? ` (หลังปรับลดด้วยเงินเฟ้อ ${m.inflationRate.toFixed(1)}%/ปี)` : ''} การรักษาวินัยการออมรายเดือนตามสัดส่วนจำลองควบคู่กับการทบทวนปรับสมดุลพอร์ต (Rebalance) ทุก 3–6 เดือน จะช่วยคุมความผันผวนให้อยู่ใกล้เคียงกรอบ ${((m.annualVol || 0) * 100).toFixed(2)}%/ปี`
      : `จากสมมติฐานจำลองปัจจุบัน แผน "${rawPortfolioName}" มีมูลค่าคาดการณ์ประมาณ ${m.achievementPct}% ของเป้าหมายภายใน ${m.years} ปี หากต้องการให้ยอดจำลองขยับสู่ 100% ของเป้าหมาย กรอบตัวเลขจำลองต้องใช้ยอดออมรายเดือนราว ${pctOnly ? 'ระดับที่สอดคล้องกับเป้าหมาย' : fmtAmt(m.requiredMonthlyDca, 0, true) + '/เดือน'} หรือขยายระยะเวลาลงทุนเพิ่มเติม ควบคู่กับการปรับสมดุลพอร์ตตามรอบเวลา`;
  }
  const finalCommentaryHtml = escapeHtmlText(customCommentary || autoCommentary).replace(/\n/g, '<br/>');

  // Build Fair Dealing, Client Segmentation, Suitability & Product Complexity Guardrail Strip (Page 2 Section 4)
  const volPctText = comp.volPctText || `${(comp.annualVol * 100).toFixed(2)}%/ปี`;
  const scopeBadgeText = !isAdvisorMode
    ? 'Self-Directed Simulation (รายงานจำลองเพื่อการศึกษา)'
    : (isIpLicense
        ? 'Customized Asset Allocation (ออกแบบและจัดพอร์ตเฉพาะรายโดย IP • หน้า 6 ข้อ 3.2)'
        : 'Basic Asset Allocation (สำรับการลงทุนเบื้องต้นตามหลักวิชาการมาตรฐานโดย IC • ห้ามจัดพอร์ตเฉพาะเจาะจงรายบุคคล หน้า 6 และ 8)');
  const pdfAlertTriSvg = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#BE123C" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-1.5px;margin-right:3px;"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
  const pdfShieldAlertSvg = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#92400E" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-1.5px;margin-right:3px;"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>';
  const suitStatusHtml = comp.suitabilityMismatch
    ? `<span style="color:#BE123C;font-weight:700;">${pdfAlertTriSvg}แจ้งเตือนความเหมาะสม (Mis-selling Prevention):</span> ${escapeHtmlText(comp.mismatchReasonText)}`
    : `<span style="color:#008A57;font-weight:700;">✓ ความเหมาะสมในการลงทุน (Suitability):</span> ความผันผวนพอร์ต (${volPctText}) อยู่ในกรอบความสามารถรับความเสี่ยง (${escapeHtmlText(comp.suitMeta.label)})`;
  const vulnerableLineHtml = comp.segMeta.isVulnerable
    ? `<div style="margin-top:3px;color:#92400E;font-weight:600;">${pdfShieldAlertSvg}มาตรการดูแลผู้ลงทุนเปราะบาง (Vulnerable Investors อายุ ≥ 60 ปี • หน้า 2, 6, 8): ชี้แจงโอกาสขาดทุนสูงสุด (${mddPctStr}) สภาพคล่อง เงื่อนไขผลิตภัณฑ์อย่างระมัดระวังเป็นพิเศษ และให้เวลาตัดสินใจโดยไม่เร่งรัด</div>`
    : '';
  const productRiskLineHtml = (comp.requiresKnowledgeAssessment || comp.hasFxRisk || comp.icPlainScopeWarning)
    ? `<div style="margin-top:3px;color:#334155;"><b>การเปิดเผยความเสี่ยงผลิตภัณฑ์:</b> ${comp.requiresKnowledgeAssessment ? `มีสินทรัพย์ผันผวนสูง/ซับซ้อน (${escapeHtmlText(comp.highRiskTickers.join(', '))}) ต้องทำแบบประเมินความรู้ (Knowledge Assessment หน้า 3) • ` : ''}${comp.hasFxRisk ? `มีการลงทุนต่างประเทศที่มีความเสี่ยงอัตราแลกเปลี่ยน (FX Risk)` : ''}${comp.icPlainScopeWarning ? ` • <span style="color:#B45309;font-weight:700;">หมายเหตุใบอนุญาต IC Plain (ตารางหน้า 7): แนะนำได้เฉพาะตราสารไม่ซับซ้อน</span>` : ''}</div>`
    : '';
  const salesChecklistLineHtml = isAdvisorMode
    ? `<div style="margin-top:3px;color:#0F172A;"><b>กระบวนการขายตามหลัก Fair Dealing (หน้า 8):</b> ${comp.chkFactsheet ? '☑' : '☐'} ส่งมอบหนังสือชี้ชวนส่วนสรุปข้อมูลสำคัญ (Factsheet) &amp; ชี้แจงระดับความเสี่ยง • ${comp.chkKnowledge ? '☑' : '☐'} ตรวจสอบ Suitability / Knowledge Assessment • ${comp.chkNoforce ? '☑' : '☐'} คำนึงถึงอายุ/สภาพคล่อง ไม่ยึดผลตอบแทนตัวเองเป็นหลัก และไม่เร่งรัดการตัดสินใจ</div>`
    : '';

  const pdfReadiness = computePortfolioEntryReadiness(state.optData, state.activeGoal);
  const pdfBlConfPct = Math.round((Number.isFinite(state.blConfidence) ? state.blConfidence : 0.5) * 100);
  const pdfModelModeLabel = (state.useNewsAdjustment && state.activeGoal === 'max_sharpe')
    ? `Black-Litterman (${pdfBlConfPct}%)`
    : 'สถิติราคาปิดย้อนหลังล้วน';
  const pdfMarketReadinessStripHtml = pdfReadiness
    ? `<div style="margin-top:5px;padding:6px 10px;border-radius:7px;background:#F8FAFC;border:1px solid #CBD5E1;font-size:8.6px;line-height:1.45;color:#334155;">
        <div><b>ความพร้อมจังหวะเข้าลงทุน ณ วันจัดทำ (${escapeHtmlText(pdfReadiness.badgeTh)}):</b> น่าสะสม ${pdfReadiness.positivePct.toFixed(0)}% • สมดุล ${pdfReadiness.neutralPct.toFixed(0)}% • ราคาตึง ${pdfReadiness.overboughtPct.toFixed(0)}% • ควรระวัง ${pdfReadiness.cautiousPct.toFixed(0)}% &nbsp;|&nbsp; <b>โหมดคำนวณ:</b> ${escapeHtmlText(pdfModelModeLabel)}</div>
        <div style="margin-top:2px;color:#475569;">${escapeHtmlText(pdfReadiness.pdfNoteTh)}</div>
      </div>`
    : '';

  const fairDealingStripHtml = `
    ${pdfMarketReadinessStripHtml}
    <div style="margin-top:6px;padding:7px 10px;border-radius:7px;background:${comp.suitabilityMismatch || comp.segMeta.isVulnerable ? '#FFFBEB' : '#F1F5F9'};border:1px solid ${comp.suitabilityMismatch || comp.segMeta.isVulnerable ? '#FCD34D' : '#CBD5E1'};font-size:8.8px;line-height:1.45;color:#334155;">
      <div><b>ประเภทผู้ลงทุน:</b> ${escapeHtmlText(comp.segMeta.fullLabel)} • <b>ขอบเขตสำรับการลงทุน:</b> ${escapeHtmlText(scopeBadgeText)}</div>
      <div style="margin-top:2px;">${suitStatusHtml}</div>
      ${vulnerableLineHtml}
      ${productRiskLineHtml}
      ${salesChecklistLineHtml}
    </div>
  `;

  const donutSvgHtml = buildPdfAllocationDonutSvg(m.dcaSchedule);
  const trajectorySvgHtml = buildPdfGoalTrajectorySvg(m, sym, pctOnly);
  const hasSafeCustomLogo = Boolean(isAdvisorMode && customLogoDataUrl && String(customLogoDataUrl).startsWith('data:image/'));
  const logoHtml = hasSafeCustomLogo
    ? `<img src="${escapeHtmlText(customLogoDataUrl)}" alt="${escapeHtmlText(brandDisplayName)}" style="max-height:42px;max-width:116px;width:auto;height:auto;object-fit:contain;border-radius:8px;background:rgba(255,255,255,0.08);padding:3px;flex-shrink:0;" />`
    : buildPdfMasterLogoInlineSvg();

  const pdfDisclaimerHtml = isIpLicense
    ? `<strong>ข้อสงวนสิทธิ์ (Disclaimer — โหมดผู้วางแผนการลงทุน IP):</strong> QuantFolio เป็นเพียงซอฟต์แวร์เครื่องมือช่วยคำนวณเชิงปริมาณเท่านั้น ส่วนคำแนะนำการลงทุน การออกแบบแผนจัดพอร์ตเฉพาะราย (Customized Asset Allocation) และการประเมินความเหมาะสม (Suitability &amp; Fair Dealing) อยู่ภายใต้ความรับผิดชอบของผู้มีใบอนุญาตที่ระบุในเอกสารนี้ คือ <strong>${escapeHtmlText(advisorName)}</strong> (${escapeHtmlText(comp.licenseMeta.shortLabel)} • เลขที่ใบอนุญาต ${escapeHtmlText(licenseNo)}${firmName ? ` • ${escapeHtmlText(firmName)}` : ''}) โดยการนำไปปฏิบัติต้องผ่านกระบวนการตรวจสอบตามระเบียบของผู้ประกอบธุรกิจ <strong>ผลการจำลองย้อนหลัง (Backtest) ไม่รับประกันผลตอบแทนในอนาคต</strong> ผู้ลงทุนควรศึกษาหนังสือชี้ชวนส่วนสรุปข้อมูลสำคัญ (Factsheet) เงื่อนไขผลตอบแทน และความเสี่ยงก่อนตัดสินใจลงทุน`
    : (isIcLicense
        ? `<strong>ข้อสงวนสิทธิ์ (Disclaimer — โหมดผู้แนะนำการลงทุน IC / Basic Asset Allocation):</strong> QuantFolio เป็นเพียงซอฟต์แวร์เครื่องมือช่วยคำนวณเชิงปริมาณเท่านั้น ส่วนคำแนะนำการลงทุน การนำเสนอ<strong>สำรับการลงทุนเบื้องต้นในรูปแบบมาตรฐานตามหลักวิชาการ (Basic Asset Allocation — มิใช่การจัดพอร์ตเฉพาะเจาะจงรายบุคคลตามเกณฑ์ ก.ล.ต. หน้า 6 และ 8)</strong> และการประเมินความเหมาะสม (Suitability &amp; Fair Dealing) อยู่ภายใต้ความรับผิดชอบของผู้มีใบอนุญาตที่ระบุในเอกสารนี้ คือ <strong>${escapeHtmlText(advisorName)}</strong> (${escapeHtmlText(comp.licenseMeta.shortLabel)} • เลขที่ใบอนุญาต ${escapeHtmlText(licenseNo)}${firmName ? ` • ${escapeHtmlText(firmName)}` : ''}) <strong>ผลการจำลองย้อนหลัง (Backtest) ไม่รับประกันผลตอบแทนในอนาคต</strong> ผู้ลงทุนควรศึกษาหนังสือชี้ชวน (Factsheet) และความเสี่ยงก่อนตัดสินใจลงทุน`
        : `<strong>ข้อสงวนสิทธิ์ (Disclaimer):</strong> QuantFolio เป็นซอฟต์แวร์เครื่องมือคำนวณเชิงปริมาณเพื่อการศึกษาและประกอบการวิเคราะห์ข้อมูลเท่านั้น ไม่ใช่ผู้ให้คำแนะนำการลงทุนที่ได้รับใบอนุญาต และไม่ใช่คำแนะนำการลงทุนเฉพาะบุคคล <strong>ผลการจำลองย้อนหลัง (Backtest) ไม่รับประกันผลตอบแทนในอนาคต</strong> การลงทุนมีความเสี่ยง ผู้ใช้งานควรตรวจสอบความถูกต้องของข้อมูลและใช้วิจารณญาณก่อนตัดสินใจลงทุน`);

  const buildReportDoc = (embedInOverlay) => `
    <!DOCTYPE html>
    <html lang="th">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${escapeHtmlText(docPageTitlePrefix)} — ${portfolioName}</title>
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans+Thai:wght@400;500;600;700&display=swap" rel="stylesheet">
      <style>
        @page {
          size: A4 portrait;
          margin: 0;
        }
        * {
          box-sizing: border-box;
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }
        body {
          margin: 0;
          padding: 0;
          background: #E2E8F0;
          color: #0F172A;
          font-family: 'IBM Plex Sans Thai', -apple-system, BlinkMacSystemFont, sans-serif;
          font-size: 11.5px;
          line-height: 1.5;
        }
        .toolbar {
          position: sticky;
          top: 0;
          z-index: 50;
          background: #0B1220;
          color: #F8FAFC;
          padding: 11px 22px;
          display: ${embedInOverlay ? 'none' : 'flex'};
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          border-bottom: 2px solid #059669;
          box-shadow: 0 6px 20px rgba(2, 6, 23, 0.35);
        }
        .toolbar-info { font-size: 12px; color: #CBD5E1; }
        .toolbar-info strong { color: #FFFFFF; }
        .toolbar-actions { display: flex; align-items: center; gap: 10px; }
        .btn-print {
          background: #059669;
          color: #FFFFFF;
          border: none;
          border-radius: 10px;
          padding: 9px 18px;
          font-family: 'IBM Plex Sans Thai', sans-serif;
          font-size: 13px;
          font-weight: 700;
          cursor: pointer;
        }
        .btn-print:hover { background: #047857; }
        .btn-close {
          background: #1E293B;
          color: #E2E8F0;
          border: 1px solid #334155;
          border-radius: 10px;
          padding: 9px 14px;
          font-family: 'IBM Plex Sans Thai', sans-serif;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
        }
        .sheets-wrap {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 18px;
          padding: 20px 12px 36px;
        }
        .a4-page {
          width: 210mm;
          min-height: 296mm;
          background: #FFFFFF;
          padding: 12mm 14mm 11mm;
          box-shadow: 0 14px 40px rgba(15, 23, 42, 0.16);
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          position: relative;
          overflow: hidden;
        }
        .page-break {
          page-break-after: always;
          break-after: page;
        }
        .masthead {
          background: #0F172A;
          color: #FFFFFF;
          border-radius: 12px;
          padding: 14px 16px;
          border-bottom: 3px solid #059669;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 14px;
        }
        .brand-row { display: flex; align-items: center; gap: 11px; min-width: 0; flex: 1; }
        .eyebrow {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 9px;
          font-weight: 600;
          letter-spacing: 0.12em;
          color: #34D399;
          text-transform: uppercase;
        }
        .doc-title {
          font-size: 16.5px;
          font-weight: 700;
          color: #FFFFFF;
          margin: 2px 0 0;
          letter-spacing: -0.01em;
          line-height: 1.3;
        }
        .doc-meta-right {
          text-align: right;
          font-size: 9.5px;
          color: #CBD5E1;
          line-height: 1.55;
          flex-shrink: 0;
          white-space: nowrap;
        }
        .doc-meta-right .mono {
          font-family: 'IBM Plex Mono', monospace;
          color: #FFFFFF;
          font-weight: 600;
        }
        .client-strip {
          margin-top: 10px;
          padding: 10px 14px;
          border-radius: 10px;
          background: #F8FAFC;
          border: 1px solid #E2E8F0;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .client-title {
          font-size: 15px;
          font-weight: 700;
          color: #0F172A;
          margin: 0;
        }
        .client-sub {
          font-size: 10.5px;
          color: #475569;
          margin-top: 2px;
        }
        .meta-pills {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          justify-content: flex-end;
        }
        .meta-pill {
          background: #FFFFFF;
          border: 1px solid #CBD5E1;
          border-radius: 7px;
          padding: 4px 8px;
          font-size: 9.5px;
          color: #334155;
        }
        .meta-pill b { color: #0F172A; font-weight: 600; }
        .kpi-grid {
          margin-top: 10px;
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 9px;
        }
        .kpi-card {
          border: 1px solid #E2E8F0;
          border-radius: 10px;
          padding: 9px 11px;
          background: #FFFFFF;
        }
        .kpi-card.accent-card {
          background: #F0FDF9;
          border-color: #A7F3D0;
        }
        .kpi-card.risk-card {
          background: #FFF5F5;
          border-color: #FECDD3;
        }
        .kpi-lbl {
          font-size: 9.5px;
          font-weight: 600;
          color: #475569;
        }
        .kpi-val {
          font-family: 'IBM Plex Mono', monospace;
          font-variant-numeric: tabular-nums;
          font-size: 14.5px;
          font-weight: 700;
          color: #0F172A;
          margin-top: 3px;
          line-height: 1.2;
        }
        .kpi-val.emerald { color: #008A57; }
        .kpi-val.rose { color: #BE123C; }
        .kpi-sub {
          font-size: 9.5px;
          color: #64748B;
          margin-top: 3px;
          font-variant-numeric: tabular-nums;
        }
        .charts-grid {
          margin-top: 11px;
          display: grid;
          grid-template-columns: 0.92fr 1.28fr;
          gap: 10px;
        }
        .panel-box {
          border: 1px solid #E2E8F0;
          border-radius: 10px;
          padding: 10px 12px;
          background: #FFFFFF;
          break-inside: avoid;
        }
        .sec-title {
          font-size: 11.5px;
          font-weight: 700;
          color: #0F172A;
          margin: 0 0 7px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-left: 3px solid #00B873;
          padding-left: 7px;
        }
        .sec-title span.tag {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 9px;
          font-weight: 600;
          color: #64748B;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          font-size: 10.5px;
        }
        thead th {
          background: #F1F5F9;
          color: #334155;
          font-weight: 700;
          font-size: 9.5px;
          padding: 6.5px 8px;
          border-top: 1px solid #CBD5E1;
          border-bottom: 1.5px solid #94A3B8;
          text-align: left;
        }
        thead th.num { text-align: right; }
        tbody td, tfoot td {
          padding: 6px 8px;
          border-bottom: 1px solid #E2E8F0;
          vertical-align: middle;
        }
        td.num {
          text-align: right;
          font-family: 'IBM Plex Mono', monospace;
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
        }
        td.bold { font-weight: 700; color: #0F172A; }
        td.accent { font-weight: 700; color: #008A57; }
        td.danger { font-weight: 700; color: #BE123C; }
        td.muted { color: #475569; }
        tr.active-row td { background: #ECFDF5; }
        tfoot td {
          background: #F8FAFC;
          font-weight: 700;
          border-top: 1.5px solid #94A3B8;
          border-bottom: 1.5px solid #94A3B8;
          color: #0F172A;
        }
        .ticker {
          font-family: 'IBM Plex Mono', monospace;
          font-weight: 700;
          color: #0F172A;
          font-size: 10.5px;
        }
        .sub-name { font-size: 9px; color: #64748B; }
        table.annex-table { font-size: 9.2px; }
        table.annex-table thead th { font-size: 8.8px; padding: 5px 6px; }
        table.annex-table tbody td,
        table.annex-table tfoot td { padding: 3.8px 6px; line-height: 1.3; }
        table.annex-table .ticker { font-size: 9.4px; display: inline; margin-right: 5px; }
        table.annex-table .annex-sub-name {
          display: inline;
          font-size: 8.2px;
          color: #64748B;
        }
        .badge-selected {
          display: inline-block;
          margin-left: 6px;
          padding: 1px 6px;
          border-radius: 999px;
          background: #00D084;
          color: #07130E;
          font-size: 8.5px;
          font-weight: 700;
        }
        .running-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding-bottom: 7px;
          border-bottom: 2px solid #0B1220;
          margin-bottom: 11px;
          font-size: 10px;
          color: #475569;
        }
        .running-header strong { color: #0F172A; font-size: 11px; }
        .stress-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 8px;
          margin-top: 6px;
        }
        .stress-tile {
          background: #F8FAFC;
          border: 1px solid #E2E8F0;
          border-radius: 8px;
          padding: 7px 9px;
        }
        .stress-tile.rose { background: #FFF5F5; border-color: #FECDD3; }
        .stress-tile .st-lbl { font-size: 9px; color: #64748B; font-weight: 600; }
        .stress-tile .st-val {
          font-family: 'IBM Plex Mono', monospace;
          font-variant-numeric: tabular-nums;
          font-size: 12px;
          font-weight: 700;
          color: #0F172A;
          margin-top: 2px;
        }
        .stress-tile.rose .st-val { color: #BE123C; }
        .commentary-box {
          background: #F8FAFC;
          border: 1px solid #CBD5E1;
          border-left: 4px solid #0B1220;
          border-radius: 8px;
          padding: 10px 12px;
          font-size: 10.5px;
          color: #1E293B;
          line-height: 1.65;
        }
        .disclaimer-box {
          background: #FFFBEB;
          border: 1px solid #FCD34D;
          border-left: 3px solid #D97706;
          border-radius: 8px;
          padding: 8px 11px;
          font-size: 9px;
          color: #475569;
          line-height: 1.5;
        }
        .disclaimer-box strong { color: #92400E; }
        .page-footer {
          margin-top: 10px;
          padding-top: 7px;
          border-top: 1px solid #E2E8F0;
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 9px;
          color: #64748B;
        }
        .page-footer .pg-num {
          font-family: 'IBM Plex Mono', monospace;
          font-weight: 600;
          color: #334155;
        }
        @media print {
          body { background: #FFFFFF; }
          .toolbar { display: none !important; }
          .sheets-wrap { padding: 0; gap: 0; }
          .a4-page {
            width: 210mm;
            height: 296mm;
            min-height: 296mm;
            box-shadow: none;
            margin: 0;
          }
        }
      </style>
    </head>
    <body>
      <div class="toolbar">
        <div class="toolbar-info">
          <strong>${escapeHtmlText(docPageTitlePrefix)} (${pageCountBadgeText})</strong> — ฟอนต์ IBM Plex Sans Thai + IBM Plex Mono |
          แนะนำ: เลือกปลายทาง <strong>"Save as PDF"</strong> และเปิด <strong>"Background graphics"</strong>
        </div>
        <div class="toolbar-actions">
          <button type="button" class="btn-close" onclick="window.close()">ปิดหน้าต่าง</button>
          <button type="button" class="btn-print" onclick="window.print()">สั่งพิมพ์ / บันทึกเป็น PDF</button>
        </div>
      </div>

      <div class="sheets-wrap">
        <!-- ===================== PAGE 1: EXECUTIVE SUMMARY & ALLOCATION ===================== -->
        <section class="a4-page page-break">
          <div>
            <!-- Institutional Masthead -->
            <div class="masthead">
              <div class="brand-row">
                ${logoHtml}
                <div style="min-width:0;">
                  <div class="eyebrow">${escapeHtmlText(brandEyebrowPrefix)} • ${docModeEyebrow}</div>
                  <div class="doc-title">${docModeTitleTh}</div>
                </div>
              </div>
              <div class="doc-meta-right">
                <div>รหัสเอกสาร: <span class="mono">${docRef}</span></div>
                <div>วันที่ออกรายงาน: <span class="mono">${escapeHtmlText(todayStr)}</span></div>
                <div>ราคาปิด ณ: <span class="mono">${escapeHtmlText(dataAsOf)}</span> • FX: <span class="mono">${fxVal} ฿/$</span></div>
              </div>
            </div>

            <!-- Client & Plan Strip -->
            <div class="client-strip">
              <div>
                <h1 class="client-title">${portfolioName}</h1>
                <div class="client-sub">หมวดเป้าหมาย: <b>${escapeHtmlText(m.goalLabel)}</b> • กลยุทธ์: <b>${escapeHtmlText(m.strategyName)}</b> • ระยะเวลา <b>${m.years} ปี</b>${hasInfl ? ` • ปรับลดเงินเฟ้อ ${m.inflationRate.toFixed(1)}%/ปี` : ''}</div>
              </div>
              <div class="meta-pills">
                ${clientName ? `<div class="meta-pill">จัดทำสำหรับ: <b>${escapeHtmlText(clientName)}</b></div>` : ''}
                ${clientSegment && clientSegment !== 'general' ? `<div class="meta-pill" style="${comp.segMeta.isVulnerable ? 'background:#FFFBEB;border-color:#FCD34D;color:#92400E;' : ''}">กลุ่มผู้ลงทุน: <b>${escapeHtmlText(comp.segMeta.shortLabel)}</b></div>` : ''}
                ${advisorName ? `<div class="meta-pill">${isAdvisorMode ? escapeHtmlText(comp.licenseMeta.roleTitleTh) : 'ผู้จัดทำ'}: <b>${escapeHtmlText(advisorName)}</b></div>` : ''}
                ${isAdvisorMode && licenseNo ? `<div class="meta-pill">ใบอนุญาต (${escapeHtmlText(comp.licenseMeta.shortLabel)}): <b style="font-family:'IBM Plex Mono',monospace;">${escapeHtmlText(licenseNo)}</b></div>` : ''}
                <div class="meta-pill">เป้าหมายการเงิน: <b style="font-family:'IBM Plex Mono',monospace;">${fmtAmt(m.targetAmount, 0, true)}</b></div>
              </div>
            </div>

            <!-- 4 Executive KPI Cards -->
            <div class="kpi-grid">
              <div class="kpi-card">
                <div class="kpi-lbl">1. เงินต้นตั้งต้น + ออม DCA/เดือน</div>
                <div class="kpi-val">${fmtAmt(m.initialBudget, 0, false)}</div>
                <div class="kpi-sub">${pctOnly ? 'โหมดแสดงเฉพาะสัดส่วน (%)' : `ออมเพิ่ม ${fmtAmt(m.monthlyDca, 0, false)}/ด. (รวมต้น ${fmtAmt(m.totalPrincipal, 0, false)})`}</div>
              </div>
              <div class="kpi-card accent-card">
                <div class="kpi-lbl">2. มูลค่าพอร์ตคาดการณ์ (${m.years} ปี)</div>
                <div class="kpi-val emerald">${pctOnly ? `${m.achievementPct}% ของเป้า` : fmtAmt(hasInfl ? m.realProjectedFinalWealth : m.projectedFinalWealth, 0, false)}</div>
                <div class="kpi-sub">${pctOnly ? (hasInfl ? `เทียบเป้าหมายหลังเงินเฟ้อ (${m.inflationRate.toFixed(1)}%/ปี)` : 'เทียบสัดส่วนเป้าหมายที่ตั้งไว้') : (hasInfl ? `มูลค่าจริงวันนี้ (${m.achievementPct}% ของเป้า)` : `กำไรทบต้น +${fmtAmt(m.netProfit, 0, false)} (${m.achievementPct}%)`)}</div>
              </div>
              <div class="kpi-card">
                <div class="kpi-lbl">3. ผลตอบแทนจำลอง / เงินปันผล*</div>
                <div class="kpi-val emerald">${(m.effectiveAnnualReturn * 100).toFixed(2)}%/ปี</div>
                <div class="kpi-sub">Yield ${(m.divYield * 100).toFixed(2)}% ก่อนหักภาษี*${pctOnly ? '' : ` (~${fmtAmt(m.estMonthlyDividendAtEnd, 0, false)}/ด.)`}</div>
              </div>
              <div class="kpi-card risk-card">
                <div class="kpi-lbl">4. ความผันผวน / ย่อตัวหนักสุดอดีต</div>
                <div class="kpi-val rose">${mddPctStr}</div>
                <div class="kpi-sub">ความผันผวน ${(m.annualVol * 100).toFixed(2)}%/ปี (จากจุดสูงสุดสู่จุดต่ำสุด)</div>
              </div>
            </div>

            <!-- Dual Crisp Vector SVG Charts -->
            <div class="charts-grid">
              <div class="panel-box">
                <h2 class="sec-title">สัดส่วนพอร์ตเป้าหมาย <span class="tag">ALLOCATION</span></h2>
                ${donutSvgHtml}
              </div>
              <div class="panel-box">
                <h2 class="sec-title">เส้นทางการเติบโตสู่เป้าหมาย (${m.years} ปี) <span class="tag">DCA PROJECTION</span></h2>
                ${trajectorySvgHtml}
              </div>
            </div>

            <!-- Actionable Allocation & Monthly DCA Schedule Table -->
            <div class="panel-box" style="margin-top:11px;">
              <h2 class="sec-title">ตารางแผนจัดสรรเงินก้อนแรกและออมรายเดือน (DCA Schedule) <span class="tag">${m.dcaSchedule.length} ASSETS • ${m.currency}</span></h2>
              <table>
                <thead>
                  <tr>
                    <th>สินทรัพย์ (Ticker)</th>
                    <th class="num">สัดส่วน (%)</th>
                    <th class="num">เงินก้อนแรก</th>
                    <th class="num">หน่วยโดยประมาณ</th>
                    <th class="num">ออมเพิ่ม/เดือน (DCA)</th>
                    <th class="num">ปันผลเฉลี่ย*</th>
                  </tr>
                </thead>
                <tbody>${allocRowsHtml}</tbody>
                <tfoot>
                  <tr>
                    <td>รวมทั้งหมด (${m.dcaSchedule.length} สินทรัพย์)</td>
                    <td class="num">100.00%</td>
                    <td class="num">${pctOnly ? '—' : fmtAmt(Math.round(m.initialBudget), 0, false)}</td>
                    <td class="num">—</td>
                    <td class="num accent">${pctOnly ? '—' : `${fmtAmt(Math.round(m.monthlyDca), 0, false)}/ด.`}</td>
                    <td class="num">${(m.divYield * 100).toFixed(2)}%</td>
                  </tr>
                </tfoot>
              </table>
              <div style="margin-top:5px;font-size:8.6px;color:#64748B;line-height:1.45;">
                *หมายเหตุภาษีเงินปันผล: ปันผลคาดการณ์ก่อนหักภาษี ณ ที่จ่าย (หุ้นไทยหัก 10%, หุ้น/ETF สหรัฐฯ หัก 15%–30% ตามอนุสัญญาภาษีซ้อน) • ตัวเลขจัดสรรปัดเศษลงตัวตรงยอดรวมพอดี
              </div>
            </div>
          </div>

          <div class="page-footer">
            <span>${escapeHtmlText(brandDisplayName)} • ${!isAdvisorMode ? 'Portfolio Simulation Report (เอกสารจำลองเพื่อการศึกษา)' : (isIpLicense ? 'Executive Investment Proposal (IP Customized Asset Allocation)' : 'Basic Asset Allocation Report (IC สำรับการลงทุนเบื้องต้นตามหลักวิชาการมาตรฐาน)')}</span>
            <span class="pg-num">หน้า 1 / ${totalPages}</span>
          </div>
        </section>

        <!-- ===================== PAGE 2: BENCHMARK, STRESS TEST, MILESTONES & COMMENTARY ===================== -->
        <section class="a4-page${needsAnnexPage ? ' page-break' : ''}">
          <div>
            <div class="running-header">
              <div><strong>${portfolioName}</strong> • ${escapeHtmlText(m.strategyName)}</div>
              <div style="font-family:'IBM Plex Mono',monospace;">${docRef} | ${escapeHtmlText(todayStr)}</div>
            </div>

            <!-- Section 1: 4-Strategy Quantitative Benchmark -->
            <div class="panel-box">
              <h2 class="sec-title">1. เปรียบเทียบ 4 กลยุทธ์เชิงปริมาณ (Quantitative Strategy Comparison) <span class="tag">MPT / HRP / 1/N</span></h2>
              <table>
                <thead>
                  <tr>
                    <th>กลยุทธ์การจัดพอร์ต</th>
                    <th class="num">ผลตอบแทน/ปี</th>
                    <th class="num">ความผันผวน/ปี</th>
                    <th class="num">ย่อตัวหนักสุดอดีต</th>
                    <th class="num">Sharpe Ratio</th>
                    <th class="num">มูลค่าปลายงวดย้อนหลัง</th>
                  </tr>
                </thead>
                <tbody>${compareRowsHtml}</tbody>
              </table>
            </div>

            <!-- Section 2: Historical Crisis Stress Test (Peak -> Loss -> Trough) -->
            <div class="panel-box" style="margin-top:11px;">
              <h2 class="sec-title">2. ผลทดสอบช่วงวิกฤตในอดีต (Historical Stress Test: Peak ➔ Trough) <span class="tag">RISK GUARDRAIL</span></h2>
              <div class="stress-grid">
                <div class="stress-tile">
                  <div class="st-lbl">มูลค่าจุดสูงสุดก่อนย่อ</div>
                  <div class="st-val">${pctOnly ? '100.0%' : fmtAmt(peakVal, 0, false)}</div>
                </div>
                <div class="stress-tile rose">
                  <div class="st-lbl">ย่อตัวสูงสุดจากจุดสูงสุด</div>
                  <div class="st-val">${pctOnly ? mddPctStr : `${fmtAmt(-Math.abs(lossVal), 0, false)} (${mddPctStr})`}</div>
                </div>
                <div class="stress-tile">
                  <div class="st-lbl">มูลค่าพอร์ตจุดต่ำสุด</div>
                  <div class="st-val" style="color:#008A57;">${pctOnly ? `${(100 - Math.abs(Number(strat?.max_drawdown || 0) * 100)).toFixed(1)}%` : fmtAmt(troughVal, 0, false)}</div>
                </div>
                <div class="stress-tile">
                  <div class="st-lbl">ช่วงเวลา &amp; การฟื้นตัว</div>
                  <div class="st-val" style="font-size:10px;">${escapeHtmlText(dd.peak_date || '—')} ➔ ${escapeHtmlText(dd.trough_date || '—')}</div>
                  <div style="font-size:8.5px;color:#64748B;margin-top:1px;">${dd.recovery_days !== null && dd.recovery_days !== undefined ? `ฟื้นตัวใน ${dd.recovery_days} วัน (${escapeHtmlText(dd.recovery_date || '-')})` : 'ยังไม่ฟื้นตัวกลับจุดเดิมในช่วงข้อมูล'}</div>
                </div>
              </div>
              <div style="margin-top:7px;font-size:9.5px;color:#475569;">
                <b>จำลองเทียบเงินต้น:</b> หากเข้าลงทุนเงินก้อนแรก${pctOnly ? '' : ` ${fmtAmt(m.initialBudget, 0, true)}`} ตรงจุดสูงสุดของตลาดพอดี พอร์ตอาจย่อตัวชั่วคราวราว <b style="color:#BE123C;">${pctOnly ? mddPctStr : fmtAmt(-Math.abs(scaledLoss), 0, true)}</b> (คำนวณจากสถิติราคาย้อนหลังพร้อมหักค่าธรรมเนียมจำลอง 0.15%)
              </div>
            </div>

            <!-- Section 3: Yearly Milestone Projection Table -->
            <div class="panel-box" style="margin-top:11px;">
              <h2 class="sec-title">3. ตารางเป้าหมายรายปีแยก 3 สถานการณ์ (Milestone Roadmap) <span class="tag">${hasInfl ? `REAL VALUE (เงินเฟ้อ ${m.inflationRate.toFixed(1)}%/ปี)` : 'NOMINAL PROJECTION'}</span></h2>
              <table>
                <thead>
                  <tr>
                    <th>ระยะเวลา</th>
                    <th class="num">เงินต้นสะสม</th>
                    <th class="num">ตลาดซบเซา (${(m.conservativeAnnualReturn * 100).toFixed(1)}%)</th>
                    <th class="num">กรณีฐาน (${(m.effectiveAnnualReturn * 100).toFixed(1)}%)</th>
                    <th class="num">ตลาดดี (${(m.bullAnnualReturn * 100).toFixed(1)}%)</th>
                    <th class="num">ปันผลคาดการณ์/ปี*</th>
                  </tr>
                </thead>
                <tbody>${milestoneRowsHtml}</tbody>
              </table>
              <div style="margin-top:4px;font-size:8.5px;color:#64748B;">*ปันผลคาดการณ์ก่อนหักภาษี ณ ที่จ่าย (หุ้นไทยหัก 10%, หุ้น/ETF สหรัฐฯ หัก 15%–30%)</div>
            </div>

            <!-- Section 4: Planning Summary (Simulation) or Basic/Customized Asset Allocation Commentary (Licensed IC/IP) -->
            <div class="panel-box" style="margin-top:11px;">
              <h2 class="sec-title">${section4Title} <span class="tag">${section4Tag}</span></h2>
              <div class="commentary-box">${finalCommentaryHtml}</div>
              ${fairDealingStripHtml}
            </div>
          </div>

          <div>
            <div class="disclaimer-box">${pdfDisclaimerHtml}</div>
            <div class="page-footer">
              <span>${escapeHtmlText(brandDisplayName)}${advisorName ? ` • จัดทำโดย ${escapeHtmlText(advisorName)}${isAdvisorMode && licenseNo ? ` (${escapeHtmlText(comp.licenseMeta.shortLabel)} • ${escapeHtmlText(licenseNo)})` : ''}` : ''}${clientName ? ` • สำหรับ ${escapeHtmlText(clientName)}` : ''}</span>
              <span class="pg-num">หน้า 2 / ${totalPages}</span>
            </div>
          </div>
        </section>

        ${needsAnnexPage ? `
        <!-- ===================== PAGE 3 (AUTO-ANNEX): FULL 13-25 ASSET ALLOCATION SCHEDULE ===================== -->
        <section class="a4-page" data-pdf-annex="true">
          <div>
            <div class="running-header">
              <div><strong>${portfolioName}</strong> • ภาคผนวกจัดสรรสินทรัพย์ครบ ${allSchedule.length} ตัว</div>
              <div style="font-family:'IBM Plex Mono',monospace;">${docRef} | ${escapeHtmlText(todayStr)}</div>
            </div>

            <div class="panel-box">
              <h2 class="sec-title">ภาคผนวก: ตารางจัดสรรเงินก้อนแรกและแผนออมรายเดือนฉบับเต็ม (Full Allocation &amp; DCA Schedule) <span class="tag">${allSchedule.length} ASSETS • ${m.currency}</span></h2>
              <table class="annex-table">
                <thead>
                  <tr>
                    <th class="num" style="width:28px;">#</th>
                    <th>สินทรัพย์ (Ticker &amp; Name)</th>
                    <th class="num">สัดส่วน (%)</th>
                    <th class="num">เงินก้อนแรก</th>
                    <th class="num">หน่วยโดยประมาณ</th>
                    <th class="num">ออมเพิ่ม/เดือน</th>
                    <th class="num">ปันผล*</th>
                  </tr>
                </thead>
                <tbody>${annexAllRowsHtml}</tbody>
                <tfoot>
                  <tr>
                    <td colspan="2">รวมทั้งหมดครบทุก ${allSchedule.length} สินทรัพย์</td>
                    <td class="num">100.00%</td>
                    <td class="num">${pctOnly ? '—' : fmtAmt(Math.round(m.initialBudget), 0, false)}</td>
                    <td class="num">—</td>
                    <td class="num accent">${pctOnly ? '—' : `${fmtAmt(Math.round(m.monthlyDca), 0, false)}/ด.`}</td>
                    <td class="num">${(m.divYield * 100).toFixed(2)}%</td>
                  </tr>
                </tfoot>
              </table>
              <div style="margin-top:6px;font-size:8.4px;color:#64748B;line-height:1.45;">
                *หมายเหตุ: ภาคผนวกนี้สร้างขึ้นอัตโนมัติสำหรับพอร์ตที่มีมากกว่า 12 สินทรัพย์ (รองรับ Advisor Pro สูงสุด 25 สินทรัพย์) เพื่อให้แสดงรายชื่อสินทรัพย์ สัดส่วน และแผน DCA ครบทุกตัวโดยไม่มีการตัดบรรทัด • ปันผลคาดการณ์ก่อนหักภาษี ณ ที่จ่าย
              </div>
            </div>
          </div>

          <div class="page-footer">
            <span>${escapeHtmlText(brandDisplayName)} • ภาคผนวกตารางจัดสรรสินทรัพย์ฉบับเต็ม (${allSchedule.length} สินทรัพย์)</span>
            <span class="pg-num">หน้า 3 / 3</span>
          </div>
        </section>
        ` : ''}
      </div>
    </body>
    </html>
  `;

  window.__lastPdfReportOptions = options || {};
  window.__lastInstitutionalPdfStandaloneHtml = buildReportDoc(false);

  const overlay = document.getElementById('pdf-a4-preview-overlay');
  const iframe = document.getElementById('pdf-a4-preview-iframe');
  const overlayTitle = document.getElementById('pdf-a4-preview-header-title');
  const tierInfo = getActiveUserTierInfo();
  const printLabelEl = document.getElementById('btn-print-a4-preview-label');
  const printIconEl = document.getElementById('btn-print-a4-preview-icon');
  const openTabBtnEl = document.getElementById('btn-open-pdf-new-tab');
  if (printLabelEl) {
    printLabelEl.innerText = tierInfo.canDownloadSimPdf
      ? 'สั่งพิมพ์ / บันทึกเป็น PDF'
      : 'เข้าสู่ระบบฟรีเพื่อพิมพ์ / ดาวน์โหลด PDF';
  }
  if (printIconEl) {
    printIconEl.setAttribute('data-lucide', tierInfo.canDownloadSimPdf ? 'printer' : 'lock');
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  }
  if (openTabBtnEl) {
    // Declutter #1: In Guest mode hide duplicate secondary lock button so only 1 clear primary green signup CTA appears
    openTabBtnEl.classList.toggle('hidden', !tierInfo.canDownloadSimPdf);
    openTabBtnEl.innerText = 'เปิดแท็บใหม่ ↗';
  }
  if (overlayTitle) {
    overlayTitle.innerText = !isAdvisorMode
      ? `ตัวอย่างรายงานจำลองพอร์ตการลงทุน (${pageCountBadgeText})`
      : (isIpLicense
          ? `ตัวอย่างเอกสารเสนอแผนจัดพอร์ตเฉพาะราย (IP) — ${brandDisplayName} (${pageCountBadgeText})`
          : `ตัวอย่างรายงานสำรับการลงทุนมาตรฐาน (IC Basic Asset Allocation) — ${brandDisplayName} (${pageCountBadgeText})`);
  }
  if (overlay && iframe) {
    iframe.srcdoc = buildReportDoc(true);
    overlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    if (window.lucide) lucide.createIcons();
    return;
  }

  openInstitutionalPdfInNewTab();
}

function showPortfolioToastApp(message) {
  const cleanMsg = String(message || '').trim();
  if (!cleanMsg) return;
  const toastEl = document.getElementById('portfolio-toast');
  if (!toastEl) return;
  const msgEl = document.getElementById('portfolio-toast-text');
  if (msgEl) {
    msgEl.innerText = cleanMsg;
  } else {
    toastEl.innerHTML = `<div class="flex items-center gap-2"><div class="w-2 h-2 rounded-full bg-emerald-400"></div><span id="portfolio-toast-text">${escapeHtmlText(cleanMsg)}</span></div>`;
  }
  toastEl.classList.remove('hidden');
  clearTimeout(window.__portfolioToastTimeout);
  window.__portfolioToastTimeout = setTimeout(() => {
    toastEl.classList.add('hidden');
  }, 3500);
}
window.__appShowPortfolioToast = showPortfolioToastApp;

if (typeof window !== 'undefined') {
  window.renderTickersList = renderTickersList;
  window.renderNewsAndSignalSection = renderNewsAndSignalSection;
  window.refreshLiveMarketNews = refreshLiveMarketNews;
  window.syncPdfReportModeFields = syncPdfReportModeFields;
  window.openHelpGuideModal = openHelpGuideModal;
  window.switchHelpGuideTab = switchHelpGuideTab;
  window.QuantFolioCalc = {
    getAssetPriceInCurrentCurrency,
    convertNativePrice,
    getEffectiveAssetPrice,
    markResultsStale,
    setResultStatus,
    setAppView,
    showLandingShowcase,
    selectStockCatalogCategory,
    toggleCatalogTicker,
    renderQuickStockCatalog,
    fetchDynamicPopularAssets,
    applyPopularAssetsPayload,
    filterInsightsByTicker,
    selectLandingRiskProfile,
    selectLandingRiskProfileByStep,
    enterWorkspaceWithRiskProfile,
    enterWorkspaceFromLanding,
    enterWorkspaceWithPreset,
    enterWorkspaceAndCalculate,
    selectLandingPreset,
    setLandingQuickBudget,
    syncLandingBudgetToWorkspace,
    selectLandingPreviewTab,
    computeRebalancePlan,
    allocateExactIntegers,
    computeGoalProjectionMetrics,
    computePortfolioEntryReadiness,
    inspectTickerOnInsightsTab,
    evaluatePdfFairDealingCompliance,
    setCanonicalFxField,
    resetPortfolioNameOnTickerMutation,
    escapeHtmlText,
    sanitizeExternalUrl
  };
}
