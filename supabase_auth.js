/**
 * ============================================================================
 * QuantFolio - ระบบยืนยันตัวตน (Authentication) และจัดการพอร์ตการลงทุน (Portfolio Storage)
 * ทำงานร่วมกันแบบ Dual-Engine: Supabase Cloud (lxnmugciuddpqjhjwxoh.supabase.co) + Server Auth API
 * เพื่อให้เข้าสู่ระบบและบันทึกพอร์ตได้ 100% แม้กรณี Supabase ติด Email Rate Limit (429)
 * ============================================================================
 */

const SUPABASE_URL = 'https://lxnmugciuddpqjhjwxoh.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_BIzSoBWXPoDAkNCsJONajQ_keCu4r5D';

localStorage.removeItem('qf_demo_user');
localStorage.setItem('qf_supabase_url', SUPABASE_URL);
localStorage.setItem('qf_supabase_anon_key', SUPABASE_ANON_KEY);

const supabaseClient = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
let currentUser = null;
let hasSupabaseJwtSession = false;
let savedPortfoliosList = [];
let authTabMode = 'signin'; // 'signin' | 'signup'

/**
 * สลับแท็บระหว่าง "เข้าสู่ระบบ (Sign In)" และ "สมัครสมาชิกใหม่ (Sign Up)"
 */
function switchAuthTab(mode) {
  authTabMode = mode === 'signup' ? 'signup' : 'signin';
  const signInTab = document.getElementById('auth-tab-signin');
  const signUpTab = document.getElementById('auth-tab-signup');
  const nameWrap = document.getElementById('real-auth-name-wrap');
  const submitBtn = document.getElementById('btn-real-email-auth');
  const msgBox = document.getElementById('modal-diagnostic-alert');

  if (msgBox) msgBox.classList.add('hidden');

  if (authTabMode === 'signup') {
    if (signUpTab) signUpTab.className = 'py-2 text-xs font-bold rounded-lg bg-white text-slate-900 shadow-xs transition';
    if (signInTab) signInTab.className = 'py-2 text-xs font-semibold rounded-lg text-slate-600 hover:text-slate-900 transition';
    if (nameWrap) nameWrap.classList.remove('hidden');
    if (submitBtn) submitBtn.innerText = 'สมัครสมาชิกและเข้าใช้งาน';
  } else {
    if (signInTab) signInTab.className = 'py-2 text-xs font-bold rounded-lg bg-white text-slate-900 shadow-xs transition';
    if (signUpTab) signUpTab.className = 'py-2 text-xs font-semibold rounded-lg text-slate-600 hover:text-slate-900 transition';
    if (nameWrap) nameWrap.classList.add('hidden');
    if (submitBtn) submitBtn.innerText = 'เข้าสู่ระบบเพื่อใช้งาน';
  }
}

/**
 * ตรวจสอบสถานะการตั้งค่าบนเซิร์ฟเวอร์ Supabase
 */
