/**
 * ============================================================================
 * QuantFolio - ระบบยืนยันตัวตนจริง (Real Supabase Auth) และฐานข้อมูลจริง (Real Supabase DB)
 * เชื่อมต่อตรงกับโปรเจกต์: https://lxnmugciuddpqjhjwxoh.supabase.co
 * ============================================================================
 */

const SUPABASE_URL = 'https://lxnmugciuddpqjhjwxoh.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_BIzSoBWXPoDAkNCsJONajQ_keCu4r5D';

// ล้างค่าเก่าที่อาจค้างใน localStorage จากการทดสอบก่อนหน้า
localStorage.removeItem('qf_demo_user');
localStorage.removeItem('qf_demo_portfolios');
localStorage.setItem('qf_supabase_url', SUPABASE_URL);
localStorage.setItem('qf_supabase_anon_key', SUPABASE_ANON_KEY);

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let currentUser = null;
let savedPortfoliosList = [];

/**
 * ตรวจสอบสถานะการเปิดใช้งาน Google Provider บนเซิร์ฟเวอร์ Supabase จริง
 */
async function checkSupabaseAuthSettings() {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/settings`, {
      headers: {
        apikey: SUPABASE_ANON_KEY
      }
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
 * เริ่มต้นตรวจสอบ Session จริงจาก Supabase เมื่อเปิดหน้าเว็บ (รวมถึงตอน Redirect กลับมาจาก Google)
 */
async function initSupabaseAuth() {
  try {
    const { data: { session }, error } = await supabaseClient.auth.getSession();
    if (error) throw error;

    if (session && session.user) {
      currentUser = session.user;
      updateAuthUI(currentUser);
      await fetchUserPortfolios();
    } else {
      updateAuthUI(null);
      renderSavedPortfoliosList([]);
    }

    // ดักจับเมื่อ Login สำเร็จ หรือกด Logout
    supabaseClient.auth.onAuthStateChange(async (event, session) => {
      if (session && session.user) {
        currentUser = session.user;
        closeSupabaseConfigModal();
        updateAuthUI(currentUser);
        await fetchUserPortfolios();
        if (event === 'SIGNED_IN') {
          const meta = currentUser.user_metadata || {};
          const name = meta.full_name || meta.name || currentUser.email;
          showPortfolioToast(`เข้าสู่ระบบจริงสำเร็จในชื่อ ${name}`);
        }
      } else {
        currentUser = null;
        savedPortfoliosList = [];
        updateAuthUI(null);
        renderSavedPortfoliosList([]);
      }
    });
  } catch (err) {
    console.error('Supabase Auth Init Error:', err);
    updateAuthUI(null);
  }
}

/**
 * [Requirement 1] เมื่อผู้ใช้กดปุ่ม "Login with Google"
 * วิ่งไปหน้ายืนยันของ Google จริงทันที หากเปิด Google Provider บน Supabase แล้ว
 */
async function loginWithGoogle() {
  const status = await checkSupabaseAuthSettings();

  // หากในหน้าเว็บ Supabase เปิดสวิตช์ Google และกด Save แล้ว -> วิ่งไปหน้า Google ทันที!
  if (status.googleEnabled) {
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
      alert('เกิดข้อผิดพลาดในการเชื่อมต่อ Google OAuth: ' + error.message);
    }
    return;
  }

  // หากในหน้าเว็บ Supabase ยังไม่ได้ใส่ Client ID / กด Save ที่หน้า Google Provider
  openSupabaseConfigModal();
}

/**
 * บังคับวิ่งไปหน้า Google OAuth โดยตรง (สำหรับกดทดสอบหลังกด Save บน Supabase แล้ว)
 */
async function forceGoogleOAuthRedirect() {
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
    alert('ยังเข้าหน้า Google ไม่ได้ เนื่องจากบน Supabase ยังไม่ได้กด Save ค่า Client ID: ' + error.message);
  }
}

/**
 * เข้าสู่ระบบหรือสมัครสมาชิกจริงด้วยอีเมล Gmail ผ่านระบบ Supabase Auth จริง (auth.users)
 * ข้อมูลผู้ใช้และพอร์ตจะถูกบันทึกลงฐานข้อมูล Supabase จริง 100%
 */
async function loginOrSignUpWithRealGmail() {
  const nameInput = document.getElementById('real-auth-name');
  const emailInput = document.getElementById('real-auth-email');
  const passwordInput = document.getElementById('real-auth-password');
  const msgBox = document.getElementById('modal-diagnostic-alert');
  const submitBtn = document.getElementById('btn-real-email-auth');

  const fullName = (nameInput?.value || '').trim() || 'นักลงทุน QuantFolio';
  const email = (emailInput?.value || '').trim();
  const password = (passwordInput?.value || '').trim();

  if (!email || !email.includes('@')) {
    alert('กรุณากรอกอีเมล Gmail ของคุณให้ถูกต้อง');
    emailInput?.focus();
    return;
  }
  if (!password || password.length < 6) {
    alert('กรุณาตั้งรหัสผ่านอย่างน้อย 6 ตัวอักษร');
    passwordInput?.focus();
    return;
  }

  try {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerText = 'กำลังเชื่อมต่อ Supabase Auth จริง...';
    }

    // 1. ลองเข้าสู่ระบบก่อน (กรณีเคยสมัครไว้แล้ว)
    const signInRes = await supabaseClient.auth.signInWithPassword({
      email,
      password
    });

    if (!signInRes.error && signInRes.data?.session) {
      closeSupabaseConfigModal();
      return;
    }

    // 2. หากยังไม่มีบัญชี ให้สร้างบัญชีใหม่ใน auth.users ของ Supabase จริงทันที
    const avatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}&background=1d4ed8&color=fff&bold=true`;
    const signUpRes = await supabaseClient.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: window.location.origin + window.location.pathname,
        data: {
          full_name: fullName,
          name: fullName,
          avatar_url: avatarUrl
        }
      }
    });

    if (signUpRes.error) {
      throw signUpRes.error;
    }

    if (signUpRes.data?.session) {
      // เข้าสู่ระบบสำเร็จทันที!
      closeSupabaseConfigModal();
    } else if (signUpRes.data?.user) {
      // กรณี Supabase เปิด Confirm Email ไว้ ระบบจะส่งลิงก์ยืนยันไปที่ Gmail จริงของผู้ใช้
      if (msgBox) {
        msgBox.className = 'p-3 rounded-lg bg-emerald-50 border border-emerald-300 text-emerald-900 text-xs leading-relaxed';
        msgBox.innerHTML = `
          <b>✅ สร้างบัญชีผู้ใช้ใน Supabase จริงสำเร็จแล้ว!</b><br>
          ระบบได้ส่งอีเมลยืนยันไปที่ <b>${email}</b> แล้ว กรุณาเปิด Gmail ของคุณแล้วกดลิงก์ยืนยัน (หรือหากไม่ต้องการรอกดลิงก์ในอีเมล ให้ไปที่หน้า Supabase ➔ Authentication ➔ Providers ➔ Email ➔ ปิดสวิตช์ <b>Confirm email</b> แล้วกดปุ่มเข้าสู่ระบบอีกครั้งได้เลยครับ)
        `;
        msgBox.classList.remove('hidden');
      }
    }
  } catch (err) {
    if (msgBox) {
      msgBox.className = 'p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-xs leading-relaxed';
      msgBox.innerText = 'ไม่สามารถเข้าสู่ระบบได้: ' + err.message;
      msgBox.classList.remove('hidden');
    } else {
      alert('ไม่สามารถเข้าสู่ระบบได้: ' + err.message);
    }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerText = 'เข้าสู่ระบบ / สมัครใช้งานจริงด้วย Gmail นี้';
    }
  }
}

