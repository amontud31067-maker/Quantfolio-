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
        fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, full_name: fullName, mode: authTabMode })
        }).catch(() => {});
        updateAuthUI(currentUser);
        await fetchUserPortfolios();
        showPortfolioToast(`เข้าสู่ระบบสำเร็จในชื่อ ${fullName}`);
        return;
      }

      // หากยังไม่มีใน Supabase หรือเป็นโหมดสมัครสมาชิก ลองเรียก signUp บน Supabase
      const avatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}&background=1d4ed8&color=fff&bold=true`;
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

/**
 * ออกจากระบบ (Logout) และล็อกหน้าจอกลับสู่หน้า Login ทันที
 */
async function logoutUser() {
  try {
    if (supabaseClient) {
      await supabaseClient.auth.signOut();
    }
  } catch (e) {}
  localStorage.removeItem('qf_verified_session_user');
  currentUser = null;
  hasSupabaseJwtSession = false;
  savedPortfoliosList = [];
  updateAuthUI(null);
  renderSavedPortfoliosList([]);
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
    if (modal) modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    if (mainWorkspace) {
      mainWorkspace.classList.add('pointer-events-none', 'select-none', 'blur-xs');
    }

    if (loggedOutBox) loggedOutBox.classList.remove('hidden');
    if (loggedInBox) loggedInBox.classList.add('hidden');
    if (savePanelBadge) {
      savePanelBadge.innerText = 'ยังไม่ได้เข้าสู่ระบบ';
      savePanelBadge.className = 'text-[10px] font-semibold px-2 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200';
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
  const avatarUrl = meta.avatar_url || meta.picture || `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=1d4ed8&color=fff&bold=true`;

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
    return;
  }

  const nameInput = document.getElementById('save-portfolio-name');
  const targetInput = document.getElementById('save-target-amount');
  const yearsInput = document.getElementById('save-period-years');
  const saveBtn = document.getElementById('btn-save-portfolio');

  const portfolioName = (nameInput?.value || '').trim();
  const rawTargetStr = String(targetInput?.value || '').replace(/,/g, '').trim();
  const targetAmount = parseFloat(rawTargetStr) || (window.state?.optData?.metadata?.budget || 100000);
  const investmentPeriodYears = parseInt(yearsInput?.value, 10) || 5;

  if (!portfolioName) {
    alert('กรุณาตั้งชื่อพอร์ตหรือเป้าหมายการลงทุน เช่น "พอร์ตเงินเกษียณ"');
    nameInput?.focus();
    return;
  }

  const assetWeightsJson = {};
  if (window.state && state.optData && state.optData.strategies[state.activeGoal]) {
    const rawWeights = state.optData.strategies[state.activeGoal].weights || {};
    Object.entries(rawWeights).forEach(([ticker, weightDecimal]) => {
      const pct = Number((weightDecimal * 100).toFixed(2));
      if (pct > 0) {
        assetWeightsJson[ticker] = pct;
      }
    });
  }

  const payload = {
    user_id: currentUser.id,
    email: currentUser.email || '',
    portfolio_name: portfolioName,
    target_amount: targetAmount,
    investment_period_years: investmentPeriodYears,
    asset_weights: assetWeightsJson,
    strategy_key: window.state ? state.activeGoal : 'max_sharpe'
  };

  try {
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.innerText = 'กำลังบันทึก...';
    }

    let savedSuccessfully = false;

    // 1. บันทึกลง Supabase ถ้าระบบมี JWT Session
    if (hasSupabaseJwtSession && supabaseClient) {
      const { error } = await supabaseClient
        .from('user_portfolios')
        .insert([{
          user_id: payload.user_id,
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      savedSuccessfully = true;
    }

    if (!savedSuccessfully) {
      throw new Error('ไม่สามารถบันทึกข้อมูลพอร์ตได้');
    }

    if (nameInput) nameInput.value = '';
    await fetchUserPortfolios();
    showPortfolioToast(`บันทึกพอร์ต "${portfolioName}" เรียบร้อยแล้ว`);
  } catch (err) {
    console.error('Save portfolio error:', err);
    alert('เกิดข้อผิดพลาดในการบันทึกพอร์ต: ' + err.message);
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerText = 'บันทึกพอร์ตนี้';
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
    let combined = [];

    if (hasSupabaseJwtSession && supabaseClient) {
      const { data, error } = await supabaseClient
        .from('user_portfolios')
        .select('id, user_id, portfolio_name, target_amount, investment_period_years, asset_weights, strategy_key, created_at')
        .eq('user_id', currentUser.id)
        .order('created_at', { ascending: false });
      if (!error && Array.isArray(data)) {
        combined = data;
      }
    }

    const res = await fetch(`/api/portfolios?user_id=${encodeURIComponent(currentUser.id)}&email=${encodeURIComponent(currentUser.email || '')}`);
    if (res.ok) {
      const serverData = await res.json();
      if (Array.isArray(serverData.portfolios)) {
        const existingNames = new Set(combined.map(p => `${p.portfolio_name}|${p.target_amount}`));
        serverData.portfolios.forEach(sp => {
          const key = `${sp.portfolio_name}|${sp.target_amount}`;
          if (!existingNames.has(key)) {
            combined.push(sp);
          }
        });
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
    if (hasSupabaseJwtSession && supabaseClient) {
      await supabaseClient
        .from('user_portfolios')
        .delete()
        .eq('id', portfolioId)
        .eq('user_id', currentUser.id);
    }

    await fetch(`/api/portfolios/${encodeURIComponent(portfolioId)}?user_id=${encodeURIComponent(currentUser.id)}`, {
      method: 'DELETE'
    });

    await fetchUserPortfolios();
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

  const weightsObj = item.asset_weights || {};
  const tickers = Object.keys(weightsObj);

  if (tickers.length >= 2 && window.state) {
    state.tickers = tickers;
    renderTickersList();
    fetchLiveQuotesForTickers();
  }

  if (item.target_amount) {
    const formattedTarget = Number(item.target_amount).toLocaleString('en-US', { maximumFractionDigits: 2 });
    const budgetEl = document.getElementById('budget-input');
    if (budgetEl) budgetEl.value = formattedTarget;
    const saveTargetEl = document.getElementById('save-target-amount');
    if (saveTargetEl) saveTargetEl.value = formattedTarget;
  }

  if (item.investment_period_years) {
    const saveYearsEl = document.getElementById('save-period-years');
    if (saveYearsEl) saveYearsEl.value = item.investment_period_years;
  }

  if (item.strategy_key && ['max_sharpe', 'min_volatility', 'hrp', 'equal_weight'].includes(item.strategy_key)) {
    selectGoal(item.strategy_key);
  }

  runOptimization();
  showPortfolioToast(`โหลดพอร์ต "${item.portfolio_name}" ขึ้นแสดงบน Dashboard แล้ว`);
}

function renderSavedPortfoliosList(portfolios) {
  const container = document.getElementById('saved-portfolios-container');
  const countBadge = document.getElementById('saved-portfolios-count');
  if (countBadge) countBadge.innerText = portfolios.length;
  if (!container) return;

  if (!currentUser) {
    container.innerHTML = `
      <div class="p-4 text-center rounded-lg bg-slate-50 border border-dashed border-slate-300 text-xs text-slate-500">
        กรุณาเข้าสู่ระบบเพื่อดูและจัดการรายการพอร์ตการลงทุนของคุณ
      </div>
    `;
    return;
  }

  if (portfolios.length === 0) {
    container.innerHTML = `
      <div class="p-4 text-center rounded-lg bg-slate-50 border border-dashed border-slate-300 text-xs text-slate-500">
        ยังไม่มีพอร์ตที่บันทึกไว้ คุณสามารถตั้งชื่อพอร์ตด้านบนแล้วกดปุ่ม <b>"บันทึกพอร์ตนี้"</b> ได้ทันที
      </div>
    `;
    return;
  }

  container.innerHTML = portfolios.map(p => {
    const weights = p.asset_weights || {};
    const weightBadges = Object.entries(weights)
      .sort((a, b) => b[1] - a[1])
      .map(([ticker, pct]) => `<span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-blue-50 text-blue-700 border border-blue-200">${ticker}: ${pct}%</span>`)
      .join(' ');

    const targetFormatted = Number(p.target_amount || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
    const dateStr = p.created_at ? new Date(p.created_at).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

    return `
      <div class="p-3 rounded-lg bg-white border border-slate-200 hover:border-blue-300 transition flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div class="space-y-1">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-bold text-xs text-slate-900">${p.portfolio_name}</span>
            <span class="text-[11px] font-mono font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded">
              เป้าหมาย ฿${targetFormatted}
            </span>
            <span class="text-[11px] font-medium text-slate-600 bg-slate-100 px-2 py-0.5 rounded">
              ระยะเวลา ${p.investment_period_years} ปี
            </span>
            <span class="text-[10px] text-slate-400">${dateStr}</span>
          </div>
          <div class="flex flex-wrap gap-1 pt-0.5">
            ${weightBadges}
          </div>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onclick="loadSavedPortfolioToDashboard('${p.id}')"
            class="px-2.5 py-1 text-xs font-semibold bg-slate-900 hover:bg-blue-700 text-white rounded-md transition"
          >
            ดึงพอร์ตมาแสดง
          </button>
          <button
            type="button"
            onclick="deleteUserPortfolio('${p.id}')"
            title="ลบพอร์ตนี้"
            class="p-1.5 text-slate-400 hover:text-rose-600 rounded-md hover:bg-rose-50 transition"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

async function openSupabaseConfigModal() {
  const modal = document.getElementById('supabase-config-modal');
  if (!modal) return;
  modal.classList.remove('hidden');

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
  if (!currentUser) return;
  const modal = document.getElementById('supabase-config-modal');
  if (modal) modal.classList.add('hidden');
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