async function checkSupabaseAuthSettings() {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/settings`, {
      headers: { apikey: SUPABASE_ANON_KEY }
    });
    if (!res.ok) return { ok: false, googleEnabled: false };
    const settings = await res.json();
    return {
      ok: true,
      googleEnabled: Boolean(settings?.external?.google),
      emailEnabled: Boolean(settings?.external?.email),
      autoconfirm: Boolean(settings?.mailer_autoconfirm)
    };
  } catch (err) {
    return { ok: false, googleEnabled: false };
  }
}

/**
 * โหลด Session ของผู้ใช้เมื่อเปิดหน้าเว็บ
 */
async function initSupabaseAuth() {
  try {
    if (supabaseClient) {
      const { data: { session }, error } = await supabaseClient.auth.getSession();
      if (!error && session && session.user) {
        currentUser = session.user;
        hasSupabaseJwtSession = true;
        localStorage.setItem('qf_verified_session_user', JSON.stringify(currentUser));
        updateAuthUI(currentUser);
        await fetchUserPortfolios();
      }
    }

    // หากยังไม่มี Supabase JWT Session ให้ตรวจสอบ Session ที่ยืนยันผ่าน Backend Server แล้ว
    if (!currentUser) {
      const savedUserJson = localStorage.getItem('qf_verified_session_user');
      if (savedUserJson) {
        try {
          const parsedUser = JSON.parse(savedUserJson);
          if (parsedUser && parsedUser.id && parsedUser.email) {
            currentUser = parsedUser;
            hasSupabaseJwtSession = false;
            updateAuthUI(currentUser);
            await fetchUserPortfolios();
          }
        } catch (e) {
          localStorage.removeItem('qf_verified_session_user');
        }
      }
    }

    if (!currentUser) {
      updateAuthUI(null);
      renderSavedPortfoliosList([]);
    }

    if (supabaseClient) {
      supabaseClient.auth.onAuthStateChange(async (event, session) => {
        if (session && session.user) {
          currentUser = session.user;
          hasSupabaseJwtSession = true;
          localStorage.setItem('qf_verified_session_user', JSON.stringify(currentUser));
          updateAuthUI(currentUser);
          await fetchUserPortfolios();
          if (event === 'SIGNED_IN') {
            const meta = currentUser.user_metadata || {};
            const name = meta.full_name || meta.name || currentUser.email;
            showPortfolioToast(`เข้าสู่ระบบสำเร็จในชื่อ ${name}`);
          }
        }
      });
    }
  } catch (err) {
    console.error('Auth Init Error:', err);
    if (!currentUser) updateAuthUI(null);
  }
}

/**
 * เมื่อกดปุ่ม Login with Google
 */
async function loginWithGoogle() {
  const status = await checkSupabaseAuthSettings();
  if (status.googleEnabled && supabaseClient) {
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin + window.location.pathname,
        queryParams: {
          access_type: 'offline',
          prompt: 'consent'
        }
      }
    });
    if (error) {
      showAuthAlert('เกิดข้อผิดพลาดในการเชื่อมต่อ Google OAuth: ' + error.message, 'error');
    }
    return;
  }

  openSupabaseConfigModal();
  showAuthAlert(
    'ระบบตรวจพบว่าบน Supabase ยังไม่ได้บันทึก Google Client ID จึงยังไม่สามารถเปิดหน้าต่าง Google OAuth ได้ กรุณากรอกอีเมลและรหัสผ่านด้านบนเพื่อเข้าสู่ระบบและใช้งานได้ทันที',
    'info'
  );
  const emailInput = document.getElementById('real-auth-email');
  if (emailInput) emailInput.focus();
}

/**
 * ปุ่มกดเชื่อมต่อ Google OAuth ในหน้าต่าง Login
 */
async function forceGoogleOAuthRedirect() {
  const status = await checkSupabaseAuthSettings();
  if (!status.googleEnabled) {
    showAuthAlert(
      'บนโปรเจกต์ Supabase ของคุณยังไม่ได้เปิดใช้งาน Google Provider (หรือยังไม่ได้ใส่ Client ID และกด Save) กรุณากรอกอีเมลและรหัสผ่านในช่องด้านบนเพื่อเข้าสู่ระบบทันที',
      'info'
    );
    const emailInput = document.getElementById('real-auth-email');
    if (emailInput) emailInput.focus();
    return;
  }

  if (supabaseClient) {
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin + window.location.pathname,
        queryParams: {
          access_type: 'offline',
          prompt: 'consent'
        }
      }
    });
    if (error) {
      showAuthAlert('ไม่สามารถเชื่อมต่อ Google OAuth ได้: ' + error.message, 'error');
    }
  }
}

function showAuthAlert(message, type = 'info') {
  const msgBox = document.getElementById('modal-diagnostic-alert');
  if (!msgBox) {
    alert(message);
    return;
  }
  if (type === 'error') {
    msgBox.className = 'p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-xs leading-relaxed';
  } else if (type === 'success') {
    msgBox.className = 'p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs leading-relaxed';
  } else {
    msgBox.className = 'p-3 rounded-lg bg-blue-50 border border-blue-200 text-blue-900 text-xs leading-relaxed';
  }
  msgBox.innerText = message;
  msgBox.classList.remove('hidden');
}

/**
 * เข้าสู่ระบบหรือสมัครสมาชิกด้วยอีเมลและรหัสผ่าน
 * ทำงานแบบ Dual-Engine: เชื่อมต่อทั้ง Supabase Auth และ Backend Auth API
 */
async function loginOrSignUpWithRealGmail() {
  const nameInput = document.getElementById('real-auth-name');
  const emailInput = document.getElementById('real-auth-email');
  const passwordInput = document.getElementById('real-auth-password');
  const msgBox = document.getElementById('modal-diagnostic-alert');
  const submitBtn = document.getElementById('btn-real-email-auth');

  const email = (emailInput?.value || '').trim().toLowerCase();
  const password = (passwordInput?.value || '').trim();
  const fullName = (nameInput?.value || '').trim() || (email ? email.split('@')[0] : 'ผู้ใช้งาน QuantFolio');

  if (msgBox) msgBox.classList.add('hidden');

  if (!email || !email.includes('@')) {
    showAuthAlert('กรุณากรอกอีเมลของคุณให้ถูกต้อง เช่น yourname@gmail.com', 'error');
    emailInput?.focus();
    return;
  }
  if (!password || password.length < 6) {
    showAuthAlert('กรุณากรอกรหัสผ่านอย่างน้อย 6 ตัวอักษร', 'error');
    passwordInput?.focus();
    return;
  }

  try {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerText = 'กำลังตรวจสอบและเข้าสู่ระบบ...';
    }

    // ขั้นตอนที่ 1: ลองเข้าสู่ระบบผ่าน Supabase Auth ก่อน
    if (supabaseClient) {
      const signInRes = await supabaseClient.auth.signInWithPassword({ email, password });
      if (!signInRes.error && signInRes.data?.session) {
        currentUser = signInRes.data.session.user;
        hasSupabaseJwtSession = true;
        localStorage.setItem('qf_verified_session_user', JSON.stringify(currentUser));
        // ซิงค์บัญชีไว้ใน Backend ด้วย
        try {
          const syncRes = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, full_name: fullName, mode: authTabMode })
          });
          if (syncRes.ok) {
            const syncData = await syncRes.json();
            if (syncData.token) {
              currentUser.token = syncData.token;
              localStorage.setItem('qf_verified_session_token', syncData.token);
            }
          }
        } catch (e) {}
        updateAuthUI(currentUser);
        await fetchUserPortfolios();
        showPortfolioToast(`เข้าสู่ระบบสำเร็จในชื่อ ${fullName}`);
        return;
      }

      // หากยังไม่มีใน Supabase หรือเป็นโหมดสมัครสมาชิก ลองเรียก signUp บน Supabase
      const avatarUrl = buildLocalAvatarSvg(fullName);
      const signUpRes = await supabaseClient.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: window.location.origin + window.location.pathname,
          data: { full_name: fullName, name: fullName, avatar_url: avatarUrl }
        }
      });

      if (!signUpRes.error && signUpRes.data?.session) {
        currentUser = signUpRes.data.session.user;
        hasSupabaseJwtSession = true;
        localStorage.setItem('qf_verified_session_user', JSON.stringify(currentUser));
        updateAuthUI(currentUser);
        await fetchUserPortfolios();
        showPortfolioToast(`สมัครสมาชิกและเข้าสู่ระบบสำเร็จในชื่อ ${fullName}`);
        return;
      }
    }

    // ขั้นตอนที่ 2: กรณี Supabase ติด Email Rate Limit (429) หรือรอ Confirm Email
    // ให้ยืนยันตัวตนผ่านระบบ Server Auth API (/api/auth/login) เพื่อให้เข้าใช้งานได้ทันทีโดยไม่ค้างหน้า Login
    const backendRes = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        full_name: fullName,
        mode: authTabMode
      })
    });

    const backendData = await backendRes.json();
    if (!backendRes.ok) {
      throw new Error(backendData.detail || 'ไม่สามารถเข้าสู่ระบบได้ กรุณาตรวจสอบอีเมลและรหัสผ่าน');
    }

    currentUser = backendData.user;
    if (backendData.token) {
      currentUser.token = backendData.token;
      localStorage.setItem('qf_verified_session_token', backendData.token);
    }
    hasSupabaseJwtSession = false;
    localStorage.setItem('qf_verified_session_user', JSON.stringify(currentUser));
    updateAuthUI(currentUser);
    await fetchUserPortfolios();

    const displayName = currentUser.user_metadata?.full_name || currentUser.email;
    showPortfolioToast(`เข้าสู่ระบบสำเร็จในชื่อ ${displayName}`);
  } catch (err) {
    showAuthAlert(err.message || 'ไม่สามารถเข้าสู่ระบบได้', 'error');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerText = authTabMode === 'signup' ? 'สมัครสมาชิกและเข้าใช้งาน' : 'เข้าสู่ระบบเพื่อใช้งาน';
    }
  }
}

function escapeHtml(raw) {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildLocalAvatarSvg(name) {
  const clean = String(name || 'QF').trim();
  const initials = escapeHtml((clean.slice(0, 2) || 'QF').toUpperCase());
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="#1d4ed8"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" fill="#ffffff" font-family="sans-serif" font-size="24" font-weight="bold">${initials}</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

function getBackendAuthHeaders() {
  const token = (currentUser && currentUser.token) || localStorage.getItem('qf_verified_session_token') || '';
  return token ? { 'Authorization': `Bearer ${token}` } : {};
}

/**
 * เข้าใช้งานในโหมดทดลองใช้งานทั่วไป (Guest Mode) โดยไม่ต้องเข้าสู่ระบบ
 */
function continueAsGuest() {
  sessionStorage.setItem('qf_guest_mode', '1');
  const modal = document.getElementById('supabase-config-modal');
  const mainWorkspace = document.getElementById('main-app-workspace');
  if (modal) modal.classList.add('hidden');
  document.body.style.overflow = '';
  if (mainWorkspace) {
    mainWorkspace.classList.remove('pointer-events-none', 'select-none', 'blur-xs');
  }
  showPortfolioToast('เข้าสู่โหมดทดลองใช้งาน (Guest Mode) — สามารถใช้งานวิเคราะห์พอร์ตได้ครบทุกฟังก์ชัน');
}

/**
 * ออกจากระบบ (Logout) และล้างข้อมูลพอร์ตที่แคชไว้ในเบราว์เซอร์เพื่อความปลอดภัย
 */
async function logoutUser() {
  try {
    if (supabaseClient) {
      await supabaseClient.auth.signOut();
    }
  } catch (e) {}
  localStorage.removeItem('qf_verified_session_user');
  localStorage.removeItem('qf_verified_session_token');
  try {
    Object.keys(localStorage).forEach(k => {
      if (k.startsWith('quantfolio_portfolios_')) {
        localStorage.removeItem(k);
      }
    });
  } catch (e) {}
  sessionStorage.removeItem('qf_guest_mode');
  currentUser = null;
  hasSupabaseJwtSession = false;
  savedPortfoliosList = [];
  updateAuthUI(null);
  renderSavedPortfoliosList([]);
  showPortfolioToast('ออกจากระบบและล้างข้อมูลแคชพอร์ตในเบราว์เซอร์เรียบร้อยแล้ว');
}

/**
 * ลบบัญชีผู้ใช้งานและข้อมูลพอร์ตทั้งหมดออกจากระบบ (PDPA Right to Erasure)
 */
async function deleteUserAccount() {
  if (!currentUser) return;
  if (!confirm(`ยืนยันการลบบัญชี "${currentUser.email}" และพอร์ตที่บันทึกไว้ทั้งหมดอย่างถาวรหรือไม่?`)) {
    return;
  }
  try {
    const res = await fetch('/api/auth/account', {
      method: 'DELETE',
      headers: getBackendAuthHeaders()
    });
    if (!res.ok) {
      throw new Error('ไม่สามารถลบบัญชีได้ในขณะนี้');
    }
    await logoutUser();
    showPortfolioToast('ลบบัญชีผู้ใช้งานและข้อมูลพอร์ตทั้งหมดเรียบร้อยแล้ว');
  } catch (err) {
    alert('เกิดข้อผิดพลาดในการลบบัญชี: ' + err.message);
  }
}

/**
 * อัปเดตสถานะการล็อกหน้าจอและข้อมูลโปรไฟล์บนแถบด้านบน
 */
function updateAuthUI(user) {
  const modal = document.getElementById('supabase-config-modal');
  const mainWorkspace = document.getElementById('main-app-workspace');
  const loggedOutBox = document.getElementById('auth-logged-out-box');
  const loggedInBox = document.getElementById('auth-logged-in-box');
  const userNameEl = document.getElementById('user-profile-name');
  const userEmailEl = document.getElementById('user-profile-email');
  const userAvatarEl = document.getElementById('user-profile-avatar');
  const savePanelBadge = document.getElementById('portfolio-storage-auth-badge');

  if (!user) {
    // เปิดหน้าเว็บให้ทดลองใช้งานฟอร์มได้ทันทีโดยไม่บังคับแสดงป๊อปอัป (เปิดเมื่อผู้ใช้กดปุ่มเข้าสู่ระบบหรือกดบันทึกพอร์ต)
    if (modal) modal.classList.add('hidden');
    document.body.style.overflow = '';
    if (mainWorkspace) {
      mainWorkspace.classList.remove('pointer-events-none', 'select-none', 'blur-xs');
    }

    if (loggedOutBox) loggedOutBox.classList.remove('hidden');
    if (loggedInBox) loggedInBox.classList.add('hidden');
    if (savePanelBadge) {
      savePanelBadge.innerText = 'โหมดทดลองใช้ฟรี (เข้าสู่ระบบเมื่อต้องการบันทึกพอร์ต)';
      savePanelBadge.className = 'text-xs font-semibold px-2.5 py-1 rounded bg-amber-50 text-amber-800 border border-amber-200';
    }
    return;
  }

  // ปลดล็อกหน้าจอเมื่อเข้าสู่ระบบสำเร็จแล้ว
  if (modal) modal.classList.add('hidden');
  document.body.style.overflow = '';
  if (mainWorkspace) {
    mainWorkspace.classList.remove('pointer-events-none', 'select-none', 'blur-xs');
  }

  const meta = user.user_metadata || {};
  const displayName = meta.full_name || meta.name || (user.email ? user.email.split('@')[0] : 'ผู้ใช้งาน QuantFolio');
  const email = user.email || '';
  const rawAvatar = meta.avatar_url || meta.picture || '';
  const avatarUrl = (rawAvatar && !String(rawAvatar).includes('ui-avatars.com')) ? rawAvatar : buildLocalAvatarSvg(displayName);

  if (userNameEl) userNameEl.innerText = displayName;
  if (userEmailEl) userEmailEl.innerText = email;
  if (userAvatarEl) {
    userAvatarEl.src = avatarUrl;
    userAvatarEl.alt = displayName;
  }

  if (loggedOutBox) loggedOutBox.classList.add('hidden');
  if (loggedInBox) loggedInBox.classList.remove('hidden');

  if (savePanelBadge) {
    savePanelBadge.innerText = `บัญชีที่ใช้งาน: ${email}`;
    savePanelBadge.className = 'text-[10px] font-semibold px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200';
  }
}

/**
 * บันทึกข้อมูลพอร์ตการลงทุนของผู้ใช้
 */
async function saveUserPortfolio() {
  if (!currentUser) {
    openSupabaseConfigModal();
    showAuthAlert(
      'กรุณาเข้าสู่ระบบด้วยอีเมลหรือบัญชี Google เพื่อบันทึกพอร์ตเก็บไว้ในบัญชีของคุณ (หรือกดปุ่ม "ทดลองใช้งานทันที" ด้านบนเพื่อวิเคราะห์พอร์ตต่อโดยไม่ต้องบันทึก)',
      'info'
    );
    return;
  }

  const nameInput = document.getElementById('save-portfolio-name');
  const catInput = document.getElementById('save-goal-category');
  const targetInput = document.getElementById('save-target-amount');
  const dcaInput = document.getElementById('save-monthly-dca');
  const yearsInput = document.getElementById('save-period-years');
  const budgetInput = document.getElementById('budget-input');
  const saveBtn = document.getElementById('btn-save-portfolio');

  const portfolioName = (nameInput?.value || '').trim();
  const goalType = catInput?.value || 'retirement';
  const goalLabelsMap = {
    retirement: 'พอร์ตเกษียณมั่นคง',
    dividend: 'พอร์ตสร้างเงินปันผล',
    growth: 'พอร์ตเติบโตสูง',
    preservation: 'พอร์ตพักเงินปลอดภัย',
    custom: 'กำหนดเป้าหมายเอง'
  };
  const goalLabel = goalLabelsMap[goalType] || 'พอร์ตตามเป้าหมาย';

  const rawTargetStr = String(targetInput?.value || '').replace(/,/g, '').trim();
  const targetAmount = parseFloat(rawTargetStr) || 1000000;
  const rawDcaStr = String(dcaInput?.value || '').replace(/,/g, '').trim();
  const monthlyDca = parseFloat(rawDcaStr) || 0;
  const rawBudgetStr = String(budgetInput?.value || '').replace(/,/g, '').trim();
  const initialBudget = parseFloat(rawBudgetStr) || (window.state?.optData?.metadata?.budget || 100000);
  const investmentPeriodYears = parseInt(yearsInput?.value, 10) || 5;

  if (!portfolioName) {
    alert('กรุณาตั้งชื่อพอร์ตหรือเป้าหมายการลงทุน เช่น "พอร์ตเงินเกษียณ"');
    nameInput?.focus();
    return;
  }

  const appState = window.state || (typeof state !== 'undefined' ? state : null);
  const assetWeightsJson = {};
  let activeStrategyKey = 'max_sharpe';
  let tickersList = [];
  let expectedRet = 0.12;
  let expectedVol = 0.16;
  let divYield = 0.02;

  if (appState) {
    activeStrategyKey = appState.activeGoal || 'max_sharpe';
    tickersList = Array.isArray(appState.tickers) ? [...appState.tickers] : [];
    if (appState.optData && appState.optData.strategies && appState.optData.strategies[activeStrategyKey]) {
      const strat = appState.optData.strategies[activeStrategyKey];
      const rawWeights = strat.weights || {};
      Object.entries(rawWeights).forEach(([ticker, weightDecimal]) => {
        const pct = Number((weightDecimal * 100).toFixed(2));
        if (pct > 0) {
          assetWeightsJson[ticker] = pct;
        }
      });
      expectedRet = Number(strat.expected_return || 0.12);
      expectedVol = Number(strat.volatility || 0.16);
      divYield = Number(strat.dividend_yield !== undefined ? strat.dividend_yield : 0.02);
    }
  }

  // Fallback equal weights if user saves before optimization finishes
  if (Object.keys(assetWeightsJson).length === 0 && tickersList.length > 0) {
    const eqPct = Number((100 / tickersList.length).toFixed(2));
    tickersList.forEach(t => {
      assetWeightsJson[t] = eqPct;
    });
  }

  const projMetrics = (typeof computeGoalProjectionMetrics === 'function')
    ? computeGoalProjectionMetrics()
    : { projectedFinalWealth: targetAmount, achievementPct: 100 };

  const payload = {
    portfolio_name: portfolioName,
    goal_type: goalType,
    goal_label: goalLabel,
    target_amount: targetAmount,
    initial_budget: initialBudget,
    monthly_dca: monthlyDca,
    investment_period_years: investmentPeriodYears,
    currency: appState ? (appState.currency || 'THB') : 'THB',
    tickers: tickersList.length > 0 ? tickersList : Object.keys(assetWeightsJson),
    asset_weights: assetWeightsJson,
    strategy_key: activeStrategyKey,
    expected_return: expectedRet,
    expected_volatility: expectedVol,
    dividend_yield: divYield,
    projected_final_value: projMetrics.projectedFinalWealth || 0,
    goal_achievement_pct: projMetrics.achievementPct || 0
  };

  try {
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.innerText = 'กำลังบันทึก...';
    }

    let savedSuccessfully = false;
    let savedRecord = null;

    // 1. บันทึกลง Supabase ถ้าระบบมี JWT Session
    if (hasSupabaseJwtSession && supabaseClient) {
      const { error } = await supabaseClient
        .from('user_portfolios')
        .insert([{
          user_id: currentUser.id,
          portfolio_name: payload.portfolio_name,
          target_amount: payload.target_amount,
          investment_period_years: payload.investment_period_years,
          asset_weights: payload.asset_weights,
          strategy_key: payload.strategy_key
        }]);
      if (!error) {
        savedSuccessfully = true;
      }
    }

    // 2. บันทึกลง Server API เสมอเพื่อให้ข้อมูลไม่สูญหาย
    const res = await fetch('/api/portfolios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getBackendAuthHeaders() },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      const resJson = await res.json();
      savedRecord = resJson.portfolio || null;
      savedSuccessfully = true;
    }

    // 3. สำรองข้อมูลลง Browser LocalStorage สำหรับผู้ใช้นี้ด้วย (ป้องกันข้อมูลหายบน Serverless Cold Start)
    try {
      const localKey = `quantfolio_portfolios_${currentUser.id}`;
      const localArr = JSON.parse(localStorage.getItem(localKey) || '[]');
      const recordToStore = savedRecord || {
        ...payload,
        id: 'local-' + Date.now(),
        created_at: new Date().toISOString()
      };
      const filtered = localArr.filter(item => item.portfolio_name !== recordToStore.portfolio_name);
      filtered.unshift(recordToStore);
      localStorage.setItem(localKey, JSON.stringify(filtered.slice(0, 30)));
      savedSuccessfully = true;
    } catch (e) {
      console.warn('Local portfolio backup notice:', e);
    }

    if (!savedSuccessfully) {
      throw new Error('ไม่สามารถบันทึกข้อมูลพอร์ตได้');
    }

    await fetchUserPortfolios();
    showPortfolioToast(`สร้างและบันทึกพอร์ต "${portfolioName}" (${goalLabel}) เรียบร้อยแล้ว`);
  } catch (err) {
    console.error('Save portfolio error:', err);
    alert('เกิดข้อผิดพลาดในการบันทึกพอร์ต: ' + err.message);
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = `<i data-lucide="bookmark-plus" class="w-4 h-4"></i><span>สร้างและบันทึกพอร์ตตามเป้าหมายนี้</span>`;
      if (window.lucide) lucide.createIcons();
    }
  }
}

/**
 * ดึงรายการพอร์ตที่บันทึกไว้ของผู้ใช้
 */
async function fetchUserPortfolios() {
  if (!currentUser) {
    renderSavedPortfoliosList([]);
    return [];
  }

  try {
    const combined = [];
    const seenKeys = new Set();

    const addUniquePortfolio = (p) => {
      if (!p || !p.portfolio_name) return;
      const key = `${p.portfolio_name.trim().toLowerCase()}|${Math.round(Number(p.target_amount || 0))}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        combined.push(p);
      }
    };

    // 1. ดึงจาก Server API ก่อนเพราะมีฟิลด์ Goal & DCA ครบถ้วนที่สุด
    try {
      const res = await fetch('/api/portfolios', {
        headers: getBackendAuthHeaders()
      });
      if (res.ok) {
        const serverData = await res.json();
        if (Array.isArray(serverData.portfolios)) {
          serverData.portfolios.forEach(addUniquePortfolio);
        }
      }
    } catch (e) {
      console.warn('Server portfolio fetch notice:', e);
    }

    // 2. ดึงจาก LocalStorage สำรองของเบราว์เซอร์
    try {
      const localKey = `quantfolio_portfolios_${currentUser.id}`;
      const localArr = JSON.parse(localStorage.getItem(localKey) || '[]');
      if (Array.isArray(localArr)) {
        localArr.forEach(addUniquePortfolio);
      }
    } catch (e) {
      console.warn('Local portfolio read notice:', e);
    }

    // 3. ดึงจาก Supabase ถ้าระบบมี JWT Session
    if (hasSupabaseJwtSession && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('user_portfolios')
        .select('id, user_id, portfolio_name, target_amount, investment_period_years, asset_weights, strategy_key, created_at')
        .eq('user_id', currentUser.id)
        .order('created_at', { ascending: false });
      if (!error && Array.isArray(data)) {
        data.forEach(addUniquePortfolio);
      }
    }

    savedPortfoliosList = combined;
    renderSavedPortfoliosList(savedPortfoliosList);
    return savedPortfoliosList;
  } catch (err) {
    console.error('Fetch portfolios error:', err);
    return [];
  }
}