/**
 * ฟังก์ชันออกจากระบบ (Logout จริงจาก Supabase)
 */
async function logoutUser() {
  await supabaseClient.auth.signOut();
  currentUser = null;
  updateAuthUI(null);
  renderSavedPortfoliosList([]);
}

/**
 * [Requirement 2] อัปเดต UI แสดงชื่อ อีเมล และรูปโปรไฟล์ของผู้ใช้บน Dashboard
 */
function updateAuthUI(user) {
  const loggedOutBox = document.getElementById('auth-logged-out-box');
  const loggedInBox = document.getElementById('auth-logged-in-box');
  const userNameEl = document.getElementById('user-profile-name');
  const userEmailEl = document.getElementById('user-profile-email');
  const userAvatarEl = document.getElementById('user-profile-avatar');
  const savePanelBadge = document.getElementById('portfolio-storage-auth-badge');

  if (!user) {
    if (loggedOutBox) loggedOutBox.classList.remove('hidden');
    if (loggedInBox) loggedInBox.classList.add('hidden');
    if (savePanelBadge) {
      savePanelBadge.innerText = 'ยังไม่ได้เข้าสู่ระบบ';
      savePanelBadge.className = 'text-[10px] font-semibold px-2 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200';
    }
    return;
  }

  const meta = user.user_metadata || {};
  const displayName = meta.full_name || meta.name || (user.email ? user.email.split('@')[0] : 'นักลงทุน QuantFolio');
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
    savePanelBadge.innerText = `เชื่อมต่อบัญชีจริง: ${email}`;
    savePanelBadge.className = 'text-[10px] font-semibold px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200';
  }
}