/**
 * ลบพอร์ตที่บันทึกไว้
 */
async function deleteUserPortfolio(portfolioId) {
  if (!currentUser) return;

  try {
    const targetItem = savedPortfoliosList.find(p => String(p.id) === String(portfolioId));

    if (hasSupabaseJwtSession && supabaseClient) {
      await supabaseClient
        .from('user_portfolios')
        .delete()
        .eq('id', portfolioId)
        .eq('user_id', currentUser.id);
    }

    await fetch(`/api/portfolios/${encodeURIComponent(portfolioId)}`, {
      method: 'DELETE',
      headers: getBackendAuthHeaders()
    });

    try {
      const localKey = `quantfolio_portfolios_${currentUser.id}`;
      const localArr = JSON.parse(localStorage.getItem(localKey) || '[]');
      const nextLocal = localArr.filter(item =>
        String(item.id) !== String(portfolioId) &&
        (!targetItem || item.portfolio_name !== targetItem.portfolio_name)
      );
      localStorage.setItem(localKey, JSON.stringify(nextLocal));
    } catch (e) {
      // ignore
    }

    await fetchUserPortfolios();
    showPortfolioToast('ลบรายการพอร์ตที่บันทึกไว้เรียบร้อยแล้ว');
  } catch (err) {
    alert('ไม่สามารถลบพอร์ตได้: ' + err.message);
  }
}