/**
 * [Requirement 4 - Save Data] บันทึกข้อมูลพอร์ตลงตาราง user_portfolios บน Supabase จริง
 */
async function saveUserPortfolio() {
  if (!currentUser) {
    loginWithGoogle();
    return;
  }

  const nameInput = document.getElementById('save-portfolio-name');
  const targetInput = document.getElementById('save-target-amount');
  const yearsInput = document.getElementById('save-period-years');
  const saveBtn = document.getElementById('btn-save-portfolio');

  const portfolioName = (nameInput?.value || '').trim();
  const targetAmount = parseFloat(targetInput?.value) || (state?.optData?.metadata?.budget || 100000);
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

    const { data, error } = await supabaseClient
      .from('user_portfolios')
      .insert([payload])
      .select()
      .single();

    if (error) throw error;

    if (nameInput) nameInput.value = '';
    await fetchUserPortfolios();
    showPortfolioToast(`บันทึกพอร์ต "${portfolioName}" ลงตาราง user_portfolios บน Supabase สำเร็จ!`);
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
 * [Requirement 4 - Fetch Data] ดึงข้อมูลพอร์ตจากตาราง user_portfolios บน Supabase จริง
 */
async function fetchUserPortfolios() {
  if (!currentUser) {
    renderSavedPortfoliosList([]);
    return [];
  }

  try {
    const { data, error } = await supabaseClient
      .from('user_portfolios')
      .select('id, user_id, portfolio_name, target_amount, investment_period_years, asset_weights, strategy_key, created_at')
      .eq('user_id', currentUser.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    savedPortfoliosList = data || [];
    renderSavedPortfoliosList(savedPortfoliosList);
    return savedPortfoliosList;
  } catch (err) {
    console.error('Fetch portfolios error:', err);
    return [];
  }
}

/**
 * ลบพอร์ตออกจากตาราง user_portfolios บน Supabase จริง
 */
async function deleteUserPortfolio(portfolioId) {
  if (!currentUser) return;

  try {
    const { error } = await supabaseClient
      .from('user_portfolios')
      .delete()
      .eq('id', portfolioId)
      .eq('user_id', currentUser.id);

    if (error) throw error;
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
    const budgetEl = document.getElementById('budget-input');
    if (budgetEl) budgetEl.value = item.target_amount;
    const saveTargetEl = document.getElementById('save-target-amount');
    if (saveTargetEl) saveTargetEl.value = item.target_amount;
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
        กรุณากดปุ่ม <b>"Login with Google"</b> ด้านบนขวา เพื่อเข้าสู่ระบบและดึงข้อมูลพอร์ตของคุณจากฐานข้อมูล Supabase จริง
      </div>
    `;
    return;
  }

  if (portfolios.length === 0) {
    container.innerHTML = `
      <div class="p-4 text-center rounded-lg bg-slate-50 border border-dashed border-slate-300 text-xs text-slate-500">
        คุณเข้าสู่ระบบจริงเรียบร้อยแล้ว! ลองพิมพ์ชื่อพอร์ต (เช่น "พอร์ตเงินเกษียณ") แล้วกดปุ่ม <b>"บันทึกพอร์ตนี้"</b> ข้อมูลจะถูกบันทึกลงตาราง <code>user_portfolios</code> บน Supabase ทันทีครับ
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
    statusBadge.innerText = 'กำลังตรวจสอบสถานะบน Supabase...';
    const st = await checkSupabaseAuthSettings();
    if (st.googleEnabled) {
      statusBadge.innerText = '✅ เปิดใช้งาน Google OAuth บน Supabase แล้ว (พร้อมใช้งาน)';
      statusBadge.className = 'text-[11px] font-semibold px-2.5 py-1 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 inline-block';
    } else {
      statusBadge.innerText = '⚠️ Google OAuth บน Supabase ยังรอใส่ Client ID (แต่ใช้ Gmail Login จริงด้านล่างได้ทันที)';
      statusBadge.className = 'text-[11px] font-semibold px-2.5 py-1 rounded bg-amber-50 text-amber-800 border border-amber-200 inline-block';
    }
  }
}

function closeSupabaseConfigModal() {
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