/**
 * โหลดข้อมูลพอร์ตที่บันทึกไว้กลับมาคำนวณและแสดงผลบน Dashboard
 */
function loadSavedPortfolioToDashboard(portfolioId) {
  const item = savedPortfoliosList.find(p => String(p.id) === String(portfolioId));
  if (!item) return;

  const appState = window.state || (typeof state !== 'undefined' ? state : null);
  const weightsObj = item.asset_weights || {};
  const savedTickers = (Array.isArray(item.tickers) && item.tickers.length >= 2)
    ? item.tickers
    : Object.keys(weightsObj);

  if (item.currency && (item.currency === 'THB' || item.currency === 'USD') && typeof setGlobalCurrency === 'function') {
    setGlobalCurrency(item.currency);
  }

  if (savedTickers.length >= 2 && appState) {
    appState.tickers = [...savedTickers];
    if (typeof renderTickersList === 'function') renderTickersList();
    if (typeof fetchLiveQuotesForTickers === 'function') fetchLiveQuotesForTickers();
  }

  const nameEl = document.getElementById('save-portfolio-name');
  if (nameEl && item.portfolio_name) nameEl.value = item.portfolio_name;

  const catEl = document.getElementById('save-goal-category');
  if (catEl && item.goal_type) catEl.value = item.goal_type;

  const initBudget = Number(item.initial_budget || 100000);
  const budgetEl = document.getElementById('budget-input');
  if (budgetEl) {
    budgetEl.value = initBudget.toLocaleString('en-US', { maximumFractionDigits: 0 });
  }

  if (item.target_amount) {
    const formattedTarget = Number(item.target_amount).toLocaleString('en-US', { maximumFractionDigits: 0 });
    const saveTargetEl = document.getElementById('save-target-amount');
    if (saveTargetEl) saveTargetEl.value = formattedTarget;
  }

  if (item.monthly_dca !== undefined) {
    const formattedDca = Number(item.monthly_dca).toLocaleString('en-US', { maximumFractionDigits: 0 });
    const saveDcaEl = document.getElementById('save-monthly-dca');
    if (saveDcaEl) saveDcaEl.value = formattedDca;
  }

  if (item.investment_period_years) {
    const saveYearsEl = document.getElementById('save-period-years');
    if (saveYearsEl) saveYearsEl.value = item.investment_period_years;
  }

  if (item.strategy_key && ['max_sharpe', 'min_volatility', 'hrp', 'equal_weight'].includes(item.strategy_key)) {
    if (typeof selectGoal === 'function') selectGoal(item.strategy_key);
  }

  if (typeof runOptimization === 'function') {
    runOptimization();
  }
  if (typeof recalculateGoalProjection === 'function') {
    recalculateGoalProjection();
  }
  showPortfolioToast(`ดึงพอร์ตตามเป้าหมาย "${item.portfolio_name}" กลับมาคำนวณบนหน้าเว็บแล้ว`);
}

function renderSavedPortfoliosList(portfolios) {
  const container = document.getElementById('saved-portfolios-container');
  const countBadge = document.getElementById('saved-portfolios-count');
  const headerCountBadge = document.getElementById('header-saved-portfolios-count');
  if (countBadge) countBadge.innerText = portfolios.length;
  if (headerCountBadge) {
    if (portfolios.length > 0) {
      headerCountBadge.innerText = portfolios.length;
      headerCountBadge.classList.remove('hidden');
    } else {
      headerCountBadge.innerText = '';
      headerCountBadge.classList.add('hidden');
    }
  }
  if (!container) return;

  if (!currentUser) {
    container.innerHTML = `
      <div class="p-4 text-center rounded-lg bg-white border border-dashed border-slate-300 text-xs text-slate-500">
        กรุณาเข้าสู่ระบบเพื่อดูและจัดการรายการพอร์ตตามเป้าหมายของคุณ
      </div>
    `;
    return;
  }

  if (portfolios.length === 0) {
    container.innerHTML = `
      <div class="p-4 text-center rounded-lg bg-white border border-dashed border-slate-300 text-xs text-slate-500">
        ยังไม่มีพอร์ตตามเป้าหมายที่บันทึกไว้ คุณสามารถเลือกต้นแบบเป้าหมายด้านบนแล้วกดปุ่ม <b>"สร้างและบันทึกพอร์ตตามเป้าหมายนี้"</b> ได้ทันที
      </div>
    `;
    return;
  }

  const stratLabels = {
    max_sharpe: 'เน้นกำไรคุ้มความเสี่ยงที่สุด',
    min_volatility: 'เน้นปลอดภัย เงินต้นแกว่งน้อย',
    hrp: 'เน้นกระจายความเสี่ยงสมดุล',
    equal_weight: 'แบ่งเงินเท่ากันทุกตัว'
  };

  container.innerHTML = portfolios.map(p => {
    const sym = p.currency === 'USD' ? '$' : '฿';
    const weights = p.asset_weights || {};
    const weightEntries = Object.entries(weights).sort((a, b) => b[1] - a[1]);
    const weightBadges = weightEntries.length > 0
      ? weightEntries
          .map(([ticker, pct]) => `<span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-blue-50 text-blue-800 border border-blue-200">${escapeHtml(ticker)}: ${escapeHtml(pct)}%</span>`)
          .join(' ')
      : `<span class="text-[11px] text-slate-500">กดปุ่ม "ดึงพอร์ตมาใช้งาน" เพื่อคำนวณสัดส่วนล่าสุด</span>`;

    const targetNum = Number(p.target_amount || 1000000);
    const initBudgetNum = Number(p.initial_budget || 100000);
    const dcaNum = Number(p.monthly_dca !== undefined ? p.monthly_dca : 5000);
    const yearsNum = Number(p.investment_period_years || 5);
    const projValNum = Number(p.projected_final_value || targetNum);
    const achievePct = Number(p.goal_achievement_pct || Math.min(150, Math.round((projValNum / Math.max(1, targetNum)) * 1000) / 10));
    const barW = Math.max(5, Math.min(100, achievePct));

    const goalLabel = escapeHtml(p.goal_label || 'พอร์ตตามเป้าหมาย');
    const safePortfolioName = escapeHtml(p.portfolio_name);
    const safeId = escapeHtml(p.id);
    const stratName = escapeHtml(stratLabels[p.strategy_key] || 'Max Sharpe Ratio');
    const dateStr = p.created_at ? new Date(p.created_at).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

    return `
      <div class="p-3.5 rounded-xl bg-white border border-slate-200 hover:border-indigo-300 shadow-2xs transition space-y-2.5">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 pb-2">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="px-2 py-0.5 rounded bg-indigo-600 text-white text-[10px] font-bold">${goalLabel}</span>
            <span class="font-bold text-xs text-slate-900">${safePortfolioName}</span>
            <span class="px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-mono text-[10px] font-semibold">กลยุทธ์: ${stratName}</span>
            <span class="text-[10px] text-slate-400">บันทึกเมื่อ ${escapeHtml(dateStr)}</span>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onclick="loadSavedPortfolioToDashboard('${safeId}')"
              class="px-3 py-1.5 text-xs font-bold bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition"
            >
              ดึงพอร์ตมาใช้งาน / ปรับสัดส่วน
            </button>
            <button
              type="button"
              onclick="deleteUserPortfolio('${safeId}')"
              title="ลบพอร์ตนี้"
              class="p-1.5 text-slate-400 hover:text-rose-600 rounded-lg hover:bg-rose-50 transition"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
            </button>
          </div>
        </div>

        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <div class="p-2 rounded-lg bg-slate-50 border border-slate-100">
            <div class="text-[10px] text-slate-500">เงินลงทุนก้อนแรก</div>
            <div class="font-mono font-bold text-slate-900">${sym}${initBudgetNum.toLocaleString()}</div>
          </div>
          <div class="p-2 rounded-lg bg-slate-50 border border-slate-100">
            <div class="text-[10px] text-slate-500">ออมรายเดือน (DCA) / ระยะเวลา</div>
            <div class="font-mono font-bold text-emerald-700">${sym}${dcaNum.toLocaleString()}/ด. (${yearsNum} ปี)</div>
          </div>
          <div class="p-2 rounded-lg bg-indigo-50/50 border border-indigo-100">
            <div class="text-[10px] text-indigo-800">มูลค่าพอร์ตคาดการณ์</div>
            <div class="font-mono font-bold text-indigo-700">${sym}${Math.round(projValNum).toLocaleString()}</div>
          </div>
          <div class="p-2 rounded-lg bg-emerald-50/50 border border-emerald-100">
            <div class="flex items-center justify-between text-[10px]">
              <span class="text-emerald-900 font-semibold">เป้าหมาย ${sym}${targetNum.toLocaleString()}</span>
              <span class="font-mono font-bold ${achievePct >= 100 ? 'text-emerald-700' : 'text-amber-700'}">${achievePct}%</span>
            </div>
            <div class="w-full h-1.5 bg-slate-200 rounded-full overflow-hidden mt-1">
              <div class="h-full ${achievePct >= 100 ? 'bg-emerald-600' : 'bg-amber-500'} rounded-full" style="width:${barW}%"></div>
            </div>
          </div>
        </div>

        <div class="flex items-center gap-1.5 flex-wrap pt-0.5">
          <span class="text-[10px] font-semibold text-slate-500 mr-1">สัดส่วนสินทรัพย์ในพอร์ต:</span>
          ${weightBadges}
        </div>
      </div>
    `;
  }).join('');
}

async function openSupabaseConfigModal() {
  const modal = document.getElementById('supabase-config-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }

  const statusBadge = document.getElementById('google-provider-status-badge');
  if (statusBadge) {
    const st = await checkSupabaseAuthSettings();
    if (st.googleEnabled) {
      statusBadge.innerText = 'สถานะ: เชื่อมต่อระบบยืนยันตัวตนพร้อมใช้งาน';
      statusBadge.className = 'text-[11px] font-medium px-2.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 inline-block';
    } else {
      statusBadge.innerText = 'สถานะ: พร้อมเข้าสู่ระบบด้วยอีเมลและรหัสผ่านทันที';
      statusBadge.className = 'text-[11px] font-medium px-2.5 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200 inline-block';
    }
  }
}

function closeSupabaseConfigModal() {
  sessionStorage.setItem('qf_guest_mode', '1');
  const modal = document.getElementById('supabase-config-modal');
  const mainWorkspace = document.getElementById('main-app-workspace');
  if (modal) modal.classList.add('hidden');
  document.body.style.overflow = '';
  if (mainWorkspace) {
    mainWorkspace.classList.remove('pointer-events-none', 'select-none', 'blur-xs');
  }
}

function showPortfolioToast(msg) {
  const toast = document.getElementById('portfolio-toast');
  if (!toast) return;
  toast.innerText = msg;
  toast.classList.remove('hidden');
  setTimeout(() => {
    toast.classList.add('hidden');
  }, 4000);
}

document.addEventListener('DOMContentLoaded', () => {
  initSupabaseAuth();
});
