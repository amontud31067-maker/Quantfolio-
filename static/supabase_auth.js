/**
 * ============================================================================
 * QuantFolio - ระบบยืนยันตัวตน (Authentication) และจัดการพอร์ตการลงทุน (Cloud Vault)
 * Single Source of Truth ผ่าน Backend API (/api/auth/*, /api/portfolios) -> Supabase PostgreSQL
 * - เก็บเฉพาะ Session Token (qf_verified_session_token) ใน localStorage สำหรับผู้ใช้ที่ล็อกอิน
 * - ห้ามเก็บบัญชีหรือพอร์ตของผู้ใช้ที่ล็อกอินไว้แค่ใน localStorage (คง localStorage เฉพาะโหมด Guest ก่อนล็อกอิน)
 * - บังคับ Normalize อีเมลด้วย .trim().toLowerCase() ทุกจุด
 * ============================================================================
 */

// Clean up any legacy demo or client-side Supabase keys from older builds
try {
  localStorage.removeItem('qf_demo_user');
  localStorage.removeItem('qf_supabase_url');
  localStorage.removeItem('qf_supabase_anon_key');
  localStorage.removeItem('qf_verified_session_user');
} catch (e) {}

let currentUser = null;
let savedPortfoliosList = [];
let editingSavedPortfolioId = null;
let authTabMode = 'signin'; // 'signin' | 'signup'
const GUEST_PORTFOLIOS_STORAGE_KEY = 'quantfolio_portfolios_guest_v1';

function normalizeEmailInput(raw) {
  return String(raw || '').trim().toLowerCase();
}

function readLocalPortfoliosList(storageKey) {
  try {
    const arr = JSON.parse(localStorage.getItem(storageKey) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function writeLocalPortfoliosList(storageKey, arr) {
  try {
    localStorage.setItem(storageKey, JSON.stringify((arr || []).slice(0, 50)));
  } catch (e) {
    console.warn('Local portfolio write notice:', e);
  }
}

function syncEditingPortfolioBannerUI() {
  const banner = document.getElementById('editing-saved-portfolio-banner');
  const titleEl = document.getElementById('editing-saved-portfolio-title');
  const saveBtn = document.getElementById('btn-save-portfolio');
  const item = editingSavedPortfolioId
    ? savedPortfoliosList.find(p => String(p.id) === String(editingSavedPortfolioId))
    : null;

  if (!item) {
    editingSavedPortfolioId = null;
    if (banner) banner.classList.add('hidden');
    if (saveBtn) {
      saveBtn.innerHTML = `<i data-lucide="bookmark-plus" class="w-4 h-4"></i><span>บันทึกพอร์ตนี้</span>`;
      if (window.lucide) lucide.createIcons();
    }
    return;
  }

  if (titleEl) titleEl.innerText = item.portfolio_name || 'พอร์ตที่บันทึกไว้';
  if (banner) banner.classList.remove('hidden');
  if (saveBtn) {
    saveBtn.innerHTML = `<i data-lucide="save" class="w-4 h-4"></i><span>อัปเดตพอร์ตนี้</span>`;
    if (window.lucide) lucide.createIcons();
  }
}

function cancelEditingSavedPortfolio() {
  editingSavedPortfolioId = null;
  syncEditingPortfolioBannerUI();
}

async function migrateGuestPortfoliosToAuthenticatedUser() {
  if (!currentUser || !currentUser.id) return;
  const guestArr = readLocalPortfoliosList(GUEST_PORTFOLIOS_STORAGE_KEY);
  if (guestArr.length === 0) return;

  let migratedCount = 0;
  const remainingGuest = [];
  for (const item of guestArr) {
    if (!item || !item.portfolio_name) continue;
    const { id: _discardLocalId, ...cleanGuestFields } = item;
    const migratedRecord = {
      ...cleanGuestFields,
      storage_origin: 'cloud',
      updated_at: new Date().toISOString()
    };
    try {
      const res = await fetch('/api/portfolios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getBackendAuthHeaders() },
        body: JSON.stringify(migratedRecord)
      });
      if (res.ok) {
        migratedCount++;
        continue;
      }
    } catch (e) {
      // Keep unmigrated draft in guest bucket so user never silently loses unsynced draft
    }
    remainingGuest.push(item);
  }

  if (remainingGuest.length === 0) {
    localStorage.removeItem(GUEST_PORTFOLIOS_STORAGE_KEY);
  } else {
    writeLocalPortfoliosList(GUEST_PORTFOLIOS_STORAGE_KEY, remainingGuest);
  }
  if (migratedCount > 0) {
    showPortfolioToast(`ซิงก์พอร์ตจากโหมด Guest ขึ้น Cloud เรียบร้อยแล้ว (${migratedCount} พอร์ต)`);
  }
}

/**
 * สลับแท็บระหว่าง "เข้าสู่ระบบ (Sign In)" และ "สมัครสมาชิกใหม่ (Sign Up)"
 */
function switchAuthTab(mode) {
  authTabMode = mode === 'signup' ? 'signup' : 'signin';
  const signInTab = document.getElementById('auth-tab-signin');
  const signUpTab = document.getElementById('auth-tab-signup');
  const nameWrap = document.getElementById('real-auth-name-wrap');
  const pwStrengthWrap = document.getElementById('auth-password-strength-wrap');
  const pwConfirmWrap = document.getElementById('real-auth-password-confirm-wrap');
  const rememberWrap = document.getElementById('auth-remember-email-wrap');
  const passwordInput = document.getElementById('real-auth-password');
  const submitBtn = document.getElementById('btn-real-email-auth');
  const msgBox = document.getElementById('modal-diagnostic-alert');

  if (msgBox) msgBox.classList.add('hidden');

  if (authTabMode === 'signup') {
    if (signUpTab) {
      signUpTab.classList.add('active', 'font-bold');
      signUpTab.classList.remove('font-semibold');
      signUpTab.setAttribute('aria-selected', 'true');
    }
    if (signInTab) {
      signInTab.classList.remove('active', 'font-bold');
      signInTab.classList.add('font-semibold');
      signInTab.setAttribute('aria-selected', 'false');
    }
    if (nameWrap) nameWrap.classList.remove('hidden');
    if (pwStrengthWrap) pwStrengthWrap.classList.remove('hidden');
    if (pwConfirmWrap) pwConfirmWrap.classList.remove('hidden');
    if (rememberWrap) rememberWrap.classList.add('hidden');
    if (passwordInput) passwordInput.setAttribute('autocomplete', 'new-password');
    if (submitBtn) submitBtn.innerText = 'สมัครสมาชิกและเข้าใช้งาน';
    updateAuthPasswordStrength();
  } else {
    if (signInTab) {
      signInTab.classList.add('active', 'font-bold');
      signInTab.classList.remove('font-semibold');
      signInTab.setAttribute('aria-selected', 'true');
    }
    if (signUpTab) {
      signUpTab.classList.remove('active', 'font-bold');
      signUpTab.classList.add('font-semibold');
      signUpTab.setAttribute('aria-selected', 'false');
    }
    if (nameWrap) nameWrap.classList.add('hidden');
    if (pwStrengthWrap) pwStrengthWrap.classList.add('hidden');
    if (pwConfirmWrap) pwConfirmWrap.classList.add('hidden');
    if (rememberWrap) rememberWrap.classList.remove('hidden');
    if (passwordInput) passwordInput.setAttribute('autocomplete', 'current-password');
    if (submitBtn) submitBtn.innerText = 'เข้าสู่ระบบเพื่อใช้งาน';
  }
}

/**
 * สลับการแสดง/ซ่อนรหัสผ่านในช่อง input พร้อมเปลี่ยนไอคอน eye / eye-off
 */
function toggleAuthPasswordVisibility(inputId, btnEl) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const isHidden = input.type === 'password';
  input.type = isHidden ? 'text' : 'password';
  if (btnEl) {
    const iconName = isHidden ? 'eye-off' : 'eye';
    const sizeCls = inputId.startsWith('acct-') ? 'w-3.5 h-3.5' : 'w-4 h-4';
    btnEl.innerHTML = `<i data-lucide="${iconName}" class="${sizeCls}"></i>`;
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  }
}

/**
 * แสดงแถบวัดความแข็งแรงรหัสผ่านแบบเรียลไทม์สำหรับแท็บสมัครสมาชิก
 */
function updateAuthPasswordStrength() {
  const pwInput = document.getElementById('real-auth-password');
  const labelEl = document.getElementById('auth-password-strength-label');
  const bars = [1, 2, 3, 4].map(i => document.getElementById(`auth-pw-bar-${i}`));
  if (!pwInput || !labelEl || bars.some(b => !b)) return;

  const pw = pwInput.value || '';
  let level = 0;
  let barColor = 'bg-slate-200';
  let labelText = 'อย่างน้อย 8 ตัวอักษร';
  let labelClass = 'font-semibold text-slate-500';

  if (pw.length > 0 && pw.length < 8) {
    level = 1;
    barColor = 'bg-rose-500';
    labelText = 'สั้นเกินไป (ต้องอย่างน้อย 8 ตัวอักษร)';
    labelClass = 'font-semibold text-rose-600';
  } else if (pw.length >= 8) {
    const hasLetter = /[A-Za-z\u0E00-\u0E7F]/.test(pw);
    const hasDigit = /\d/.test(pw);
    const hasUpperLower = /[A-Z]/.test(pw) && /[a-z]/.test(pw);
    const hasSymbol = /[^A-Za-z0-9\u0E00-\u0E7F]/.test(pw);

    level = 2;
    barColor = 'bg-amber-500';
    labelText = 'พอใช้ — แนะนำเพิ่มตัวเลขหรือตัวพิมพ์ใหญ่';
    labelClass = 'font-semibold text-amber-600';

    if (hasLetter && hasDigit) {
      level = 3;
      barColor = 'bg-sky-500';
      labelText = 'ดี — เหมาะสมสำหรับใช้งานทั่วไป';
      labelClass = 'font-semibold text-sky-600';
    }
    if (pw.length >= 10 && hasLetter && hasDigit && (hasUpperLower || hasSymbol)) {
      level = 4;
      barColor = 'bg-[#00D084]';
      labelText = 'แข็งแรงมาก';
      labelClass = 'font-semibold text-emerald-600';
    }
  }

  bars.forEach((bar, idx) => {
    bar.className = `rounded-full transition-colors ${idx < level ? barColor : 'bg-slate-200'}`;
  });
  labelEl.innerText = labelText;
  labelEl.className = labelClass;
}

/**
 * สถานะผู้ให้บริการล็อกอิน (Single Source of Truth ผ่าน Backend API -> Supabase PostgreSQL)
 */
async function checkSupabaseAuthSettings() {
  return { ok: true, googleEnabled: false, emailEnabled: true, autoconfirm: true };
}

/**
 * โหลดและตรวจสอบ Session ของผู้ใช้เมื่อเปิดหน้าเว็บผ่าน GET /api/auth/me เท่านั้น
 * (ใช้ localStorage เก็บเฉพาะ Session Token ไม่เชื่อข้อมูลบัญชีเก่าที่แคชไว้ในเครื่อง)
 */
async function initSupabaseAuth() {
  try {
    localStorage.removeItem('qf_verified_session_user');
    const savedToken = (localStorage.getItem('qf_verified_session_token') || '').trim();
    if (savedToken) {
      const initHeaders = { 'Authorization': `Bearer ${savedToken}` };
      const activePreview = getAdminPreviewTier();
      if (activePreview) initHeaders['X-QF-Admin-Preview-Tier'] = activePreview;
      try {
        const meRes = await fetch('/api/auth/me', { headers: initHeaders });
        if (meRes.ok) {
          const meData = await meRes.json();
          if (meData && meData.user) {
            currentUser = { ...meData.user, token: savedToken };
            updateAuthUI(currentUser);
            await fetchUserPortfolios();
            return;
          }
        }
        // Invalid/expired token or unverified session -> clear token cleanly & revert to Guest
        if (meRes.status === 401 || meRes.status === 403) {
          localStorage.removeItem('qf_verified_session_token');
          sessionStorage.removeItem('qf_admin_preview_tier');
        }
      } catch (netErr) {
        console.warn('Session verify notice:', netErr);
      }
    }

    currentUser = null;
    updateAuthUI(null);
    await fetchUserPortfolios();
  } catch (err) {
    console.error('Auth Init Error:', err);
    currentUser = null;
    updateAuthUI(null);
  }
}

/**
 * เมื่อกดปุ่ม Login with Google (แจ้งให้เข้าสู่ระบบด้วยอีเมลและรหัสผ่าน)
 */
async function loginWithGoogle() {
  openSupabaseConfigModal('signin');
  showAuthAlert('กรุณากรอกอีเมลและรหัสผ่านด้านบนเพื่อเข้าสู่ระบบและซิงก์บัญชีบน Cloud ทันที', 'info');
  const emailInput = document.getElementById('real-auth-email');
  if (emailInput) emailInput.focus();
}

async function forceGoogleOAuthRedirect() {
  await loginWithGoogle();
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
 * เข้าสู่ระบบหรือสมัครสมาชิกด้วยอีเมลและรหัสผ่านผ่าน Backend Auth API -> Supabase PostgreSQL
 */
async function loginOrSignUpWithRealGmail() {
  const nameInput = document.getElementById('real-auth-name');
  const emailInput = document.getElementById('real-auth-email');
  const passwordInput = document.getElementById('real-auth-password');
  const confirmInput = document.getElementById('real-auth-password-confirm');
  const rememberCheckbox = document.getElementById('auth-remember-email');
  const msgBox = document.getElementById('modal-diagnostic-alert');
  const submitBtn = document.getElementById('btn-real-email-auth');

  const email = normalizeEmailInput(emailInput?.value);
  if (emailInput && email) emailInput.value = email;
  const password = (passwordInput?.value || '').trim();
  const confirmPassword = (confirmInput?.value || '').trim();
  const fullName = (nameInput?.value || '').trim() || (email ? email.split('@')[0] : 'ผู้ใช้งาน QuantFolio');
  const payloadFullName = authTabMode === 'signup' ? fullName : '';

  if (msgBox) msgBox.classList.add('hidden');

  if (!email || !email.includes('@')) {
    showAuthAlert('กรุณากรอกอีเมลของคุณให้ถูกต้อง เช่น yourname@gmail.com', 'error');
    emailInput?.focus();
    return;
  }
  if (!password || password.length < 8) {
    showAuthAlert('กรุณากรอกรหัสผ่านอย่างน้อย 8 ตัวอักษร', 'error');
    passwordInput?.focus();
    return;
  }
  if (authTabMode === 'signup' && confirmInput && confirmPassword !== password) {
    showAuthAlert('กรุณายืนยันรหัสผ่านให้ตรงกันทั้งสองช่อง', 'error');
    confirmInput.focus();
    return;
  }

  // บันทึกหรือล้างอีเมลที่จำไว้ในเครื่อง (เฉพาะอีเมลที่ Normalize เป็นตัวพิมพ์เล็กแล้ว)
  try {
    if (!rememberCheckbox || rememberCheckbox.checked) {
      localStorage.setItem('qf_remembered_email', email);
    } else {
      localStorage.removeItem('qf_remembered_email');
    }
  } catch (e) {}

  try {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerText = authTabMode === 'signup' ? 'กำลังสร้างบัญชีผู้ใช้...' : 'กำลังตรวจสอบและเข้าสู่ระบบ...';
    }

    const backendRes = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        full_name: payloadFullName,
        mode: authTabMode
      })
    });

    const backendData = await backendRes.json().catch(() => ({}));
    if (!backendRes.ok) {
      throw new Error(backendData.detail || 'ไม่สามารถเข้าสู่ระบบได้ กรุณาตรวจสอบอีเมลและรหัสผ่าน');
    }

    currentUser = backendData.user;
    if (backendData.token) {
      currentUser.token = backendData.token;
      localStorage.setItem('qf_verified_session_token', backendData.token);
    }
    localStorage.removeItem('qf_verified_session_user');
    clearAllAuthPasswordInputs();
    updateAuthUI(currentUser);
    await migrateGuestPortfoliosToAuthenticatedUser();
    await fetchUserPortfolios();

    const displayName = currentUser.user_metadata?.full_name || currentUser.email;
    showPortfolioToast(
      authTabMode === 'signup'
        ? `สมัครสมาชิกและเข้าสู่ระบบสำเร็จในชื่อ ${displayName}`
        : `เข้าสู่ระบบสำเร็จในชื่อ ${displayName}`
    );
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
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="#00A86B"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" fill="#ffffff" font-family="sans-serif" font-size="24" font-weight="bold">${initials}</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

function sanitizeHttpsOnlyUrl(raw) {
  const s = String(raw || '').trim();
  if (/^https:\/\/[^\s"'<>]+$/i.test(s)) {
    return s;
  }
  return null;
}

function getAdminPreviewTier() {
  try {
    const val = String(sessionStorage.getItem('qf_admin_preview_tier') || '').trim().toLowerCase();
    return ['guest', 'free', 'pro', 'advisor'].includes(val) ? val : null;
  } catch (e) {
    return null;
  }
}

function getBackendAuthHeaders() {
  const token = (currentUser && currentUser.token) || localStorage.getItem('qf_verified_session_token') || '';
  const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
  const previewTier = getAdminPreviewTier();
  if (token && previewTier) {
    headers['X-QF-Admin-Preview-Tier'] = previewTier;
  }
  return headers;
}

/**
 * เปิด/ปิดเมนู Dropdown บัญชีผู้ใช้บน Header
 */
function toggleHeaderAccountMenu(forceOpen) {
  const menu = document.getElementById('header-account-menu');
  const btn = document.getElementById('header-account-menu-btn');
  if (!menu) return;
  const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : menu.classList.contains('hidden');
  if (shouldOpen && typeof toggleHeaderUtilityMenu === 'function') {
    toggleHeaderUtilityMenu(false);
  }
  menu.classList.toggle('hidden', !shouldOpen);
  if (btn) btn.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
  if (shouldOpen && window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}

function clearAllAuthPasswordInputs() {
  [
    'real-auth-password',
    'real-auth-password-confirm',
    'auth-password',
    'acct-curr-password',
    'acct-new-password',
    'acct-new-password-confirm'
  ].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.value = '';
      el.type = 'password';
    }
  });
  if (typeof updateAuthPasswordStrength === 'function') {
    updateAuthPasswordStrength();
  }
}

/**
 * หน้าต่างจัดการโปรไฟล์และเปลี่ยนรหัสผ่าน (#account-settings-modal)
 */
function openAccountSettingsModal() {
  if (!currentUser) {
    openSupabaseConfigModal('signin');
    return;
  }
  const modal = document.getElementById('account-settings-modal');
  if (!modal) return;

  const meta = currentUser.user_metadata || {};
  const displayName = meta.full_name || meta.name || (currentUser.email ? currentUser.email.split('@')[0] : 'ผู้ใช้งาน QuantFolio');
  const rawAvatar = meta.avatar_url || meta.picture || '';
  const avatarUrl = (rawAvatar && !String(rawAvatar).includes('ui-avatars.com')) ? rawAvatar : buildLocalAvatarSvg(displayName);

  const avatarEl = document.getElementById('acct-modal-avatar');
  const emailEl = document.getElementById('acct-modal-email');
  const nameInput = document.getElementById('acct-edit-name-input');
  const alertBox = document.getElementById('acct-settings-alert');

  if (avatarEl) {
    avatarEl.src = avatarUrl;
    avatarEl.alt = displayName;
  }
  if (emailEl) emailEl.innerText = currentUser.email || '--';
  if (nameInput) nameInput.value = displayName;
  if (alertBox) alertBox.classList.add('hidden');
  syncMembershipTierBadgesUI();

  clearAllAuthPasswordInputs();

  modal.classList.remove('hidden');
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}

function closeAccountSettingsModal() {
  clearAllAuthPasswordInputs();
  const modal = document.getElementById('account-settings-modal');
  if (modal) modal.classList.add('hidden');
}

function showAccountSettingsAlert(message, type = 'info') {
  const box = document.getElementById('acct-settings-alert');
  if (!box) return;
  if (type === 'error') {
    box.className = 'p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs leading-relaxed';
  } else if (type === 'success') {
    box.className = 'p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs leading-relaxed';
  } else {
    box.className = 'p-3 rounded-xl bg-blue-50 border border-blue-200 text-blue-900 text-xs leading-relaxed';
  }
  box.innerText = message;
  box.classList.remove('hidden');
}

async function updateUserProfileName() {
  if (!currentUser) return;
  const input = document.getElementById('acct-edit-name-input');
  const btn = document.getElementById('btn-save-profile-name');
  const newName = (input?.value || '').trim();

  if (!newName || newName.length > 80) {
    showAccountSettingsAlert('กรุณากรอกชื่อที่ใช้แสดงผลระหว่าง 1–80 ตัวอักษร', 'error');
    input?.focus();
    return;
  }

  try {
    if (btn) {
      btn.disabled = true;
      btn.innerText = 'กำลังบันทึก...';
    }
    let updatedAvatar = buildLocalAvatarSvg(newName);

    const headers = getBackendAuthHeaders();
    if (!headers.Authorization) {
      throw new Error('กรุณาเข้าสู่ระบบใหม่อีกครั้ง');
    }
    const res = await fetch('/api/auth/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ full_name: newName })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.detail || 'ไม่สามารถบันทึกชื่อโปรไฟล์ได้');
    }
    if (data.user && data.user.user_metadata) {
      updatedAvatar = data.user.user_metadata.avatar_url || updatedAvatar;
    }

    currentUser = {
      ...currentUser,
      ...(data.user || {}),
      token: currentUser.token || localStorage.getItem('qf_verified_session_token') || '',
      user_metadata: {
        ...(currentUser.user_metadata || {}),
        ...(data.user?.user_metadata || {}),
        full_name: newName,
        name: newName,
        avatar_url: updatedAvatar
      }
    };
    updateAuthUI(currentUser);

    const modalAvatar = document.getElementById('acct-modal-avatar');
    if (modalAvatar) modalAvatar.src = updatedAvatar;

    showAccountSettingsAlert('อัปเดตชื่อโปรไฟล์เรียบร้อยแล้ว', 'success');
    showPortfolioToast(`อัปเดตชื่อโปรไฟล์เป็น "${newName}" เรียบร้อยแล้ว`);
  } catch (err) {
    showAccountSettingsAlert(err.message || 'ไม่สามารถอัปเดตชื่อโปรไฟล์ได้', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = 'บันทึกชื่อ';
    }
  }
}

async function changeUserPassword() {
  if (!currentUser) return;
  const currEl = document.getElementById('acct-curr-password');
  const newEl = document.getElementById('acct-new-password');
  const confirmEl = document.getElementById('acct-new-password-confirm');
  const btn = document.getElementById('btn-change-password');

  const currentPassword = (currEl?.value || '').trim();
  const newPassword = (newEl?.value || '').trim();
  const confirmPassword = (confirmEl?.value || '').trim();

  if (!currentPassword) {
    showAccountSettingsAlert('กรุณากรอกรหัสผ่านปัจจุบัน', 'error');
    currEl?.focus();
    return;
  }
  if (!newPassword || newPassword.length < 8) {
    showAccountSettingsAlert('รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร', 'error');
    newEl?.focus();
    return;
  }
  if (newPassword !== confirmPassword) {
    showAccountSettingsAlert('ยืนยันรหัสผ่านใหม่ไม่ตรงกัน กรุณาตรวจสอบอีกครั้ง', 'error');
    confirmEl?.focus();
    return;
  }
  if (currentPassword === newPassword) {
    showAccountSettingsAlert('รหัสผ่านใหม่ต้องแตกต่างจากรหัสผ่านปัจจุบัน', 'error');
    newEl?.focus();
    return;
  }

  try {
    if (btn) {
      btn.disabled = true;
      btn.innerText = 'กำลังอัปเดตรหัสผ่าน...';
    }

    const headers = getBackendAuthHeaders();
    if (!headers.Authorization) {
      throw new Error('กรุณาเข้าสู่ระบบใหม่อีกครั้ง');
    }
    const res = await fetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        current_password: currentPassword,
        new_password: newPassword
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.detail || 'ไม่สามารถเปลี่ยนรหัสผ่านได้');
    }
    if (data.token) {
      currentUser.token = data.token;
      localStorage.setItem('qf_verified_session_token', data.token);
    }

    clearAllAuthPasswordInputs();
    showAccountSettingsAlert('เปลี่ยนรหัสผ่านใหม่เรียบร้อยแล้ว (อัปเดตสิทธิ์การเข้าถึงทันที)', 'success');
    showPortfolioToast('เปลี่ยนรหัสผ่านเรียบร้อยแล้ว');
  } catch (err) {
    showAccountSettingsAlert(err.message || 'ไม่สามารถเปลี่ยนรหัสผ่านได้', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = 'อัปเดตรหัสผ่านใหม่';
    }
  }
}

/**
 * หน้าต่างยืนยันการลบบัญชีถาวร (PDPA) แบบปลอดภัย — ต้องพิมพ์อีเมลให้ตรงกันก่อนกดลบ
 */
function openDeleteAccountModal() {
  if (!currentUser) return;
  const modal = document.getElementById('delete-account-confirm-modal');
  const emailLabel = document.getElementById('delete-account-target-email');
  const input = document.getElementById('delete-account-email-confirm');
  const btn = document.getElementById('btn-confirm-delete-account');
  if (!modal) return;

  if (emailLabel) emailLabel.innerText = currentUser.email || '--';
  if (input) input.value = '';
  if (btn) btn.disabled = true;

  modal.classList.remove('hidden');
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
  setTimeout(() => input?.focus(), 60);
}

function closeDeleteAccountModal() {
  const modal = document.getElementById('delete-account-confirm-modal');
  if (modal) modal.classList.add('hidden');
}

function validateDeleteAccountConfirmInput() {
  const input = document.getElementById('delete-account-email-confirm');
  const btn = document.getElementById('btn-confirm-delete-account');
  if (!input || !btn || !currentUser) return false;
  const typed = (input.value || '').trim().toLowerCase();
  const target = String(currentUser.email || '').trim().toLowerCase();
  const isMatch = Boolean(target && typed === target);
  btn.disabled = !isMatch;
  return isMatch;
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
  showPortfolioToast('เข้าสู่โหมดทดลองใช้งาน (สูงสุด 5 สินทรัพย์ • สมัครฟรีเพื่อปลดล็อกข่าวตลาดและดาวน์โหลด PDF)');
}

/**
 * ออกจากระบบ (Logout) และล้างแคชเฉพาะของบัญชีที่ออก เพื่อความปลอดภัยโดยไม่ลบพอร์ตโหมด Guest
 */
async function logoutUser(opts = {}) {
  const prevUserId = currentUser?.id || null;
  localStorage.removeItem('qf_verified_session_user');
  localStorage.removeItem('qf_verified_session_token');
  try {
    if (prevUserId) {
      localStorage.removeItem(`quantfolio_portfolios_${prevUserId}`);
    }
  } catch (e) {}

  sessionStorage.removeItem('qf_guest_mode');
  sessionStorage.removeItem('qf_admin_preview_tier');
  currentUser = null;
  editingSavedPortfolioId = null;
  savedPortfoliosList = [];

  // P0-4 Security Hygiene: Clear ALL password inputs from DOM upon logout so shared devices never retain credentials
  clearAllAuthPasswordInputs();
  // P0-5: Immediately unmount any dynamically injected Admin DOM on logout
  if (typeof syncAdminDynamicDom === 'function') {
    syncAdminDynamicDom(false);
  }

  toggleHeaderAccountMenu(false);
  closeAccountSettingsModal();
  closeDeleteAccountModal();
  updateAuthUI(null);
  await fetchUserPortfolios();

  if (!opts || !opts.silent) {
    showPortfolioToast('ออกจากระบบเรียบร้อยแล้ว');
  }
}

/**
 * ลบบัญชีผู้ใช้งานและข้อมูลพอร์ตทั้งหมดออกจากระบบ (PDPA Right to Erasure)
 */
async function deleteUserAccount() {
  if (!currentUser) return;
  const confirmModal = document.getElementById('delete-account-confirm-modal');
  const confirmInput = document.getElementById('delete-account-email-confirm');
  const deleteBtn = document.getElementById('btn-confirm-delete-account');

  // หากเรียกผ่าน Modal ให้ตรวจยืนยันว่าพิมพ์อีเมลตรงกันแล้วจริงๆ
  if (confirmModal && !confirmModal.classList.contains('hidden')) {
    if (!validateDeleteAccountConfirmInput()) {
      confirmInput?.focus();
      return;
    }
  } else if (confirmModal) {
    openDeleteAccountModal();
    return;
  }

  try {
    if (deleteBtn) {
      deleteBtn.disabled = true;
      deleteBtn.innerText = 'กำลังลบบัญชี...';
    }

    const backendHeaders = getBackendAuthHeaders();
    if (!backendHeaders.Authorization) {
      throw new Error('กรุณาเข้าสู่ระบบใหม่อีกครั้งก่อนลบบัญชี');
    }
    const res = await fetch('/api/auth/account', {
      method: 'DELETE',
      headers: backendHeaders
    });
    if (!res.ok && res.status !== 401) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.detail || 'ไม่สามารถลบบัญชีได้ในขณะนี้');
    }

    closeDeleteAccountModal();
    await logoutUser({ silent: true });
    showPortfolioToast('ลบบัญชีผู้ใช้งานและข้อมูลพอร์ตทั้งหมดเรียบร้อยแล้ว');
  } catch (err) {
    alert('เกิดข้อผิดพลาดในการลบบัญชี: ' + err.message);
  } finally {
    if (deleteBtn) {
      deleteBtn.innerText = 'ยืนยันลบบัญชีถาวร';
    }
  }
}

/**
 * อัปเดตสถานะการล็อกหน้าจอและข้อมูลโปรไฟล์บนแถบด้านบน + เมนูบัญชีผู้ใช้
 */
function updateAuthUI(user) {
  window.currentUser = user || null;
  const modal = document.getElementById('supabase-config-modal');
  const mainWorkspace = document.getElementById('main-app-workspace');
  const loggedOutBox = document.getElementById('auth-logged-out-box');
  const loggedInBox = document.getElementById('auth-logged-in-box');
  const userNameEl = document.getElementById('user-profile-name');
  const userEmailEl = document.getElementById('user-profile-email');
  const userAvatarEl = document.getElementById('user-profile-avatar');
  const accountMenuNameEl = document.getElementById('account-menu-name');
  const accountMenuAvatarEl = document.getElementById('account-menu-avatar');
  const savePanelBadge = document.getElementById('portfolio-storage-auth-badge');
  const v2UserNameEl = document.getElementById('v2-user-name');
  const v2UserAvatarEl = document.getElementById('v2-user-avatar');
  const settingsNameEl = document.getElementById('settings-user-name');
  const settingsEmailEl = document.getElementById('settings-user-email');
  const settingsAvatarEl = document.getElementById('settings-user-avatar');
  const settingsLogoutBtn = document.getElementById('btn-settings-logout');

  if (!user) {
    if (modal) modal.classList.add('hidden');
    document.body.style.overflow = '';
    if (mainWorkspace) {
      mainWorkspace.classList.remove('pointer-events-none', 'select-none', 'blur-xs');
    }

    toggleHeaderAccountMenu(false);
    if (loggedOutBox) loggedOutBox.classList.remove('hidden');
    if (loggedInBox) loggedInBox.classList.add('hidden');
    if (userEmailEl) userEmailEl.innerText = '';
    if (accountMenuNameEl) accountMenuNameEl.innerText = '';
    if (savePanelBadge) {
      savePanelBadge.innerText = 'บันทึกในเครื่องได้ทันที (โหมด Guest)';
      savePanelBadge.className = 'text-xs font-semibold px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 self-start sm:self-center shrink-0';
    }
    const defaultAvatar = buildLocalAvatarSvg('QF');
    if (v2UserNameEl) v2UserNameEl.innerText = 'Guest Investor';
    if (v2UserAvatarEl) v2UserAvatarEl.src = defaultAvatar;
    if (settingsNameEl) settingsNameEl.innerText = 'Guest Investor';
    if (settingsEmailEl) settingsEmailEl.innerText = 'โหมดทดลองใช้งาน (ยังไม่ได้เข้าสู่ระบบ)';
    if (settingsAvatarEl) settingsAvatarEl.src = defaultAvatar;
    if (settingsLogoutBtn) settingsLogoutBtn.classList.add('hidden');
    syncMembershipTierBadgesUI();
    if (typeof renderDashboardV2 === 'function') renderDashboardV2();
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
  if (accountMenuNameEl) accountMenuNameEl.innerText = displayName;
  if (accountMenuAvatarEl) {
    accountMenuAvatarEl.src = avatarUrl;
    accountMenuAvatarEl.alt = displayName;
  }
  if (v2UserNameEl) v2UserNameEl.innerText = displayName;
  if (v2UserAvatarEl) {
    v2UserAvatarEl.src = avatarUrl;
    v2UserAvatarEl.alt = displayName;
  }
  if (settingsNameEl) settingsNameEl.innerText = displayName;
  if (settingsEmailEl) settingsEmailEl.innerText = email;
  if (settingsAvatarEl) {
    settingsAvatarEl.src = avatarUrl;
    settingsAvatarEl.alt = displayName;
  }
  if (settingsLogoutBtn) settingsLogoutBtn.classList.remove('hidden');

  if (loggedOutBox) loggedOutBox.classList.add('hidden');
  if (loggedInBox) loggedInBox.classList.remove('hidden');

  if ( savePanelBadge) {
    savePanelBadge.innerText = `บัญชีที่ใช้งาน: ${email}`;
    savePanelBadge.className = 'text-[10px] font-semibold px-2.5 py-1 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 self-start sm:self-center shrink-0';
  }
  syncMembershipTierBadgesUI();
  if (typeof renderDashboardV2 === 'function') renderDashboardV2();
}

/**
 * บันทึกหรืออัปเดตข้อมูลพอร์ตการลงทุน (รองรับทั้งโหมด Guest ในเครื่อง และ Cloud Sync เมื่อล็อกอิน)
 */
async function saveUserPortfolio(saveMode = 'auto') {
  const nameInput = document.getElementById('save-portfolio-name');
  const catInput = document.getElementById('save-goal-category');
  const targetInput = document.getElementById('save-target-amount');
  const dcaInput = document.getElementById('save-monthly-dca');
  const yearsInput = document.getElementById('save-period-years');
  const goalInitBudgetInput = document.getElementById('save-initial-budget');
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
  const monthlyDca = Math.max(0, parseFloat(rawDcaStr) || 0);
  const rawBudgetStr = String(goalInitBudgetInput?.value || budgetInput?.value || '').replace(/,/g, '').trim();
  const initialBudget = parseFloat(rawBudgetStr) || (window.state?.optData?.metadata?.budget || 100000);
  const investmentPeriodYears = Math.max(1, Math.min(50, parseInt(yearsInput?.value, 10) || 5));

  if (!portfolioName) {
    alert('กรุณาตั้งชื่อพอร์ตหรือเป้าหมายการลงทุน เช่น "พอร์ตเงินเกษียณ"');
    nameInput?.focus();
    return;
  }

  const appState = window.state || (typeof state !== 'undefined' ? state : null);
  const assetWeightsJson = {};
  let activeStrategyKey = 'max_sharpe';
  let tickersList = [];
  let expectedRet = 0.08;
  let expectedVol = 0.14;
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
      expectedRet = Number(strat.expected_return || 0.08);
      expectedVol = Number(strat.volatility || 0.14);
      divYield = Number(strat.dividend_yield !== undefined ? strat.dividend_yield : 0.02);
    }
  }

  if (Object.keys(assetWeightsJson).length === 0 && tickersList.length > 0) {
    const eqPct = Number((100 / tickersList.length).toFixed(2));
    tickersList.forEach(t => {
      assetWeightsJson[t] = eqPct;
    });
  }

  const projMetrics = (typeof computeGoalProjectionMetrics === 'function')
    ? computeGoalProjectionMetrics()
    : { projectedFinalWealth: targetAmount, achievementPct: 100, inflationRate: 0 };

  const isUpdatingExisting = saveMode !== 'new' && Boolean(editingSavedPortfolioId);
  const tierInfo = getUserTierInfo();
  if (!isUpdatingExisting && savedPortfoliosList.length >= tierInfo.maxSavedPortfolios) {
    if (tierInfo.planTier === 'guest') {
      openProUpgradeModal(
        `โหมดทดลองใช้ (Guest) บันทึกแผนในเครื่องได้สูงสุด ${tierInfo.maxSavedPortfolios} แผน กรุณาสมัครสมาชิกหรือเข้าสู่ระบบฟรีเพื่อบันทึกแผนพอร์ตขึ้น Cloud ได้สูงสุด 3 แผน`,
        'free'
      );
    } else if (tierInfo.planTier === 'free') {
      openProUpgradeModal(
        `บัญชี Member ฟรีบันทึกแผนพอร์ตได้สูงสุด ${tierInfo.maxSavedPortfolios} แผน กรุณาอัปเกรดเป็น QuantFolio Pro (สูงสุด 20 แผน) หรือ Advisor Pro (ไม่จำกัดแผนลูกค้า)`,
        'pro'
      );
    } else {
      openProUpgradeModal(
        `แพ็กเกจปัจจุบันของคุณบันทึกแผนพอร์ตได้สูงสุด ${tierInfo.maxSavedPortfolios} แผน กรุณาอัปเกรดเป็น Advisor Pro เพื่อปลดล็อกคลังบันทึกแผนลูกค้าไม่จำกัด`,
        'advisor'
      );
    }
    return;
  }
  const targetId = isUpdatingExisting ? String(editingSavedPortfolioId) : `local-${Date.now()}`;
  const nowIso = new Date().toISOString();

  const payload = {
    portfolio_name: portfolioName,
    goal_type: goalType,
    goal_label: goalLabel,
    target_amount: targetAmount,
    initial_budget: initialBudget,
    monthly_dca: monthlyDca,
    investment_period_years: investmentPeriodYears,
    inflation_rate: Number(projMetrics.inflationRate || 0),
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
      saveBtn.innerText = isUpdatingExisting ? 'กำลังอัปเดต...' : 'กำลังบันทึก...';
    }

    let savedRecord = null;

    if (currentUser && currentUser.id) {
      // ผู้ใช้ที่ล็อกอินแล้ว: บันทึกขึ้น Cloud API (Supabase PostgreSQL) เท่านั้น ห้าม fallback ลง localStorage เงียบๆ
      const usePut = isUpdatingExisting && !targetId.startsWith('local-');
      const endpoint = usePut ? `/api/portfolios/${encodeURIComponent(targetId)}` : '/api/portfolios';
      const res = await fetch(endpoint, {
        method: usePut ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', ...getBackendAuthHeaders() },
        body: JSON.stringify(payload)
      });
      if (res.status === 403) {
        const errJson = await res.json().catch(() => ({}));
        openProUpgradeModal(errJson.detail || 'ถึงเพดานจำนวนแผนพอร์ตของแพ็กเกจปัจจุบัน กรุณาอัปเกรดเป็น QuantFolio Pro', 'pro');
        return;
      }
      const resJson = await res.json().catch(() => ({}));
      if (!res.ok || !resJson.portfolio) {
        throw new Error(resJson.detail || 'ไม่สามารถบันทึกพอร์ตขึ้นฐานข้อมูล Cloud ได้ กรุณาลองใหม่อีกครั้ง');
      }
      savedRecord = { ...resJson.portfolio, storage_origin: 'cloud' };
    } else {
      // โหมด Guest (ยังไม่ล็อกอิน): บันทึกในเครื่องนี้ได้สูงสุด 1 พอร์ต
      const localArr = readLocalPortfoliosList(GUEST_PORTFOLIOS_STORAGE_KEY);
      const existingItem = isUpdatingExisting
        ? localArr.find(item => String(item.id) === targetId)
        : null;
      savedRecord = {
        ...payload,
        id: targetId,
        storage_origin: 'local',
        created_at: existingItem?.created_at || nowIso,
        updated_at: nowIso
      };
      const filtered = localArr.filter(item => {
        if (isUpdatingExisting && String(item.id) === targetId) return false;
        if (!isUpdatingExisting && String(item.portfolio_name || '').trim().toLowerCase() === portfolioName.toLowerCase()) return false;
        return true;
      });
      filtered.unshift(savedRecord);
      writeLocalPortfoliosList(GUEST_PORTFOLIOS_STORAGE_KEY, filtered);
    }

    editingSavedPortfolioId = savedRecord.id || null;
    await fetchUserPortfolios();
    syncEditingPortfolioBannerUI();

    const modeHint = currentUser ? 'ซิงก์ขึ้น Cloud แล้ว' : 'บันทึกในเครื่องนี้แล้ว';
    showPortfolioToast(
      isUpdatingExisting
        ? `อัปเดตพอร์ต "${portfolioName}" เรียบร้อยแล้ว (${modeHint})`
        : `บันทึกพอร์ต "${portfolioName}" (${goalLabel}) เรียบร้อยแล้ว (${modeHint})`
    );
  } catch (err) {
    console.error('Save portfolio error:', err);
    showPortfolioToast(err.message || 'ไม่สามารถบันทึกพอร์ตได้');
    alert('เกิดข้อผิดพลาดในการบันทึกพอร์ต: ' + err.message);
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      syncEditingPortfolioBannerUI();
    }
  }
}

/**
 * ดึงรายการพอร์ตที่บันทึกไว้
 * - ผู้ใช้ที่ล็อกอิน: ดึงจาก Server API (Supabase PostgreSQL) เท่านั้น ไม่โหลดจาก localStorage
 * - โหมด Guest: ดึงจาก localStorage ในเครื่อง
 */
async function fetchUserPortfolios() {
  try {
    const combined = [];
    const seenKeys = new Set();

    const addUniquePortfolio = (p, fallbackOrigin = 'local') => {
      if (!p || !p.portfolio_name) return;
      const key = `${String(p.id || '')}|${p.portfolio_name.trim().toLowerCase()}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        combined.push({
          ...p,
          storage_origin: p.storage_origin || fallbackOrigin
        });
      }
    };

    if (currentUser && currentUser.id) {
      const res = await fetch('/api/portfolios', {
        headers: getBackendAuthHeaders()
      });
      if (res.ok) {
        const serverData = await res.json();
        if (Array.isArray(serverData.portfolios)) {
          serverData.portfolios.forEach(item => addUniquePortfolio(item, 'cloud'));
        }
      }
    } else {
      readLocalPortfoliosList(GUEST_PORTFOLIOS_STORAGE_KEY).forEach(item => addUniquePortfolio(item, 'local'));
    }

    savedPortfoliosList = combined;
    window.savedPortfoliosList = savedPortfoliosList;
    renderSavedPortfoliosList(savedPortfoliosList);
    syncEditingPortfolioBannerUI();
    return savedPortfoliosList;
  } catch (err) {
    console.error('Fetch portfolios error:', err);
    return [];
  }
}

/**
 * ลบพอร์ตที่บันทึกไว้ (Cloud API สำหรับผู้ใช้ที่ล็อกอิน / localStorage เฉพาะโหมด Guest)
 */
async function deleteUserPortfolio(portfolioId) {
  const targetItem = savedPortfoliosList.find(p => String(p.id) === String(portfolioId));
  const label = targetItem?.portfolio_name || 'รายการพอร์ตนี้';
  if (!window.confirm(`ต้องการลบ "${label}" ออกจากรายการที่บันทึกไว้ใช่หรือไม่?`)) {
    return;
  }

  try {
    if (currentUser && currentUser.id) {
      const res = await fetch(`/api/portfolios/${encodeURIComponent(portfolioId)}`, {
        method: 'DELETE',
        headers: getBackendAuthHeaders()
      });
      if (!res.ok && res.status !== 404) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || 'ไม่สามารถลบพอร์ตจากฐานข้อมูล Cloud ได้');
      }
    } else {
      const localArr = readLocalPortfoliosList(GUEST_PORTFOLIOS_STORAGE_KEY);
      const nextLocal = localArr.filter(item =>
        String(item.id) !== String(portfolioId) &&
        (!targetItem || item.portfolio_name !== targetItem.portfolio_name)
      );
      writeLocalPortfoliosList(GUEST_PORTFOLIOS_STORAGE_KEY, nextLocal);
    }

    if (String(editingSavedPortfolioId) === String(portfolioId)) {
      editingSavedPortfolioId = null;
    }

    await fetchUserPortfolios();
    showPortfolioToast(`ลบพอร์ต "${label}" เรียบร้อยแล้ว`);
  } catch (err) {
    alert('ไม่สามารถลบพอร์ตได้: ' + err.message);
  }
}

function editSavedPortfolioInForm(portfolioId) {
  const item = savedPortfoliosList.find(p => String(p.id) === String(portfolioId));
  if (!item) return;

  editingSavedPortfolioId = item.id;
  loadSavedPortfolioToDashboard(portfolioId, { triggerRun: false, keepEditing: true });
  syncEditingPortfolioBannerUI();

  const nameEl = document.getElementById('save-portfolio-name');
  if (nameEl) {
    nameEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => nameEl.focus(), 250);
  }
  showPortfolioToast(`พร้อมแก้ไขพอร์ต "${item.portfolio_name}" — ปรับค่าแล้วกด "อัปเดตพอร์ตนี้"`);
}

function exportSavedPortfoliosJson() {
  if (!Array.isArray(savedPortfoliosList) || savedPortfoliosList.length === 0) {
    showPortfolioToast('ยังไม่มีพอร์ตที่บันทึกไว้สำหรับส่งออก');
    return;
  }
  const payload = {
    exported_at: new Date().toISOString(),
    app: 'QuantFolio Wealth Analytics',
    version: '1.0',
    portfolios: savedPortfoliosList
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const dateTag = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `QuantFolio_SavedPortfolios_${dateTag}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showPortfolioToast(`ส่งออกพอร์ตที่บันทึกไว้ ${savedPortfoliosList.length} รายการเป็นไฟล์ JSON แล้ว`);
}

function triggerImportSavedPortfoliosJson() {
  const input = document.getElementById('import-portfolios-file-input');
  if (input) {
    input.value = '';
    input.click();
  }
}

async function handleImportSavedPortfoliosFile(inputEl) {
  const file = inputEl?.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const items = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.portfolios) ? parsed.portfolios : []);
    if (items.length === 0) {
      alert('ไม่พบรายการพอร์ตในไฟล์ JSON นี้');
      return;
    }

    let importedCount = 0;

    if (currentUser && currentUser.id) {
      for (const raw of items) {
        if (!raw || typeof raw.portfolio_name !== 'string' || !raw.portfolio_name.trim()) continue;
        const { id: _discardId, ...rest } = raw;
        const payload = {
          ...rest,
          portfolio_name: raw.portfolio_name.trim(),
          asset_weights: raw.asset_weights || {},
          tickers: Array.isArray(raw.tickers) ? raw.tickers : Object.keys(raw.asset_weights || {})
        };
        const res = await fetch('/api/portfolios', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getBackendAuthHeaders() },
          body: JSON.stringify(payload)
        });
        if (res.ok) importedCount++;
      }
    } else {
      const currentArr = readLocalPortfoliosList(GUEST_PORTFOLIOS_STORAGE_KEY);
      const existingNames = new Set(currentArr.map(p => String(p.portfolio_name || '').trim().toLowerCase()));
      for (const raw of items) {
        if (!raw || typeof raw.portfolio_name !== 'string' || !raw.portfolio_name.trim()) continue;
        const cleanName = raw.portfolio_name.trim();
        const rec = {
          ...raw,
          id: `local-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
          portfolio_name: cleanName,
          storage_origin: 'local',
          created_at: raw.created_at || new Date().toISOString()
        };
        if (existingNames.has(cleanName.toLowerCase())) {
          const idx = currentArr.findIndex(p => String(p.portfolio_name || '').trim().toLowerCase() === cleanName.toLowerCase());
          if (idx >= 0) currentArr[idx] = rec;
        } else {
          currentArr.unshift(rec);
          existingNames.add(cleanName.toLowerCase());
        }
        importedCount++;
      }
      writeLocalPortfoliosList(GUEST_PORTFOLIOS_STORAGE_KEY, currentArr);
    }

    await fetchUserPortfolios();
    showPortfolioToast(`นำเข้าพอร์ตสำเร็จ ${importedCount} รายการ`);
  } catch (err) {
    alert('ไฟล์ JSON ไม่ถูกต้อง: ' + err.message);
  }
}

/**
 * โหลดข้อมูลพอร์ตที่บันทึกไว้กลับมาคำนวณและแสดงผลบน Dashboard
 */
function loadSavedPortfolioToDashboard(portfolioId, opts = {}) {
  const item = savedPortfoliosList.find(p => String(p.id) === String(portfolioId));
  if (!item) return;

  const { triggerRun = true, keepEditing = false } = opts;
  editingSavedPortfolioId = keepEditing ? item.id : item.id;

  const appState = window.state || (typeof state !== 'undefined' ? state : null);
  const weightsObj = item.asset_weights || {};
  const savedTickers = (Array.isArray(item.tickers) && item.tickers.length >= 2)
    ? item.tickers
    : Object.keys(weightsObj);

  if (item.currency && (item.currency === 'THB' || item.currency === 'USD') && typeof setGlobalCurrency === 'function') {
    if (!appState || appState.currency !== item.currency) {
      setGlobalCurrency(item.currency);
    }
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
  const formattedInit = initBudget.toLocaleString('en-US', { maximumFractionDigits: 0 });
  const budgetEl = document.getElementById('budget-input');
  const stripBudgetEl = document.getElementById('strip-budget-input');
  const goalInitEl = document.getElementById('save-initial-budget');
  if (budgetEl) budgetEl.value = formattedInit;
  if (stripBudgetEl) stripBudgetEl.value = formattedInit;
  if (goalInitEl) goalInitEl.value = formattedInit;

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

  if (item.inflation_rate !== undefined && typeof setGoalInflationRate === 'function') {
    setGoalInflationRate(Number(item.inflation_rate) || 0, false);
  }

  if (item.strategy_key && ['max_sharpe', 'min_volatility', 'hrp', 'equal_weight'].includes(item.strategy_key)) {
    if (typeof selectGoal === 'function') selectGoal(item.strategy_key);
  }

  syncEditingPortfolioBannerUI();

  if (triggerRun && typeof runOptimization === 'function') {
    runOptimization(false);
  }
  if (typeof recalculateGoalProjection === 'function') {
    recalculateGoalProjection();
  }
  if (triggerRun) {
    showPortfolioToast(`ดึงพอร์ต "${item.portfolio_name}" กลับมาคำนวณและแสดงผลแล้ว`);
  }
}

function renderSavedPortfoliosList(portfolios) {
  const container = document.getElementById('saved-portfolios-container');
  const countBadge = document.getElementById('saved-portfolios-count');
  const headerCountBadge = document.getElementById('header-saved-portfolios-count');
  const accountMenuCountBadge = document.getElementById('account-menu-saved-count');
  const list = Array.isArray(portfolios) ? portfolios : [];

  if (countBadge) countBadge.innerText = list.length;
  if (accountMenuCountBadge) accountMenuCountBadge.innerText = list.length;
  if (headerCountBadge) {
    if (list.length > 0) {
      headerCountBadge.innerText = list.length;
      headerCountBadge.classList.remove('hidden');
    } else {
      headerCountBadge.innerText = '';
      headerCountBadge.classList.add('hidden');
    }
  }
  if (!container) return;

  if (list.length === 0) {
    const guestNote = !currentUser
      ? 'คุณสามารถกดปุ่ม <b>"บันทึกพอร์ตนี้"</b> ด้านบนเพื่อเก็บไว้ในเครื่องนี้ได้ทันทีโดยไม่ต้องสมัครสมาชิก หรือเข้าสู่ระบบเพื่อซิงก์ข้ามอุปกรณ์'
      : 'กดปุ่ม <b>"บันทึกพอร์ตนี้"</b> ด้านบนเพื่อจัดเก็บแผนพอร์ตพร้อมเป้าหมายและ DCA ไว้ในบัญชีของคุณ';
    container.innerHTML = `
      <div class="p-5 text-center rounded-2xl bg-slate-50 border border-dashed border-slate-300 space-y-1.5">
        <div class="text-sm font-semibold text-slate-800">ยังไม่มีพอร์ตที่บันทึกไว้</div>
        <div class="text-xs text-slate-600 leading-relaxed">${guestNote}</div>
      </div>
    `;
    return;
  }

  const stratLabels = {
    max_sharpe: 'คุ้มความเสี่ยง (Max Sharpe)',
    min_volatility: 'ผันผวนต่ำ (Min Vol)',
    hrp: 'กระจายสมดุล (HRP)',
    equal_weight: 'แบ่งเท่ากัน (1/N)'
  };
  const isPrivate = Boolean(window.state && window.state.balancePrivacyHidden);
  const maskVal = (sym, numStr) => isPrivate ? `${sym} ••••••` : `${sym}${numStr}`;

  container.innerHTML = list.map(p => {
    const sym = p.currency === 'USD' ? '$' : '฿';
    const weights = p.asset_weights || {};
    const weightEntries = Object.entries(weights).sort((a, b) => b[1] - a[1]);
    const weightBadges = weightEntries.length > 0
      ? weightEntries
          .map(([ticker, pct]) => `<span class="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-mono font-bold bg-blue-50 text-blue-800 border border-blue-200">${escapeHtml(ticker)}: ${escapeHtml(pct)}%</span>`)
          .join(' ')
      : `<span class="text-[11px] text-slate-500">กด "โหลดมาใช้งาน" เพื่อคำนวณสัดส่วนล่าสุด</span>`;

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
    const stratName = escapeHtml(stratLabels[p.strategy_key] || 'คุ้มความเสี่ยง (Max Sharpe)');
    const dateStr = p.created_at ? new Date(p.created_at).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    const isEditingCard = String(editingSavedPortfolioId) === String(p.id);
    const storagePill = p.storage_origin === 'cloud'
      ? `<span class="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 text-[10px] font-semibold">ซิงก์บัญชี</span>`
      : `<span class="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200 text-[10px] font-semibold">บันทึกในเครื่อง</span>`;

    return `
      <div class="p-4 rounded-2xl bg-white border ${isEditingCard ? 'border-[#00D084] ring-1 ring-[#00D084]/40' : 'border-slate-200 hover:border-emerald-300'} shadow-2xs transition space-y-3">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 border-b border-slate-100 pb-2.5">
          <div class="flex items-center gap-2 flex-wrap min-w-0">
            <span class="px-2 py-0.5 rounded-md bg-[#00D084] text-[#0A0D12] text-[10px] font-bold">${goalLabel}</span>
            <span class="font-bold text-sm text-slate-900 truncate">${safePortfolioName}</span>
            <span class="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 font-mono text-[10px] font-semibold">${stratName}</span>
            ${storagePill}
            ${dateStr ? `<span class="text-[10px] text-slate-400">บันทึกเมื่อ ${escapeHtml(dateStr)}</span>` : ''}
          </div>
          <div class="flex items-center gap-1.5 flex-wrap shrink-0">
            <button
              type="button"
              data-portfolio-id="${safeId}"
              onclick="loadSavedPortfolioToDashboard(this.dataset.portfolioId)"
              class="px-3 py-1.5 text-xs font-bold bg-[#00D084] hover:bg-[#00B873] text-[#0A0D12] rounded-xl transition cursor-pointer"
            >
              โหลดมาใช้งาน
            </button>
            <button
              type="button"
              data-portfolio-id="${safeId}"
              onclick="openPdfReportConfigModal(this.dataset.portfolioId)"
              title="พิมพ์ใบสรุปลูกค้า (PDF) จากพอร์ตนี้"
              class="px-2.5 py-1.5 text-xs font-semibold bg-slate-900 hover:bg-slate-800 text-white rounded-xl transition cursor-pointer"
            >
              พิมพ์ PDF
            </button>
            <button
              type="button"
              data-portfolio-id="${safeId}"
              onclick="editSavedPortfolioInForm(this.dataset.portfolioId)"
              title="แก้ไขชื่อ เป้าหมาย หรือ DCA ของพอร์ตนี้"
              class="px-2.5 py-1.5 text-xs font-semibold bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-xl transition cursor-pointer"
            >
              แก้ไข
            </button>
            <button
              type="button"
              data-portfolio-id="${safeId}"
              onclick="deleteUserPortfolio(this.dataset.portfolioId)"
              title="ลบพอร์ตนี้"
              class="p-1.5 text-slate-400 hover:text-rose-600 rounded-xl hover:bg-rose-50 transition cursor-pointer"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
            </button>
          </div>
        </div>

        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <div class="p-2.5 rounded-xl bg-slate-50 border border-slate-100">
            <div class="text-[10px] text-slate-500">เงินลงทุนก้อนแรก</div>
            <div class="font-mono font-bold text-slate-900 tabular-nums">${maskVal(sym, initBudgetNum.toLocaleString())}</div>
          </div>
          <div class="p-2.5 rounded-xl bg-slate-50 border border-slate-100">
            <div class="text-[10px] text-slate-500">ออมเพิ่ม (DCA) / ระยะเวลา</div>
            <div class="font-mono font-bold text-emerald-700 tabular-nums">${maskVal(sym, dcaNum.toLocaleString())}/ด. (${yearsNum} ปี)</div>
          </div>
          <div class="p-2.5 rounded-xl bg-indigo-50/50 border border-indigo-100">
            <div class="text-[10px] text-indigo-800">มูลค่าพอร์ตคาดการณ์</div>
            <div class="font-mono font-bold text-indigo-700 tabular-nums">${maskVal(sym, Math.round(projValNum).toLocaleString())}</div>
          </div>
          <div class="p-2.5 rounded-xl bg-emerald-50/50 border border-emerald-100">
            <div class="flex items-center justify-between text-[10px]">
              <span class="text-emerald-900 font-semibold">เป้า ${maskVal(sym, targetNum.toLocaleString())}</span>
              <span class="font-mono font-bold ${achievePct >= 100 ? 'text-emerald-700' : 'text-amber-700'}">${achievePct}%</span>
            </div>
            <div class="w-full h-1.5 bg-slate-200 rounded-full overflow-hidden mt-1.5">
              <div class="h-full ${achievePct >= 100 ? 'bg-emerald-600' : 'bg-amber-500'} rounded-full" style="width:${barW}%"></div>
            </div>
          </div>
        </div>

        <div class="flex items-center gap-1.5 flex-wrap pt-0.5">
          <span class="text-[10px] font-semibold text-slate-500 mr-1">สัดส่วนสินทรัพย์:</span>
          ${weightBadges}
        </div>
      </div>
    `;
  }).join('');
}

async function openSupabaseConfigModal(defaultMode) {
  const modal = document.getElementById('supabase-config-modal');
  if (!modal) return;

  if (defaultMode === 'signin' || defaultMode === 'signup') {
    switchAuthTab(defaultMode);
  } else {
    switchAuthTab(authTabMode);
  }

  const msgBox = document.getElementById('modal-diagnostic-alert');
  if (msgBox) msgBox.classList.add('hidden');

  const emailInput = document.getElementById('real-auth-email');
  const rememberBox = document.getElementById('auth-remember-email');
  try {
    const remembered = normalizeEmailInput(localStorage.getItem('qf_remembered_email'));
    if (emailInput && !emailInput.value && remembered) {
      emailInput.value = remembered;
    }
    if (rememberBox) {
      rememberBox.checked = Boolean(remembered || true);
    }
  } catch (e) {}

  clearAllAuthPasswordInputs();

  modal.classList.remove('hidden');
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }

  // แสดงปุ่ม Google OAuth เฉพาะเมื่อ Supabase เปิดใช้งาน Google Provider จริงเท่านั้น
  const googleSection = document.getElementById('auth-google-oauth-section');
  if (googleSection) {
    googleSection.classList.add('hidden');
    const st = await checkSupabaseAuthSettings();
    if (st && st.googleEnabled) {
      googleSection.classList.remove('hidden');
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
  const cleanMsg = String(msg || '').trim();
  if (!cleanMsg) return;
  if (typeof window.__appShowPortfolioToast === 'function') {
    window.__appShowPortfolioToast(cleanMsg);
    return;
  }
  const toast = document.getElementById('portfolio-toast');
  if (!toast) return;
  const toastText = document.getElementById('portfolio-toast-text');
  if (toastText) {
    toastText.innerText = cleanMsg;
  } else {
    toast.innerText = cleanMsg;
  }
  toast.classList.remove('hidden');
  clearTimeout(window.__portfolioToastTimeout);
  window.__portfolioToastTimeout = setTimeout(() => {
    toast.classList.add('hidden');
  }, 4000);
}

const CLIENT_TIER_DEFAULTS = {
  guest: {
    planTier: 'guest',
    labelTh: 'โหมดทดลองใช้ (Guest)',
    badgeText: 'GUEST • 5 หุ้น',
    maxAssets: 5,
    maxSavedPortfolios: 1,
    canViewNews: false,
    canDownloadSimPdf: false,
    canCustomizeBlViews: false,
    canWhitelabelAdvisorPdf: false,
    safeBlConfidenceCap: 0.35
  },
  free: {
    planTier: 'free',
    labelTh: 'สมาชิกทั่วไป (Member ฟรี)',
    badgeText: 'MEMBER ฟรี • 8 หุ้น',
    maxAssets: 8,
    maxSavedPortfolios: 3,
    canViewNews: true,
    canDownloadSimPdf: true,
    canCustomizeBlViews: false,
    canWhitelabelAdvisorPdf: false,
    safeBlConfidenceCap: 0.35
  },
  pro: {
    planTier: 'pro',
    labelTh: 'QuantFolio Pro (นักลงทุนรายย่อย)',
    badgeText: '✦ PRO • 15 หุ้น & BL',
    maxAssets: 15,
    maxSavedPortfolios: 20,
    canViewNews: true,
    canDownloadSimPdf: true,
    canCustomizeBlViews: true,
    canWhitelabelAdvisorPdf: false,
    safeBlConfidenceCap: 1.00
  },
  advisor: {
    planTier: 'advisor',
    labelTh: 'Advisor Pro (IC / IP White-label)',
    badgeText: '★ ADVISOR PRO • 25 หุ้น',
    maxAssets: 25,
    maxSavedPortfolios: 9999,
    canViewNews: true,
    canDownloadSimPdf: true,
    canCustomizeBlViews: true,
    canWhitelabelAdvisorPdf: true,
    safeBlConfidenceCap: 1.00
  }
};

let adminConsoleCache = { users: [], upgrade_requests: [], activation_codes: [], pending_requests_count: 0 };
let activeProModalTab = 'plans';
let activeAdminSubTab = 'requests';
let activeProBillingCycle = 'yearly'; // Default: 'yearly' (รายปี • ประหยัดสูงสุด 23%)
let isProCoreFeaturesExpanded = false;

const PRO_PRICING_PLANS = {
  pro: {
    name: 'QuantFolio Pro',
    monthly: { display: '฿299', total: 299, subText: 'ชำระรายเดือน ฿299 • ยกเลิกหรือต่ออายุได้ทุกเมื่อ', strike: false },
    yearly: { display: '฿239', total: 2868, subText: 'ชำระรายปี ฿2,868 • ประหยัด ฿720/ปี', strike: true },
    quarterlyTotal: 897
  },
  advisor: {
    name: 'Advisor Pro (IC / IP)',
    monthly: { display: '฿1,290', total: 1290, subText: 'ชำระรายเดือน ฿1,290 • รองรับออกใบเสร็จ/องค์กร', strike: false },
    yearly: { display: '฿990', total: 11880, subText: 'ชำระรายปี ฿11,880 • ประหยัด ฿3,600/ปี', strike: true },
    quarterlyTotal: 3870
  }
};

function formatDateTimeTh(isoStr) {
  if (!isoStr) return 'ถาวร';
  try {
    const dt = new Date(isoStr);
    if (Number.isNaN(dt.getTime())) return '—';
    const datePart = dt.toLocaleDateString('th-TH', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
    const timePart = dt.toLocaleTimeString('th-TH', {
      timeZone: 'Asia/Bangkok',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    return `${datePart} เวลา ${timePart} น.`;
  } catch (e) {
    return String(isoStr).slice(0, 16);
  }
}

function formatShortDateTh(isoStr) {
  return formatDateTimeTh(isoStr);
}

function formatBangkokDatetimeLocalValue(isoStr) {
  let dt = isoStr ? new Date(isoStr) : null;
  if (!dt || Number.isNaN(dt.getTime())) {
    dt = new Date(Date.now() + 30 * 86400000);
  }
  const bkkMs = dt.getTime() + 7 * 3600000;
  const bkk = new Date(bkkMs);
  const pad = n => String(n).padStart(2, '0');
  return `${bkk.getUTCFullYear()}-${pad(bkk.getUTCMonth() + 1)}-${pad(bkk.getUTCDate())}T${pad(bkk.getUTCHours())}:${pad(bkk.getUTCMinutes())}`;
}

function getExpiryCountdownInfo(tier, expIso, daysRem, isExpired) {
  const cleanTier = String(tier || 'free').trim().toLowerCase();
  const hasIso = Boolean(expIso);
  const dt = hasIso ? new Date(expIso) : null;
  const validDt = Boolean(dt && !Number.isNaN(dt.getTime()));
  const dateTimeText = validDt ? formatDateTimeTh(expIso) : '';

  if (isExpired && validDt) {
    return {
      state: 'expired',
      dateTimeText,
      countdownText: 'หมดอายุแล้ว',
      shortText: `หมดอายุเมื่อ ${dateTimeText}`,
      fullText: `หมดอายุเมื่อ ${dateTimeText}`
    };
  }
  if (cleanTier === 'free' || cleanTier === 'guest') {
    return {
      state: 'none',
      dateTimeText: '',
      countdownText: '',
      shortText: '',
      fullText: cleanTier === 'free' ? 'สมาชิกฟรีตลอดชีพ' : ''
    };
  }
  if (!validDt) {
    return {
      state: 'lifetime',
      dateTimeText: 'ถาวร',
      countdownText: 'สิทธิ์ถาวร',
      shortText: 'ถาวร (ไม่มีวันหมดอายุ)',
      fullText: 'สิทธิ์ถาวร (ไม่มีวันหมดอายุ)'
    };
  }

  const diffMs = dt.getTime() - Date.now();
  if (diffMs <= 0) {
    return {
      state: 'expired',
      dateTimeText,
      countdownText: 'หมดอายุแล้ว',
      shortText: `หมดอายุเมื่อ ${dateTimeText}`,
      fullText: `หมดอายุเมื่อ ${dateTimeText}`
    };
  }

  if (diffMs < 86400000) {
    const hrs = Math.floor(diffMs / 3600000);
    const mins = Math.max(1, Math.floor((diffMs % 3600000) / 60000));
    const countdownText = hrs > 0 ? `เหลือ ${hrs} ชม. ${mins} นาที` : `เหลือ ${mins} นาที`;
    return {
      state: 'warning',
      dateTimeText,
      countdownText,
      shortText: `${countdownText} • ${dateTimeText}`,
      fullText: `หมดอายุ ${dateTimeText} (${countdownText})`
    };
  }

  const days = (Number.isFinite(Number(daysRem)) && Number(daysRem) > 0)
    ? Number(daysRem)
    : Math.max(1, Math.ceil(diffMs / 86400000));
  const countdownText = `เหลือ ${days} วัน`;
  const state = days <= 7 ? 'warning' : 'active';
  return {
    state,
    dateTimeText,
    countdownText,
    shortText: `${countdownText} • ${dateTimeText}`,
    fullText: `หมดอายุ ${dateTimeText} (${countdownText})`
  };
}

function formatExpiryBadgeText(tier, expIso, daysRem, isExpired) {
  return getExpiryCountdownInfo(tier, expIso, daysRem, isExpired).shortText;
}

function getUserTierInfo() {
  if (!currentUser || !currentUser.id) {
    return {
      ...CLIENT_TIER_DEFAULTS.guest,
      realPlanTier: 'guest',
      previewTier: null,
      planExpiresAt: null,
      daysRemaining: null,
      isExpired: false,
      isAdmin: false
    };
  }
  const meta = currentUser.user_metadata || {};
  // P0-5: Trust ONLY Backend-verified session admin flag (zero hardcoded admin email in public client JS)
  const isAdmin = Boolean(currentUser.is_admin === true || meta.is_admin === true);

  const rawRealTier = String(currentUser.real_plan_tier || meta.real_plan_tier || currentUser.plan_tier || meta.plan_tier || 'free').trim().toLowerCase();
  const realPlanTier = CLIENT_TIER_DEFAULTS[rawRealTier] && rawRealTier !== 'guest' ? rawRealTier : 'free';
  const previewTier = isAdmin ? (getAdminPreviewTier() || currentUser.preview_tier || meta.preview_tier || null) : null;
  const activeTier = (previewTier && CLIENT_TIER_DEFAULTS[previewTier]) ? previewTier : realPlanTier;

  const base = CLIENT_TIER_DEFAULTS[activeTier] || CLIENT_TIER_DEFAULTS.free;
  const useSrvEnt = !previewTier;
  const srvEnt = useSrvEnt ? (currentUser.entitlements || meta.entitlements || {}) : {};

  return {
    planTier: activeTier,
    realPlanTier,
    previewTier,
    planExpiresAt: currentUser.plan_expires_at ?? meta.plan_expires_at ?? null,
    daysRemaining: currentUser.days_remaining ?? meta.days_remaining ?? null,
    isExpired: Boolean(currentUser.is_expired ?? meta.is_expired ?? false),
    isAdmin,
    labelTh: srvEnt.label_th || base.labelTh,
    badgeText: previewTier ? `🧪 ${base.badgeText}` : (srvEnt.badge_text || base.badgeText),
    maxAssets: Number(srvEnt.max_assets ?? base.maxAssets),
    maxSavedPortfolios: Number(srvEnt.max_saved_portfolios ?? base.maxSavedPortfolios),
    canViewNews: Boolean(srvEnt.can_view_news ?? base.canViewNews),
    canDownloadSimPdf: Boolean(srvEnt.can_download_sim_pdf ?? base.canDownloadSimPdf),
    canCustomizeBlViews: Boolean(srvEnt.can_customize_bl_views ?? base.canCustomizeBlViews),
    canWhitelabelAdvisorPdf: Boolean(srvEnt.can_whitelabel_advisor_pdf ?? base.canWhitelabelAdvisorPdf),
    safeBlConfidenceCap: Number(srvEnt.safe_bl_confidence_cap ?? base.safeBlConfidenceCap)
  };
}

function showInlineModalAlert(elId, message, type = 'error') {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!message) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  el.textContent = message;
  if (type === 'success') {
    el.className = 'p-2.5 rounded-xl bg-emerald-50 border border-emerald-300 text-emerald-900 text-xs font-semibold leading-relaxed';
  } else if (type === 'warning') {
    el.className = 'p-2.5 rounded-xl bg-amber-50 border border-amber-300 text-amber-950 text-xs font-semibold leading-relaxed';
  } else {
    el.className = 'p-2.5 rounded-xl bg-rose-50 border border-rose-300 text-rose-800 text-xs font-semibold leading-relaxed';
  }
  el.classList.remove('hidden');
}

/**
 * P0-5: Dynamically construct and mount Admin UI DOM ONLY when Backend confirms is_admin === true.
 * Non-admin & Guest users never receive Admin HTML markup in the DOM or public index.html.
 */
function syncAdminDynamicDom(isAdmin) {
  const quickMount = document.getElementById('admin-quick-tier-mount');
  const tabsBar = document.getElementById('pro-modal-tabs-bar');
  const panelMount = document.getElementById('pro-admin-panel-mount');

  if (!isAdmin) {
    if (quickMount) quickMount.innerHTML = '';
    const existingTabBtn = document.getElementById('pro-tab-btn-admin');
    if (existingTabBtn) existingTabBtn.remove();
    if (panelMount) panelMount.innerHTML = '';
    return;
  }

  if (quickMount && !document.getElementById('admin-quick-tier-panel')) {
    quickMount.innerHTML = `
      <div id="admin-quick-tier-panel" class="p-2.5 rounded-xl bg-slate-900 text-white space-y-2 my-1 border border-[#00D084]/35">
        <div class="flex items-center justify-between text-[10px] font-bold text-[#34F5A8]">
          <span>🛠️ โหมดทดสอบ Admin (ไม่แก้ DB)</span>
          <span class="font-mono">ADMIN</span>
        </div>
        <div class="grid grid-cols-2 gap-1">
          <button type="button" id="admin-switch-btn-real" onclick="adminSetPreviewTier('real')" class="px-1.5 py-1 rounded-lg bg-[#00D084] text-[#0A0D12] text-[10px] font-extrabold transition cursor-pointer">
            สิทธิ์จริง
          </button>
          <button type="button" id="admin-switch-btn-guest" onclick="adminSetPreviewTier('guest')" class="px-1.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-[10px] font-semibold text-slate-200 transition cursor-pointer">
            ทดสอบ Guest
          </button>
          <button type="button" id="admin-switch-btn-free" onclick="adminSetPreviewTier('free')" class="px-1.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-[10px] font-semibold text-slate-200 transition cursor-pointer">
            ทดสอบ Member
          </button>
          <button type="button" id="admin-switch-btn-pro" onclick="adminSetPreviewTier('pro')" class="px-1.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-[10px] font-semibold text-emerald-300 transition cursor-pointer">
            ทดสอบ Pro
          </button>
          <button type="button" id="admin-switch-btn-advisor" onclick="adminSetPreviewTier('advisor')" class="col-span-2 px-1.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-[10px] font-semibold text-amber-300 transition cursor-pointer">
            ทดสอบ Advisor (25 หุ้น)
          </button>
        </div>
        <button type="button" onclick="openProUpgradeModal('', 'pro', 'admin'); toggleHeaderAccountMenu(false);" class="w-full py-1.5 px-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[10.5px] font-bold text-white transition cursor-pointer flex items-center justify-between">
          <span>เปิดแผงจัดการสมาชิก &amp; โค้ด</span>
          <span class="text-[#34F5A8]">➔</span>
        </button>
      </div>
    `;
  }

  if (tabsBar && !document.getElementById('pro-tab-btn-admin')) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'pro-tab-btn-admin';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
    btn.setAttribute('onclick', "switchProModalTab('admin')");
    btn.className = 'qf-pro-tab-btn flex-1 sm:flex-none px-3.5 py-2 rounded-lg font-semibold transition cursor-pointer whitespace-nowrap inline-flex items-center justify-center gap-1.5';
    btn.innerHTML = '<span>จัดการระบบ (Admin)</span><span id="admin-pending-badge" class="hidden px-1.5 py-0.2 rounded-full bg-rose-500 text-white text-[10px] font-mono font-extrabold">0</span>';
    tabsBar.appendChild(btn);
  }

  if (panelMount && !document.getElementById('pro-tab-panel-admin')) {
    panelMount.innerHTML = `
      <div id="pro-tab-panel-admin" class="hidden space-y-4 text-xs">
        <div id="admin-upgrade-control-box" class="p-3.5 rounded-2xl bg-slate-900 text-white border border-[#00D084]/40 space-y-2.5">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <span class="px-2 py-0.5 rounded bg-[#00D084] text-[#0A0D12] font-mono text-[10px] font-extrabold">SAFE PREVIEW</span>
              <span class="font-bold text-slate-100">สลับมุมมองทดสอบ 1 คลิก</span>
              <span class="text-[11px] text-slate-400">(จำลองเฉพาะ Session • ไม่แก้สิทธิ์จริงใน DB • ไม่หลุดหน้า Admin)</span>
            </div>
          </div>
          <div class="flex flex-wrap gap-1.5">
            <button type="button" id="admin-preview-btn-real" onclick="adminSetPreviewTier('real')" class="px-3 py-1.5 rounded-lg bg-[#00D084] text-[#0A0D12] font-extrabold text-[11px] transition cursor-pointer">
              ✓ สิทธิ์จริงของฉัน
            </button>
            <button type="button" id="admin-preview-btn-guest" onclick="adminSetPreviewTier('guest')" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-[11px] transition cursor-pointer">
              Guest (5 หุ้น)
            </button>
            <button type="button" id="admin-preview-btn-free" onclick="adminSetPreviewTier('free')" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-[11px] transition cursor-pointer">
              Member ฟรี (8 หุ้น)
            </button>
            <button type="button" id="admin-preview-btn-pro" onclick="adminSetPreviewTier('pro')" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-emerald-300 font-semibold text-[11px] transition cursor-pointer">
              QuantFolio Pro (15 หุ้น)
            </button>
            <button type="button" id="admin-preview-btn-advisor" onclick="adminSetPreviewTier('advisor')" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-300 font-semibold text-[11px] transition cursor-pointer">
              Advisor Pro (25 หุ้น)
            </button>
          </div>
        </div>

        <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2">
          <div class="inline-flex flex-wrap items-center gap-1.5">
            <button type="button" id="admin-subtab-btn-requests" onclick="switchAdminSubTab('requests')" class="qf-admin-subtab active px-3 py-1.5 rounded-lg font-bold transition cursor-pointer inline-flex items-center gap-1.5">
              <span>คิวแจ้งโอน / คำขอ</span>
              <span id="admin-subtab-req-count" class="px-1.5 py-0.2 rounded-full bg-amber-100 text-amber-900 text-[10px] font-mono font-bold">0</span>
            </button>
            <button type="button" id="admin-subtab-btn-users" onclick="switchAdminSubTab('users')" class="qf-admin-subtab px-3 py-1.5 rounded-lg font-semibold transition cursor-pointer inline-flex items-center gap-1.5">
              <span>สมาชิกทั้งหมด</span>
              <span id="admin-subtab-users-count" class="px-1.5 py-0.2 rounded-full bg-slate-200 text-slate-700 text-[10px] font-mono font-bold">0</span>
            </button>
            <button type="button" id="admin-subtab-btn-codes" onclick="switchAdminSubTab('codes')" class="qf-admin-subtab px-3 py-1.5 rounded-lg font-semibold transition cursor-pointer inline-flex items-center gap-1.5">
              <span>รหัสเปิดใช้งาน (Codes)</span>
              <span id="admin-subtab-codes-count" class="px-1.5 py-0.2 rounded-full bg-slate-200 text-slate-700 text-[10px] font-mono font-bold">0</span>
            </button>
          </div>
          <button type="button" onclick="loadAdminConsoleOverview()" class="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold text-[11px] transition cursor-pointer">
            ↻ รีเฟรชข้อมูล
          </button>
        </div>

        <div id="admin-console-alert" class="hidden p-2.5 rounded-xl border text-xs font-semibold" role="alert"></div>

        <div id="admin-subpanel-requests" class="space-y-2.5">
          <div id="admin-requests-container" class="space-y-2.5">
            <div class="p-4 rounded-xl bg-slate-50 border border-slate-200 text-center text-slate-500">กำลังโหลดคิวคำขออัปเกรด...</div>
          </div>
        </div>

        <div id="admin-subpanel-users" class="hidden space-y-3">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <input type="text" id="admin-users-search-input" oninput="adminFilterUsersTable()" placeholder="ค้นหาด้วยอีเมลหรือชื่อสมาชิก..." class="w-full sm:max-w-xs px-3 py-2 text-xs bg-white border border-slate-300 rounded-xl text-slate-900 focus:outline-none focus:border-[#00D084]" />
            <span class="text-[11px] text-slate-500">เปลี่ยนแพ็กเกจ + ระยะเวลาแล้วกด "บันทึก" (ต่ออายุแพ็กเกจเดิมจะทบวันเพิ่มให้อัตโนมัติ)</span>
          </div>
          <div class="overflow-x-auto rounded-xl border border-slate-200">
            <table class="w-full text-left border-collapse text-xs">
              <thead>
                <tr class="bg-slate-50 border-b border-slate-200 text-[11px] text-slate-600">
                  <th class="py-2.5 px-3 font-bold">สมาชิก / อีเมล</th>
                  <th class="py-2.5 px-3 font-bold whitespace-nowrap">แพ็กเกจปัจจุบัน</th>
                  <th class="py-2.5 px-3 font-bold whitespace-nowrap">วันหมดอายุ</th>
                  <th class="py-2.5 px-3 font-bold text-center whitespace-nowrap">พอร์ต</th>
                  <th class="py-2.5 px-3 font-bold whitespace-nowrap">จัดการสิทธิ์ &amp; ระยะเวลา</th>
                </tr>
              </thead>
              <tbody id="admin-users-table-body" class="divide-y divide-slate-100">
                <tr><td colspan="5" class="py-4 text-center text-slate-500">กำลังโหลดรายชื่อสมาชิก...</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div id="admin-subpanel-codes" class="hidden space-y-3">
          <div class="p-3.5 rounded-2xl bg-slate-50 border border-slate-200 space-y-2.5">
            <div class="font-bold text-slate-800">🔑 สร้างรหัสเปิดใช้งานใหม่ (สุ่มปลอดภัยด้วย secrets 8 หลัก)</div>
            <div class="grid grid-cols-2 sm:grid-cols-5 gap-2">
              <div>
                <label for="admin-code-tier" class="block text-[11px] font-semibold text-slate-600 mb-1">แพ็กเกจ</label>
                <select id="admin-code-tier" class="w-full px-2.5 py-2 text-xs font-bold bg-white border border-slate-300 rounded-xl text-slate-900">
                  <option value="pro">QuantFolio Pro</option>
                  <option value="advisor">Advisor Pro (IC/IP)</option>
                </select>
              </div>
              <div>
                <label for="admin-code-duration" class="block text-[11px] font-semibold text-slate-600 mb-1">ระยะเวลาสิทธิ์</label>
                <select id="admin-code-duration" class="w-full px-2.5 py-2 text-xs font-bold bg-white border border-slate-300 rounded-xl text-slate-900">
                  <option value="30">30 วัน</option>
                  <option value="90">90 วัน</option>
                  <option value="365">365 วัน</option>
                  <option value="0">ถาวร (Lifetime)</option>
                </select>
              </div>
              <div>
                <label for="admin-code-max-uses" class="block text-[11px] font-semibold text-slate-600 mb-1">จำนวนครั้งที่ใช้ได้</label>
                <select id="admin-code-max-uses" class="w-full px-2.5 py-2 text-xs font-bold bg-white border border-slate-300 rounded-xl text-slate-900">
                  <option value="1">1 ครั้ง (เฉพาะคนเดียว)</option>
                  <option value="5">5 ครั้ง</option>
                  <option value="50">50 ครั้ง</option>
                  <option value="999">ไม่จำกัด (999)</option>
                </select>
              </div>
              <div>
                <label for="admin-code-valid-days" class="block text-[11px] font-semibold text-slate-600 mb-1">อายุการรับสิทธิ์ของรหัส</label>
                <select id="admin-code-valid-days" class="w-full px-2.5 py-2 text-xs font-bold bg-white border border-slate-300 rounded-xl text-slate-900">
                  <option value="7">หมดอายุใน 7 วัน</option>
                  <option value="30" selected>หมดอายุใน 30 วัน</option>
                  <option value="0">ไม่จำกัดวันกรอก</option>
                </select>
              </div>
              <div class="col-span-2 sm:col-span-1 flex items-end">
                <button type="button" id="btn-admin-gen-code" onclick="adminGenerateActivationCode()" class="w-full min-h-[38px] px-3 py-2 rounded-xl bg-[#00D084] hover:bg-[#00B873] text-[#0A0D12] font-extrabold text-xs transition cursor-pointer whitespace-nowrap">
                  + สร้างรหัสใหม่
                </button>
              </div>
            </div>
            <input type="text" id="admin-code-note" placeholder="หมายเหตุรหัส (ไม่บังคับ) เช่น สำหรับลูกค้าคุณสมชาย หรือโปรเปิดตัว" class="w-full px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-xl text-slate-900 focus:outline-none focus:border-[#00D084]" />
          </div>

          <div class="overflow-x-auto rounded-xl border border-slate-200">
            <table class="w-full text-left border-collapse text-xs">
              <thead>
                <tr class="bg-slate-50 border-b border-slate-200 text-[11px] text-slate-600">
                  <th class="py-2.5 px-3 font-bold">รหัสเปิดใช้งาน (Code)</th>
                  <th class="py-2.5 px-3 font-bold whitespace-nowrap">แพ็กเกจ / สิทธิ์</th>
                  <th class="py-2.5 px-3 font-bold text-center whitespace-nowrap">ใช้งานแล้ว</th>
                  <th class="py-2.5 px-3 font-bold whitespace-nowrap">สถานะ</th>
                  <th class="py-2.5 px-3 font-bold text-right whitespace-nowrap">จัดการ</th>
                </tr>
              </thead>
              <tbody id="admin-codes-table-body" class="divide-y divide-slate-100">
                <tr><td colspan="5" class="py-4 text-center text-slate-500">ยังไม่มีรหัสที่สร้างไว้ — กด "+ สร้างรหัสใหม่" ด้านบนเพื่อเริ่มต้น</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }
}

function syncMembershipTierBadgesUI() {
  const info = getUserTierInfo();
  syncAdminDynamicDom(info.isAdmin);

  const hdrBadge = document.getElementById('header-tier-badge');
  const hdrBadgeTxt = document.getElementById('header-tier-badge-text');
  const hdrBadgeTxtShort = document.getElementById('header-tier-badge-text-short');
  const menuTierPill = document.getElementById('account-menu-tier-pill');
  const modalTierPill = document.getElementById('pro-modal-current-tier-pill');
  const modalPreviewBadge = document.getElementById('pro-modal-preview-badge');
  const adminQuickPanel = document.getElementById('admin-quick-tier-panel');
  const adminTabBtn = document.getElementById('pro-tab-btn-admin');
  const btnModalLoginFree = document.getElementById('btn-pro-modal-login-free');
  const btnProSelect = document.getElementById('btn-pro-card-select-pro');
  const btnAdvSelect = document.getElementById('btn-pro-card-select-advisor');
  const reqGuestNotice = document.getElementById('req-guest-login-notice');
  const reqFormWrap = document.getElementById('req-member-form-wrap');
  const myReqsSection = document.getElementById('my-upgrade-requests-section');
  const pdfAdvisorBadge = document.getElementById('pdf-cfg-advisor-pro-badge');

  if (hdrBadgeTxt) {
    hdrBadgeTxt.textContent = info.badgeText;
  }
  if (hdrBadgeTxtShort) {
    // P0-1: Strictly compact & emoji-free on < 640px (GUEST / FREE / PRO / ADVISOR); preview mode distinguished by amber color
    const shortTierMap = { guest: 'GUEST', free: 'FREE', pro: 'PRO', advisor: 'ADVISOR' };
    hdrBadgeTxtShort.textContent = shortTierMap[info.planTier] || 'FREE';
  }
  if (hdrBadge) {
    const basePillCls = 'inline-flex items-center gap-1 px-2 sm:px-2.5 py-1 sm:py-1.5 rounded-xl text-[10.5px] sm:text-[11px] whitespace-nowrap transition cursor-pointer shrink-0';
    if (info.previewTier) {
      hdrBadge.className = `${basePillCls} bg-amber-100 hover:bg-amber-200 text-amber-950 border border-amber-400 font-extrabold`;
    } else if (info.planTier === 'advisor') {
      hdrBadge.className = `${basePillCls} bg-slate-900 hover:bg-slate-800 text-amber-300 border border-amber-400/70 font-extrabold`;
    } else if (info.planTier === 'pro') {
      hdrBadge.className = `${basePillCls} bg-[#E6FBF3] hover:bg-[#00D084]/25 text-[#008A57] border border-[#00D084] font-extrabold`;
    } else if (info.planTier === 'free') {
      hdrBadge.className = `${basePillCls} bg-emerald-50 hover:bg-[#E6FBF3] text-emerald-800 border border-emerald-200 font-bold`;
    } else {
      hdrBadge.className = `${basePillCls} bg-slate-100 hover:bg-[#E6FBF3] text-slate-700 hover:text-[#008A57] border border-slate-200/90 font-bold`;
    }
  }

  const realExpInfo = getExpiryCountdownInfo(info.realPlanTier, info.planExpiresAt, info.daysRemaining, info.isExpired);
  const menuExpiryLine = document.getElementById('account-menu-expiry-line');
  const modalExpiryBanner = document.getElementById('pro-modal-expiry-banner');
  const modalExpiryBannerTxt = document.getElementById('pro-modal-expiry-banner-text');
  const acctPlanLabel = document.getElementById('acct-modal-plan-label');
  const acctExpiryTxt = document.getElementById('acct-modal-expiry-text');
  const cardExpiryNotePro = document.getElementById('pro-card-expiry-note-pro');
  const cardExpiryNoteAdv = document.getElementById('pro-card-expiry-note-advisor');

  if (menuTierPill) {
    menuTierPill.textContent = info.previewTier
      ? `PREVIEW: ${info.previewTier.toUpperCase()}`
      : info.planTier.toUpperCase();
  }

  // Touchpoint 1: Header Account Menu Expiry Line
  if (menuExpiryLine) {
    if (info.previewTier) {
      menuExpiryLine.textContent = `🧪 กำลังจำลองมุมมอง ${info.labelTh}`;
      menuExpiryLine.className = 'text-[10.5px] font-semibold text-amber-700 pl-5 leading-snug';
    } else if (realExpInfo.state === 'expired') {
      menuExpiryLine.textContent = `⚠️ ${realExpInfo.fullText} • กดต่ออายุ`;
      menuExpiryLine.className = 'text-[10.5px] font-bold text-rose-600 pl-5 leading-snug';
    } else if (realExpInfo.state === 'warning') {
      menuExpiryLine.textContent = `⏳ ใกล้หมดอายุ: ${realExpInfo.dateTimeText} (${realExpInfo.countdownText})`;
      menuExpiryLine.className = 'text-[10.5px] font-bold text-amber-700 pl-5 leading-snug';
    } else if (realExpInfo.state === 'active') {
      menuExpiryLine.textContent = `${realExpInfo.fullText}`;
      menuExpiryLine.className = 'text-[10.5px] font-medium text-slate-600 pl-5 leading-snug';
    } else if (realExpInfo.state === 'lifetime') {
      menuExpiryLine.textContent = `✓ ${realExpInfo.fullText}`;
      menuExpiryLine.className = 'text-[10.5px] font-semibold text-emerald-700 pl-5 leading-snug';
    } else {
      menuExpiryLine.textContent = 'สมาชิกฟรีตลอดชีพ • อัปเกรด Pro / Advisor';
      menuExpiryLine.className = 'text-[10.5px] font-medium text-slate-600 pl-5 leading-snug';
    }
  }

  // Touchpoint 2: Membership Modal Header Pill + Near-Expiry/Expired Banner + Active Card Note
  if (modalTierPill) {
    const expTxt = !info.previewTier ? realExpInfo.shortText : '';
    modalTierPill.textContent = `สถานะปัจจุบัน: ${info.labelTh}${expTxt ? ` • ${expTxt}` : ''}`;
    if (!info.previewTier && realExpInfo.state === 'expired') {
      modalTierPill.className = 'px-2.5 py-0.5 rounded-md bg-rose-50 border border-rose-300 text-rose-800 text-[11px] font-bold';
    } else if (!info.previewTier && realExpInfo.state === 'warning') {
      modalTierPill.className = 'px-2.5 py-0.5 rounded-md bg-amber-50 border border-amber-300 text-amber-900 text-[11px] font-bold';
    } else {
      modalTierPill.className = 'px-2.5 py-0.5 rounded-md bg-slate-100 border border-slate-200 text-slate-700 text-[11px] font-bold';
    }
  }
  if (modalExpiryBanner && modalExpiryBannerTxt) {
    if (!info.previewTier && realExpInfo.state === 'warning') {
      modalExpiryBannerTxt.textContent = `⏳ สิทธิ์แพ็กเกจของคุณจะหมดอายุในวันที่ ${realExpInfo.dateTimeText} (${realExpInfo.countdownText}) — ต่ออายุล่วงหน้าได้ทันทีโดยวันเดิมไม่หาย`;
      modalExpiryBanner.className = 'qf-exp-warn p-3 rounded-xl bg-amber-50 border border-amber-300 text-amber-950 text-xs font-semibold flex flex-col sm:flex-row sm:items-center justify-between gap-2 leading-relaxed';
    } else if (!info.previewTier && realExpInfo.state === 'expired') {
      modalExpiryBannerTxt.textContent = `⚠️ แพ็กเกจพรีเมียมของคุณหมดอายุเมื่อ ${realExpInfo.dateTimeText} (พอร์ตที่บันทึกไว้ทั้งหมดยังอยู่ครบ) — กรอกรหัสหรือแจ้งโอนเพื่อต่ออายุได้ทันที`;
      modalExpiryBanner.className = 'qf-exp-expired p-3 rounded-xl bg-rose-50 border border-rose-300 text-rose-900 text-xs font-semibold flex flex-col sm:flex-row sm:items-center justify-between gap-2 leading-relaxed';
    } else {
      modalExpiryBanner.classList.add('hidden');
    }
  }
  if (cardExpiryNotePro) {
    const showProNote = !info.previewTier && info.realPlanTier === 'pro' && realExpInfo.state !== 'none';
    cardExpiryNotePro.classList.toggle('hidden', !showProNote);
    if (showProNote) {
      cardExpiryNotePro.textContent = realExpInfo.state === 'warning'
        ? `⏳ ${realExpInfo.fullText}`
        : realExpInfo.fullText;
    }
  }
  if (cardExpiryNoteAdv) {
    const showAdvNote = !info.previewTier && info.realPlanTier === 'advisor' && realExpInfo.state !== 'none';
    cardExpiryNoteAdv.classList.toggle('hidden', !showAdvNote);
    if (showAdvNote) {
      cardExpiryNoteAdv.textContent = realExpInfo.state === 'warning'
        ? `⏳ ${realExpInfo.fullText}`
        : realExpInfo.fullText;
    }
  }

  // Touchpoint 3: Account Settings Modal Membership Box
  if (acctPlanLabel) {
    acctPlanLabel.textContent = CLIENT_TIER_DEFAULTS[info.realPlanTier]?.labelTh || info.labelTh;
  }
  if (acctExpiryTxt) {
    if (realExpInfo.state === 'expired') {
      acctExpiryTxt.textContent = `⚠️ ${realExpInfo.fullText} (ต่ออายุได้ตลอดเวลา)`;
      acctExpiryTxt.className = 'text-[11px] font-bold text-rose-600 leading-snug';
    } else if (realExpInfo.state === 'warning') {
      acctExpiryTxt.textContent = `⏳ ใกล้หมดอายุ: ${realExpInfo.dateTimeText} (${realExpInfo.countdownText})`;
      acctExpiryTxt.className = 'text-[11px] font-bold text-amber-700 leading-snug';
    } else if (realExpInfo.state === 'active') {
      acctExpiryTxt.textContent = realExpInfo.fullText;
      acctExpiryTxt.className = 'text-[11px] font-semibold text-emerald-700 leading-snug';
    } else if (realExpInfo.state === 'lifetime') {
      acctExpiryTxt.textContent = `✓ ${realExpInfo.fullText}`;
      acctExpiryTxt.className = 'text-[11px] font-semibold text-emerald-700 leading-snug';
    } else {
      acctExpiryTxt.textContent = 'สมาชิกฟรีตลอดชีพ';
      acctExpiryTxt.className = 'text-[11px] font-medium text-slate-600 leading-snug';
    }
  }

  if (modalPreviewBadge) {
    modalPreviewBadge.classList.toggle('hidden', !info.previewTier);
  }

  // Sync Admin visibility & 5-state safe preview buttons (both Header Dropdown & Modal Admin Tab)
  const activePreviewKey = info.previewTier || 'real';
  if (adminQuickPanel) {
    adminQuickPanel.classList.toggle('hidden', !info.isAdmin);
    ['real', 'guest', 'free', 'pro', 'advisor'].forEach(k => {
      const btn = document.getElementById(`admin-switch-btn-${k}`);
      if (btn) {
        const isAct = activePreviewKey === k;
        const colSpan = k === 'advisor' ? 'col-span-2 ' : '';
        btn.className = isAct
          ? `${colSpan}px-1.5 py-1 rounded-lg bg-[#00D084] text-[#0A0D12] text-[10px] font-extrabold transition cursor-pointer`
          : `${colSpan}px-1.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-[10px] font-semibold text-slate-200 transition cursor-pointer`;
      }
    });
  }
  if (adminTabBtn) {
    adminTabBtn.classList.toggle('hidden', !info.isAdmin);
  }
  ['real', 'guest', 'free', 'pro', 'advisor'].forEach(k => {
    const btn = document.getElementById(`admin-preview-btn-${k}`);
    if (btn) {
      const isAct = activePreviewKey === k;
      const labels = {
        real: 'สิทธิ์จริงของฉัน',
        guest: 'Guest (5 หุ้น)',
        free: 'Member ฟรี (8 หุ้น)',
        pro: 'QuantFolio Pro (15 หุ้น)',
        advisor: 'Advisor Pro (25 หุ้น)'
      };
      btn.textContent = isAct ? `✓ ${labels[k]}` : labels[k];
      btn.className = isAct
        ? 'px-3 py-1.5 rounded-lg bg-[#00D084] text-[#0A0D12] font-extrabold text-[11px] ring-2 ring-[#00D084]/40 transition cursor-pointer'
        : 'px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-[11px] transition cursor-pointer';
    }
  });

  // Highlight active plan card & update CTA button text cleanly (supports Lifetime disabled guard)
  const isLoggedIn = Boolean(currentUser && currentUser.id);
  const effectiveCardTier = info.planTier;
  const isRealLifetime = isLoggedIn && !info.previewTier && !info.planExpiresAt;
  if (btnModalLoginFree) {
    if (!isLoggedIn || effectiveCardTier === 'guest') {
      btnModalLoginFree.textContent = 'สมัคร / เข้าสู่ระบบฟรี ➔';
      btnModalLoginFree.disabled = false;
      btnModalLoginFree.className = 'w-full min-h-[40px] py-2 px-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs transition cursor-pointer';
    } else if (effectiveCardTier === 'free') {
      btnModalLoginFree.textContent = '✓ แพ็กเกจปัจจุบันของคุณ';
      btnModalLoginFree.disabled = true;
      btnModalLoginFree.className = 'w-full min-h-[40px] py-2 px-3 rounded-xl bg-emerald-100 text-emerald-900 border border-emerald-300 font-extrabold text-xs cursor-default';
    } else {
      btnModalLoginFree.textContent = '✓ รวมอยู่ในแพ็กเกจปัจจุบัน';
      btnModalLoginFree.disabled = true;
      btnModalLoginFree.className = 'w-full min-h-[40px] py-2 px-3 rounded-xl bg-slate-200/80 text-slate-600 font-bold text-xs cursor-default';
    }
  }
  if (btnProSelect) {
    if (effectiveCardTier === 'pro') {
      if (isRealLifetime) {
        btnProSelect.textContent = '✓ แพ็กเกจปัจจุบัน (สิทธิ์ถาวร)';
        btnProSelect.disabled = true;
        btnProSelect.className = 'w-full min-h-[40px] py-2 px-3 rounded-xl bg-emerald-100 text-emerald-900 border border-[#00D084] font-extrabold text-xs cursor-default';
      } else {
        btnProSelect.textContent = '✓ แพ็กเกจปัจจุบัน (ต่ออายุ / กรอกรหัส)';
        btnProSelect.disabled = false;
        btnProSelect.className = 'w-full min-h-[40px] py-2 px-3 rounded-xl bg-emerald-100 hover:bg-emerald-200 text-emerald-900 border border-[#00D084] font-extrabold text-xs transition cursor-pointer';
      }
    } else if (effectiveCardTier === 'advisor') {
      btnProSelect.textContent = '✓ รวมอยู่ใน Advisor Pro แล้ว';
      btnProSelect.disabled = true;
      btnProSelect.className = 'w-full min-h-[40px] py-2 px-3 rounded-xl bg-slate-200/80 text-slate-600 font-bold text-xs cursor-default';
    } else {
      btnProSelect.textContent = 'อัปเกรดเป็น QuantFolio Pro ➔';
      btnProSelect.disabled = false;
      btnProSelect.className = 'w-full min-h-[40px] py-2 px-3 rounded-xl bg-[#00D084] hover:bg-[#00B873] text-[#0A0D12] font-extrabold text-xs transition cursor-pointer';
    }
  }
  if (btnAdvSelect) {
    if (effectiveCardTier === 'advisor') {
      if (isRealLifetime) {
        btnAdvSelect.textContent = '✓ แพ็กเกจปัจจุบัน (สิทธิ์ถาวร)';
        btnAdvSelect.disabled = true;
        btnAdvSelect.className = 'w-full min-h-[40px] py-2 px-3 rounded-xl bg-amber-300/20 text-amber-200 border border-amber-400/70 font-extrabold text-xs cursor-default';
      } else {
        btnAdvSelect.textContent = '✓ แพ็กเกจปัจจุบัน (ต่ออายุ / กรอกรหัส)';
        btnAdvSelect.disabled = false;
        btnAdvSelect.className = 'w-full min-h-[40px] py-2 px-3 rounded-xl bg-amber-300/20 hover:bg-amber-300/30 text-amber-200 border border-amber-400/70 font-extrabold text-xs transition cursor-pointer';
      }
    } else {
      btnAdvSelect.textContent = 'อัปเกรดเป็น Advisor Pro ➔';
      btnAdvSelect.disabled = false;
      btnAdvSelect.className = 'w-full min-h-[40px] py-2 px-3 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 font-extrabold text-xs transition cursor-pointer';
    }
  }

  // Sync Tab 2 upgrade request form guest/member state
  if (reqGuestNotice && reqFormWrap) {
    reqGuestNotice.classList.toggle('hidden', isLoggedIn);
    reqFormWrap.classList.toggle('hidden', !isLoggedIn);
  }
  if (myReqsSection && !isLoggedIn) {
    myReqsSection.classList.add('hidden');
  }

  // Sync PDF Modal Advisor Pro badge
  if (pdfAdvisorBadge) {
    if (info.canWhitelabelAdvisorPdf) {
      pdfAdvisorBadge.textContent = '✓ ปลดล็อกแล้ว';
      pdfAdvisorBadge.className = 'px-1.5 py-0.2 rounded bg-emerald-100 text-emerald-900 border border-emerald-300 text-[9.5px] font-extrabold';
    } else {
      pdfAdvisorBadge.textContent = 'ADVISOR PRO';
      pdfAdvisorBadge.className = 'px-1.5 py-0.2 rounded bg-amber-400 text-slate-950 text-[9.5px] font-extrabold';
    }
  }

  // Enforce workspace limits & safe BL caps immediately on tier/preview switch
  if (window.state) {
    if (Array.isArray(window.state.tickers) && window.state.tickers.length > info.maxAssets) {
      window.state.tickers = window.state.tickers.slice(0, info.maxAssets);
    }
    if (!info.canViewNews && window.state.useNewsAdjustment) {
      window.state.useNewsAdjustment = false;
    }
    if (!info.canCustomizeBlViews) {
      window.state.blConfidence = Math.min(Number(window.state.blConfidence || 0.35), Number(info.safeBlConfidenceCap || 0.35));
      window.state.blViews = null;
    }
  }

  if (typeof window.renderTickersList === 'function') {
    window.renderTickersList();
  }
  if (window.state && window.state.optData) {
    if (info.canViewNews && window.state.optData.market_intelligence?.news_locked_guest) {
      delete window.state.optData.market_intelligence.news_locked_guest;
      if (typeof window.refreshLiveMarketNews === 'function') {
        window.refreshLiveMarketNews();
      }
    } else if (typeof window.renderNewsAndSignalSection === 'function') {
      window.renderNewsAndSignalSection();
    }
  }
  if (typeof window.syncPdfReportModeFields === 'function') {
    window.syncPdfReportModeFields();
  }
}

function switchProModalTab(tabKey = 'plans') {
  const info = getUserTierInfo();
  const resolved = (tabKey === 'admin' && !info.isAdmin)
    ? 'plans'
    : (['plans', 'activate', 'admin'].includes(tabKey) ? tabKey : 'plans');
  activeProModalTab = resolved;

  ['plans', 'activate', 'admin'].forEach(k => {
    const btn = document.getElementById(`pro-tab-btn-${k}`);
    const panel = document.getElementById(`pro-tab-panel-${k}`);
    const isAct = k === resolved;
    if (btn) {
      btn.classList.toggle('active', isAct);
      btn.classList.toggle('font-bold', isAct);
      btn.classList.toggle('font-semibold', !isAct);
      btn.setAttribute('aria-selected', isAct ? 'true' : 'false');
    }
    if (panel) {
      panel.classList.toggle('hidden', !isAct);
    }
  });

  if (resolved === 'activate' && currentUser && currentUser.id) {
    loadMyUpgradeRequests();
  } else if (resolved === 'admin' && info.isAdmin) {
    loadAdminConsoleOverview();
  }
}

function switchAdminSubTab(subKey = 'requests') {
  const resolved = ['requests', 'users', 'codes'].includes(subKey) ? subKey : 'requests';
  activeAdminSubTab = resolved;
  ['requests', 'users', 'codes'].forEach(k => {
    const btn = document.getElementById(`admin-subtab-btn-${k}`);
    const panel = document.getElementById(`admin-subpanel-${k}`);
    const isAct = k === resolved;
    if (btn) {
      btn.classList.toggle('active', isAct);
      btn.classList.toggle('font-bold', isAct);
      btn.classList.toggle('font-semibold', !isAct);
    }
    if (panel) {
      panel.classList.toggle('hidden', !isAct);
    }
  });
}

function setProBillingCycle(cycle = 'yearly') {
  const clean = cycle === 'monthly' ? 'monthly' : 'yearly';
  activeProBillingCycle = clean;

  ['monthly', 'yearly'].forEach(key => {
    const btn = document.getElementById(`pro-billing-btn-${key}`);
    const isAct = key === clean;
    if (btn) {
      btn.classList.toggle('active', isAct);
      btn.classList.toggle('font-bold', isAct);
      btn.classList.toggle('font-semibold', !isAct);
      btn.setAttribute('aria-checked', isAct ? 'true' : 'false');
    }
  });

  ['pro', 'advisor'].forEach(tierKey => {
    const planCfg = PRO_PRICING_PLANS[tierKey][clean];
    const valEl = document.getElementById(`pro-price-value-${tierKey}`);
    const subEl = document.getElementById(`pro-price-sub-${tierKey}`);
    const strikeEl = document.getElementById(`pro-price-strike-${tierKey}`);
    if (valEl) valEl.textContent = planCfg.display;
    if (subEl) subEl.textContent = planCfg.subText;
    if (strikeEl) strikeEl.classList.toggle('hidden', !planCfg.strike);
  });
}

function toggleProCoreFeatures(forceState = null) {
  isProCoreFeaturesExpanded = typeof forceState === 'boolean' ? forceState : !isProCoreFeaturesExpanded;
  document.querySelectorAll('#pro-tab-panel-plans .qf-plan-core-features').forEach(el => {
    el.classList.toggle('hidden', !isProCoreFeaturesExpanded);
  });
  const btn = document.getElementById('btn-toggle-core-features');
  if (btn) {
    btn.setAttribute('aria-expanded', isProCoreFeaturesExpanded ? 'true' : 'false');
    btn.textContent = isProCoreFeaturesExpanded ? 'ซ่อนรายละเอียด ⌃' : 'แสดงคุณสมบัติพื้นฐานทั้งหมดที่รวมอยู่ ⌄';
  }
}

function syncUpgradeRequestPriceHint() {
  const tierVal = document.getElementById('req-target-tier')?.value === 'advisor' ? 'advisor' : 'pro';
  const durVal = parseInt(document.getElementById('req-duration-days')?.value || '365', 10) || 365;
  const plan = PRO_PRICING_PLANS[tierVal];
  let totalAmt = plan.yearly.total;
  let extraNote = tierVal === 'advisor' ? ' • ประหยัด ฿3,600/ปี' : ' • ประหยัด ฿720/ปี';
  if (durVal === 30) {
    totalAmt = plan.monthly.total;
    extraNote = ' • รายเดือน';
  } else if (durVal === 90) {
    totalAmt = plan.quarterlyTotal;
    extraNote = ' • 3 เดือน';
  }
  const formattedAmt = totalAmt.toLocaleString('en-US');
  const amtInput = document.getElementById('req-transfer-amount');
  if (amtInput) {
    amtInput.placeholder = `เช่น ${totalAmt}.00`;
  }
  const hintEl = document.getElementById('req-expected-amount-hint');
  if (hintEl) {
    hintEl.innerHTML = `💡 ยอดโอนแนะนำ: <b>฿${escapeHtml(formattedAmt)}</b> สำหรับ ${escapeHtml(plan.name)} (${escapeHtml(durVal)} วัน${escapeHtml(extraNote)})`;
  }
}

function selectUpgradeTargetTier(targetTier) {
  const reqSel = document.getElementById('req-target-tier');
  if (reqSel && (targetTier === 'pro' || targetTier === 'advisor')) {
    reqSel.value = targetTier;
  }
  const durSel = document.getElementById('req-duration-days');
  if (durSel) {
    durSel.value = activeProBillingCycle === 'monthly' ? '30' : '365';
  }
  syncUpgradeRequestPriceHint();
  switchProModalTab('activate');
  setTimeout(() => {
    document.getElementById('pro-activation-code-input')?.focus();
  }, 50);
}

function selectEnterpriseInquiry() {
  const reqSel = document.getElementById('req-target-tier');
  const durSel = document.getElementById('req-duration-days');
  if (reqSel) reqSel.value = 'advisor';
  if (durSel) durSel.value = '365';
  syncUpgradeRequestPriceHint();
  switchProModalTab('activate');
  setTimeout(() => {
    const noteEl = document.getElementById('req-contact-note');
    if (noteEl) {
      noteEl.placeholder = 'ระบุจำนวนสิทธิ์ (Activation Codes) ชื่อองค์กร / Line ID หรืออีเมลติดต่อ';
      noteEl.focus();
    }
  }, 60);
}

function openProUpgradeModal(reasonText = '', highlightTier = 'pro', initialTab = 'plans') {
  syncMembershipTierBadgesUI();
  setProBillingCycle(activeProBillingCycle);
  const modal = document.getElementById('pro-upgrade-modal');
  if (!modal) return;

  const reasonBanner = document.getElementById('pro-upgrade-reason-banner');
  if (reasonBanner) {
    if (reasonText) {
      reasonBanner.textContent = reasonText;
      reasonBanner.classList.remove('hidden');
    } else {
      reasonBanner.textContent = '';
      reasonBanner.classList.add('hidden');
    }
  }

  showInlineModalAlert('pro-upgrade-alert', '');
  showInlineModalAlert('req-submit-alert', '');
  showInlineModalAlert('admin-console-alert', '');

  const reqSel = document.getElementById('req-target-tier');
  if (reqSel && (highlightTier === 'pro' || highlightTier === 'advisor')) {
    reqSel.value = highlightTier;
  }
  const durSel = document.getElementById('req-duration-days');
  if (durSel) {
    durSel.value = activeProBillingCycle === 'monthly' ? '30' : '365';
  }
  syncUpgradeRequestPriceHint();

  modal.classList.remove('hidden');
  switchProModalTab(initialTab);
  if (getUserTierInfo().isAdmin && initialTab !== 'admin') {
    loadAdminConsoleOverview({ silent: true });
  }
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}

function closeProUpgradeModal() {
  const modal = document.getElementById('pro-upgrade-modal');
  if (modal) modal.classList.add('hidden');
}

async function submitActivationCodeUpgrade() {
  showInlineModalAlert('pro-upgrade-alert', '');

  if (!currentUser || !currentUser.id) {
    closeProUpgradeModal();
    openSupabaseConfigModal('signin');
    showPortfolioToast('กรุณาเข้าสู่ระบบหรือสมัครสมาชิกฟรีก่อนกรอกรหัสเปิดใช้งาน');
    return;
  }

  const codeInp = document.getElementById('pro-activation-code-input');
  const code = (codeInp?.value || '').trim().toUpperCase();
  const btn = document.getElementById('btn-submit-activation-code');

  if (!code) {
    showInlineModalAlert('pro-upgrade-alert', 'กรุณากรอกรหัสเปิดใช้งาน (Activation Code) เช่น QF-PRO-XXXX-XXXX', 'error');
    codeInp?.focus();
    return;
  }

  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'กำลังตรวจสอบรหัส...';
    }
    const res = await fetch('/api/auth/redeem-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getBackendAuthHeaders() },
      body: JSON.stringify({ code })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.detail || 'รหัสเปิดใช้งานไม่ถูกต้องหรือหมดอายุแล้ว');
    }
    if (data.user) {
      currentUser = {
        ...currentUser,
        ...data.user,
        token: currentUser.token || localStorage.getItem('qf_verified_session_token')
      };
      // Session user kept strictly in memory; only session token is persisted in localStorage
      updateAuthUI(currentUser);
    }
    if (codeInp) codeInp.value = '';
    const durTxt = Number(data.duration_days || 0) > 0 ? ` (+${data.duration_days} วัน)` : ' (ถาวร)';
    const tierLabel = CLIENT_TIER_DEFAULTS[data.applied_tier]?.labelTh || 'Pro';
    showInlineModalAlert('pro-upgrade-alert', `✓ เปิดใช้งานรหัสสำเร็จ! บัญชีของคุณได้รับสิทธิ์ ${tierLabel}${durTxt} แล้ว`, 'success');
    showPortfolioToast(`ปลดล็อก ${tierLabel}${durTxt} สำเร็จแล้ว!`);
    if (getUserTierInfo().isAdmin) {
      loadAdminConsoleOverview({ silent: true });
    }
  } catch (err) {
    showInlineModalAlert('pro-upgrade-alert', err.message || 'ไม่สามารถเปิดใช้งานรหัสได้', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'ยืนยันรหัสเปิดใช้งาน ➔';
    }
  }
}

async function submitUpgradeRequest() {
  showInlineModalAlert('req-submit-alert', '');
  if (!currentUser || !currentUser.id) {
    closeProUpgradeModal();
    openSupabaseConfigModal('signin');
    return;
  }

  const targetTier = document.getElementById('req-target-tier')?.value || 'pro';
  const durationDays = parseInt(document.getElementById('req-duration-days')?.value || '30', 10) || 30;
  const transferAmount = (document.getElementById('req-transfer-amount')?.value || '').trim();
  const transferDatetime = (document.getElementById('req-transfer-datetime')?.value || '').trim();
  const accountLast4 = (document.getElementById('req-account-last4')?.value || '').trim();
  const slipRef = (document.getElementById('req-slip-ref')?.value || '').trim();
  const contactNote = (document.getElementById('req-contact-note')?.value || '').trim();
  const btn = document.getElementById('btn-submit-upgrade-request');

  if (!transferAmount || !transferDatetime) {
    showInlineModalAlert('req-submit-alert', 'กรุณากรอกยอดเงินที่โอนและวัน–เวลาที่โอนให้ครบถ้วน', 'error');
    return;
  }

  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'กำลังส่งแจ้งโอน...';
    }
    const res = await fetch('/api/upgrade-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getBackendAuthHeaders() },
      body: JSON.stringify({
        target_tier: targetTier,
        duration_days: durationDays,
        transfer_amount: transferAmount,
        transfer_datetime: transferDatetime,
        account_last4: accountLast4,
        slip_ref: slipRef,
        contact_note: contactNote
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.detail || 'ไม่สามารถส่งคำขออัปเกรดได้');
    }
    ['req-transfer-amount', 'req-transfer-datetime', 'req-account-last4', 'req-slip-ref', 'req-contact-note'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    showInlineModalAlert('req-submit-alert', '✓ ส่งข้อมูลแจ้งโอนเข้าคิวตรวจสอบแล้ว ผู้ดูแลจะตรวจสอบและอนุมัติสิทธิ์ให้เร็วที่สุด', 'success');
    showPortfolioToast('ส่งแจ้งโอนเรียบร้อยแล้ว รอผู้ดูแลตรวจสอบ');
    await loadMyUpgradeRequests();
    if (getUserTierInfo().isAdmin) {
      loadAdminConsoleOverview({ silent: true });
    }
  } catch (err) {
    showInlineModalAlert('req-submit-alert', err.message || 'เกิดข้อผิดพลาดในการส่งคำขอ', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'ส่งแจ้งโอนให้ผู้ดูแลตรวจสอบ';
    }
  }
}

async function loadMyUpgradeRequests() {
  const section = document.getElementById('my-upgrade-requests-section');
  const listEl = document.getElementById('my-upgrade-requests-list');
  if (!section || !listEl || !currentUser || !currentUser.id) return;

  try {
    const res = await fetch('/api/upgrade-requests/mine', { headers: getBackendAuthHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    const items = Array.isArray(data.requests) ? data.requests : [];
    if (items.length === 0) {
      section.classList.add('hidden');
      return;
    }
    section.classList.remove('hidden');
    listEl.innerHTML = items.map(r => {
      const tierName = r.target_tier === 'advisor' ? 'Advisor Pro (IC/IP)' : 'QuantFolio Pro';
      const st = String(r.status || 'pending');
      const stBadge = st === 'approved'
        ? '<span class="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold text-[10px]">✓ อนุมัติแล้ว</span>'
        : st === 'rejected'
        ? '<span class="px-2 py-0.5 rounded-full bg-rose-100 text-rose-800 font-bold text-[10px]">✕ ปฏิเสธ</span>'
        : '<span class="px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 font-bold text-[10px]">⏳ รอตรวจสอบ</span>';
      const safeId = escapeHtml(r.id);
      const cancelBtn = st === 'pending'
        ? `<button type="button" data-req-id="${safeId}" onclick="cancelMyUpgradeRequest(this.dataset.reqId)" class="px-2.5 py-1 rounded-lg bg-white hover:bg-rose-50 text-rose-600 border border-rose-200 text-[10.5px] font-bold transition cursor-pointer">ยกเลิกคำขอ</button>`
        : '';
      const adminNoteHtml = r.admin_note
        ? `<div class="text-[11px] text-slate-500 mt-1">หมายเหตุจากผู้ดูแล: ${escapeHtml(r.admin_note)}</div>`
        : '';
      return `
        <div class="p-3 rounded-xl bg-white border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div class="space-y-0.5">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-bold text-slate-900">${escapeHtml(tierName)} (${escapeHtml(r.duration_days)} วัน)</span>
              ${stBadge}
            </div>
            <div class="text-[11px] text-slate-500 font-mono">
              ยอดโอน: ${escapeHtml(r.transfer_amount || '-')} • เวลา: ${escapeHtml(r.transfer_datetime || '-')}${r.account_last4 ? ` • บัญชีลงท้าย ${escapeHtml(r.account_last4)}` : ''}
            </div>
            ${adminNoteHtml}
          </div>
          <div class="shrink-0">${cancelBtn}</div>
        </div>
      `;
    }).join('');
  } catch (e) {
    console.warn('Load my upgrade requests notice:', e);
  }
}

async function cancelMyUpgradeRequest(reqId) {
  if (!reqId) return;
  try {
    const res = await fetch(`/api/upgrade-requests/${encodeURIComponent(reqId)}`, {
      method: 'DELETE',
      headers: getBackendAuthHeaders()
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || 'ไม่สามารถยกเลิกคำขอได้');
    showPortfolioToast('ยกเลิกคำขออัปเกรดที่รออนุมัติแล้ว');
    await loadMyUpgradeRequests();
    if (getUserTierInfo().isAdmin) {
      loadAdminConsoleOverview({ silent: true });
    }
  } catch (err) {
    showInlineModalAlert('req-submit-alert', err.message || 'ไม่สามารถยกเลิกคำขอได้', 'error');
  }
}

/**
 * Safe Non-Destructive Admin Preview Switcher (sessionStorage + X-QF-Admin-Preview-Tier header)
 * Never modifies real DB plan_tier or revokes Admin privileges!
 */
async function adminSetPreviewTier(targetTier) {
  if (!currentUser || !getUserTierInfo().isAdmin) return;
  const clean = String(targetTier || 'real').trim().toLowerCase();
  if (clean === 'real' || !['guest', 'free', 'pro', 'advisor'].includes(clean)) {
    sessionStorage.removeItem('qf_admin_preview_tier');
  } else {
    sessionStorage.setItem('qf_admin_preview_tier', clean);
  }

  // Sync with /api/auth/me so backend & frontend entitlements match 100%
  try {
    const res = await fetch('/api/auth/me', { headers: getBackendAuthHeaders() });
    if (res.ok) {
      const data = await res.json();
      if (data && data.user) {
        currentUser = {
          ...currentUser,
          ...data.user,
          token: currentUser.token || localStorage.getItem('qf_verified_session_token')
        };
        // Session user kept strictly in memory; only session token is persisted in localStorage
      }
    }
  } catch (e) {}

  updateAuthUI(currentUser);
  const info = getUserTierInfo();
  const msg = info.previewTier
    ? `🧪 กำลังจำลองมุมมอง: ${info.labelTh} (สิทธิ์จริงของคุณไม่ถูกเปลี่ยน)`
    : `✓ กลับสู่สิทธิ์จริงของคุณ (${info.labelTh}) แล้ว`;
  showPortfolioToast(msg);
  showInlineModalAlert('admin-console-alert', msg, info.previewTier ? 'warning' : 'success');
}

async function adminQuickSwitchOwnTier(targetTier) {
  return adminSetPreviewTier(targetTier);
}

async function loadAdminConsoleOverview(opts = {}) {
  if (!currentUser || !getUserTierInfo().isAdmin) return;
  try {
    const res = await fetch('/api/admin/overview', { headers: getBackendAuthHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (!opts.silent) {
        showInlineModalAlert('admin-console-alert', data.detail || 'ไม่สามารถโหลดข้อมูลแผงจัดการแอดมินได้', 'error');
      }
      return;
    }
    adminConsoleCache = {
      users: Array.isArray(data.users) ? data.users : [],
      upgrade_requests: Array.isArray(data.upgrade_requests) ? data.upgrade_requests : [],
      activation_codes: Array.isArray(data.activation_codes) ? data.activation_codes : [],
      pending_requests_count: Number(data.pending_requests_count || 0)
    };

    const pendingBadge = document.getElementById('admin-pending-badge');
    const reqCountEl = document.getElementById('admin-subtab-req-count');
    const usersCountEl = document.getElementById('admin-subtab-users-count');
    const codesCountEl = document.getElementById('admin-subtab-codes-count');

    if (pendingBadge) {
      pendingBadge.textContent = String(adminConsoleCache.pending_requests_count);
      pendingBadge.classList.toggle('hidden', adminConsoleCache.pending_requests_count <= 0);
    }
    if (reqCountEl) reqCountEl.textContent = String(adminConsoleCache.pending_requests_count);
    if (usersCountEl) usersCountEl.textContent = String(adminConsoleCache.users.length);
    if (codesCountEl) codesCountEl.textContent = String(adminConsoleCache.activation_codes.length);

    adminRenderRequestsList();
    adminRenderUsersTable();
    adminRenderCodesTable();
  } catch (err) {
    if (!opts.silent) {
      showInlineModalAlert('admin-console-alert', err.message || 'เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์', 'error');
    }
  }
}

function adminRenderRequestsList() {
  const container = document.getElementById('admin-requests-container');
  if (!container) return;
  const list = adminConsoleCache.upgrade_requests || [];
  if (list.length === 0) {
    container.innerHTML = `
      <div class="p-5 rounded-xl bg-slate-50 border border-slate-200 text-center text-slate-500">
        ยังไม่มีคำขอแจ้งโอน / อัปเกรดเข้ามาในระบบ
      </div>
    `;
    return;
  }

  container.innerHTML = list.map(r => {
    const safeId = escapeHtml(r.id);
    const safeEmail = escapeHtml(r.email);
    const safeName = escapeHtml(r.full_name || r.email);
    const tierName = r.target_tier === 'advisor' ? 'Advisor Pro (IC/IP)' : 'QuantFolio Pro';
    const st = String(r.status || 'pending');
    const stPill = st === 'approved'
      ? '<span class="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-900 font-bold text-[10.5px]">✓ อนุมัติแล้ว</span>'
      : st === 'rejected'
      ? '<span class="px-2 py-0.5 rounded-full bg-rose-100 text-rose-800 font-bold text-[10.5px]">✕ ปฏิเสธแล้ว</span>'
      : '<span class="px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 font-bold text-[10.5px]">⏳ รอตรวจสอบ</span>';

    // Strict XSS Prevention: escape all user fields & allow ONLY https:// for clickable slip links
    const httpsSlipUrl = sanitizeHttpsOnlyUrl(r.slip_ref);
    const slipHtml = httpsSlipUrl
      ? `<a href="${escapeHtml(httpsSlipUrl)}" target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline font-semibold break-all">เปิดลิงก์สลิป (HTTPS) ↗</a>`
      : (r.slip_ref ? `<span class="font-mono text-slate-700 break-all">${escapeHtml(r.slip_ref)}</span>` : '<span class="text-slate-400">—</span>');

    const actionsHtml = st === 'pending'
      ? `
        <div class="flex flex-wrap items-center gap-1.5 pt-2 border-t border-slate-200/70">
          <button type="button" data-req-id="${safeId}" onclick="adminDecideUpgradeRequest(this.dataset.reqId, 'approve')" class="px-3 py-1.5 rounded-lg bg-[#00D084] hover:bg-[#00B873] text-[#0A0D12] font-extrabold text-[11px] transition cursor-pointer">
            ✓ อนุมัติ &amp; ทบ ${escapeHtml(r.duration_days)} วัน
          </button>
          <button type="button" data-req-id="${safeId}" onclick="adminDecideUpgradeRequest(this.dataset.reqId, 'reject')" class="px-3 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 font-bold text-[11px] transition cursor-pointer">
            ปฏิเสธคำขอ
          </button>
        </div>
      `
      : `<div class="text-[11px] text-slate-400 pt-1">ดำเนินการเมื่อ: ${escapeHtml(formatShortDateTh(r.decided_at))}${r.admin_note ? ` • หมายเหตุ: ${escapeHtml(r.admin_note)}` : ''}</div>`;

    return `
      <div class="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-bold text-slate-900">${safeName}</span>
            <span class="font-mono text-[11px] text-slate-500">(${safeEmail})</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="px-2 py-0.5 rounded-md bg-slate-900 text-[#34F5A8] font-bold text-[10.5px]">${escapeHtml(tierName)} • ${escapeHtml(r.duration_days)} วัน</span>
            ${stPill}
          </div>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-[11px] text-slate-600">
          <div><span class="text-slate-400">ยอดโอน:</span> <b class="font-mono text-slate-900">฿${escapeHtml(r.transfer_amount || '-')}</b></div>
          <div><span class="text-slate-400">วัน–เวลาโอน:</span> <b class="font-mono text-slate-900">${escapeHtml(r.transfer_datetime || '-')}</b></div>
          <div><span class="text-slate-400">บัญชี 4 ตัวท้าย:</span> <b class="font-mono text-slate-900">${escapeHtml(r.account_last4 || '—')}</b></div>
          <div><span class="text-slate-400">สลิป/อ้างอิง:</span> ${slipHtml}</div>
        </div>
        ${r.contact_note ? `<div class="text-[11px] text-slate-600"><span class="text-slate-400">หมายเหตุ/ติดต่อ:</span> ${escapeHtml(r.contact_note)}</div>` : ''}
        ${actionsHtml}
      </div>
    `;
  }).join('');
}

function adminFilterUsersTable() {
  adminRenderUsersTable();
}

function adminRenderUsersTable() {
  const tbody = document.getElementById('admin-users-table-body');
  if (!tbody) return;
  const query = (document.getElementById('admin-users-search-input')?.value || '').trim().toLowerCase();
  const filtered = (adminConsoleCache.users || []).filter(u => {
    if (!query) return true;
    return String(u.email || '').toLowerCase().includes(query) || String(u.full_name || '').toLowerCase().includes(query);
  });

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="py-5 text-center text-slate-500">ไม่พบสมาชิกที่ตรงกับคำค้นหา</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map((u, idx) => {
    const safeEmail = escapeHtml(u.email);
    const safeName = escapeHtml(u.full_name || u.email);
    const tier = String(u.plan_tier || 'free');
    const tierPill = tier === 'advisor'
      ? '<span class="px-2 py-0.5 rounded-md bg-amber-100 text-amber-950 border border-amber-300 font-extrabold text-[10.5px] whitespace-nowrap">★ Advisor Pro</span>'
      : tier === 'pro'
      ? '<span class="px-2 py-0.5 rounded-md bg-[#E6FBF3] text-[#008A57] border border-[#00D084]/40 font-extrabold text-[10.5px] whitespace-nowrap">✦ QuantFolio Pro</span>'
      : '<span class="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 border border-slate-200 font-bold text-[10.5px] whitespace-nowrap">Member ฟรี</span>';
    const adminTag = u.is_admin
      ? '<span class="ml-1 px-1.5 py-0.2 rounded bg-slate-900 text-[#34F5A8] font-mono text-[9.5px] font-extrabold">ADMIN</span>'
      : '';
    const expInfo = getExpiryCountdownInfo(tier, u.plan_expires_at, u.days_remaining, u.is_expired);
    let expTxt = '<span class="text-slate-400">—</span>';
    if (expInfo.state === 'expired') {
      expTxt = `
        <div class="text-rose-600 font-bold text-[11px] whitespace-nowrap">หมดอายุแล้ว</div>
        <div class="font-mono text-[10px] text-slate-500 whitespace-nowrap">${escapeHtml(expInfo.dateTimeText)}</div>
      `;
    } else if (expInfo.state === 'lifetime') {
      expTxt = '<span class="font-mono text-[11px] font-semibold text-emerald-700 whitespace-nowrap">ถาวร</span>';
    } else if (expInfo.state === 'warning') {
      expTxt = `
        <div class="text-amber-700 font-bold text-[11px] whitespace-nowrap">⏳ ${escapeHtml(expInfo.countdownText)}</div>
        <div class="font-mono text-[10px] text-slate-500 whitespace-nowrap">${escapeHtml(expInfo.dateTimeText)}</div>
      `;
    } else if (expInfo.state === 'active') {
      expTxt = `
        <div class="font-bold text-slate-800 text-[11px] whitespace-nowrap">${escapeHtml(expInfo.countdownText)}</div>
        <div class="font-mono text-[10px] text-slate-500 whitespace-nowrap">${escapeHtml(expInfo.dateTimeText)}</div>
      `;
    }
    const defaultCustomVal = escapeHtml(formatBangkokDatetimeLocalValue(u.plan_expires_at));

    return `
      <tr class="hover:bg-slate-50/90 transition" data-user-row="${idx}">
        <td class="py-2.5 px-3">
          <div class="font-bold text-slate-900 flex items-center flex-wrap gap-1">${safeName}${adminTag}</div>
          <div class="font-mono text-[11px] text-slate-500 break-all">${safeEmail}</div>
        </td>
        <td class="py-2.5 px-3">${tierPill}</td>
        <td class="py-2.5 px-3">${expTxt}</td>
        <td class="py-2.5 px-3 text-center font-mono font-bold text-slate-700">${Number(u.portfolio_count || 0)}</td>
        <td class="py-2.5 px-3">
          <div class="flex items-center gap-1.5 flex-wrap">
            <select data-role="tier-sel" class="px-2 py-1 rounded-lg bg-white border border-slate-300 text-[11px] font-bold text-slate-900">
              <option value="free" ${tier === 'free' ? 'selected' : ''}>Member ฟรี</option>
              <option value="pro" ${tier === 'pro' ? 'selected' : ''}>QuantFolio Pro</option>
              <option value="advisor" ${tier === 'advisor' ? 'selected' : ''}>Advisor Pro</option>
            </select>
            <select data-role="dur-sel" onchange="adminToggleCustomExpiryInput(this)" class="px-2 py-1 rounded-lg bg-white border border-slate-300 text-[11px] font-semibold text-slate-900">
              <option value="30">+30 วัน</option>
              <option value="90">+90 วัน</option>
              <option value="365">+365 วัน</option>
              <option value="0">ถาวร</option>
              <option value="custom">กำหนดวัน–เวลาเอง</option>
            </select>
            <input type="datetime-local" data-role="custom-exp-input" value="${defaultCustomVal}" title="วัน–เวลาหมดอายุ (เวลาไทย UTC+7)" class="hidden px-2 py-1 rounded-lg bg-white border border-slate-300 text-[11px] font-mono text-slate-900" />
            <button type="button" data-email="${safeEmail}" onclick="adminUpdateUserRowTier(this)" class="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-[#00D084] hover:text-[#0A0D12] text-white font-bold text-[11px] transition cursor-pointer whitespace-nowrap">
              บันทึก
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function adminRenderCodesTable() {
  const tbody = document.getElementById('admin-codes-table-body');
  if (!tbody) return;
  const list = adminConsoleCache.activation_codes || [];
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="py-5 text-center text-slate-500">ยังไม่มีรหัสที่สร้างไว้ — กด "+ สร้างรหัสใหม่" ด้านบนเพื่อสร้างรหัสใช้ครั้งเดียวหรือหลายครั้ง</td></tr>';
    return;
  }

  tbody.innerHTML = list.map(c => {
    const safeId = escapeHtml(c.id);
    const safeCode = escapeHtml(c.code);
    const tierLabel = c.plan_tier === 'advisor' ? 'Advisor Pro' : 'QuantFolio Pro';
    const durLabel = Number(c.duration_days || 0) > 0 ? `${c.duration_days} วัน` : 'ถาวร';
    const usedCount = Number(c.used_count ?? (c.used_by || []).length);
    const maxUses = Number(c.max_uses || 1);
    const isRevoked = Boolean(c.revoked);
    const isExpired = Boolean(c.is_code_expired);
    const isFull = usedCount >= maxUses;

    let statusPill = '<span class="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-900 font-bold text-[10px] whitespace-nowrap">✓ พร้อมใช้งาน</span>';
    if (isRevoked) {
      statusPill = '<span class="px-2 py-0.5 rounded-full bg-rose-100 text-rose-800 font-bold text-[10px] whitespace-nowrap">✕ ยกเลิกแล้ว</span>';
    } else if (isExpired) {
      statusPill = '<span class="px-2 py-0.5 rounded-full bg-slate-200 text-slate-700 font-bold text-[10px] whitespace-nowrap">หมดเขตรับสิทธิ์</span>';
    } else if (isFull) {
      statusPill = '<span class="px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 font-bold text-[10px] whitespace-nowrap">ใช้ครบแล้ว</span>';
    }

    const usedEmailsStr = (c.used_by || []).map(u => escapeHtml(typeof u === 'string' ? u : (u.email || ''))).filter(Boolean).join(', ');
    const revokeBtn = !isRevoked
      ? `<button type="button" data-code-id="${safeId}" onclick="adminRevokeActivationCode(this.dataset.codeId)" class="px-2 py-1 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 font-bold text-[10.5px] transition cursor-pointer">ยกเลิก</button>`
      : '';

    return `
      <tr class="hover:bg-slate-50/90 transition">
        <td class="py-2.5 px-3">
          <div class="font-mono font-extrabold text-slate-900 tracking-wide">${safeCode}</div>
          ${c.note ? `<div class="text-[10.5px] text-slate-500">${escapeHtml(c.note)}</div>` : ''}
          ${usedEmailsStr ? `<div class="text-[10px] text-slate-400 font-mono">ผู้ใช้: ${usedEmailsStr}</div>` : ''}
        </td>
        <td class="py-2.5 px-3 whitespace-nowrap">
          <div class="font-bold text-slate-800">${escapeHtml(tierLabel)}</div>
          <div class="text-[10.5px] text-slate-500">สิทธิ์ ${escapeHtml(durLabel)}${c.code_expires_at ? ` • กรอกก่อน ${escapeHtml(formatShortDateTh(c.code_expires_at))}` : ''}</div>
        </td>
        <td class="py-2.5 px-3 text-center font-mono font-bold text-slate-800 whitespace-nowrap">${usedCount} / ${maxUses}</td>
        <td class="py-2.5 px-3">${statusPill}</td>
        <td class="py-2.5 px-3 text-right whitespace-nowrap">
          <div class="inline-flex items-center gap-1.5">
            <button type="button" data-code="${safeCode}" onclick="copyActivationCodeText(this.dataset.code)" class="px-2 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-[10.5px] transition cursor-pointer">คัดลอก</button>
            ${revokeBtn}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

async function adminDecideUpgradeRequest(reqId, decision) {
  if (!reqId || !currentUser || !getUserTierInfo().isAdmin) return;
  showInlineModalAlert('admin-console-alert', '');
  try {
    const res = await fetch(`/api/admin/upgrade-requests/${encodeURIComponent(reqId)}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getBackendAuthHeaders() },
      body: JSON.stringify({ decision })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.detail || 'ไม่สามารถดำเนินการคำขอนี้ได้');
    }
    const label = decision === 'approve' ? 'อนุมัติและอัปเกรดสิทธิ์ลูกค้าเรียบร้อยแล้ว' : 'ปฏิเสธคำขอเรียบร้อยแล้ว';
    showInlineModalAlert('admin-console-alert', `✓ ${label}`, 'success');
    showPortfolioToast(label);

    if (data.target_user && String(currentUser.email || '').toLowerCase() === String(data.target_user.email || '').toLowerCase()) {
      currentUser = { ...currentUser, ...data.target_user, token: currentUser.token || localStorage.getItem('qf_verified_session_token') };
      // Session user kept strictly in memory; only session token is persisted in localStorage
      updateAuthUI(currentUser);
    }
    await loadAdminConsoleOverview();
  } catch (err) {
    showInlineModalAlert('admin-console-alert', err.message || 'เกิดข้อผิดพลาดในการตัดสินคำขอ', 'error');
    await loadAdminConsoleOverview({ silent: true });
  }
}

function adminToggleCustomExpiryInput(selEl) {
  const row = selEl?.closest('tr');
  const inp = row?.querySelector('input[data-role="custom-exp-input"]');
  if (!inp) return;
  const isCustom = selEl.value === 'custom';
  inp.classList.toggle('hidden', !isCustom);
  if (isCustom) inp.focus();
}

async function adminUpdateUserRowTier(btnEl) {
  if (!btnEl || !currentUser || !getUserTierInfo().isAdmin) return;
  const targetEmail = String(btnEl.dataset.email || '').trim().toLowerCase();
  const row = btnEl.closest('tr');
  const targetTier = row?.querySelector('select[data-role="tier-sel"]')?.value || 'free';
  const durRaw = row?.querySelector('select[data-role="dur-sel"]')?.value || '0';
  const isCustomExp = targetTier !== 'free' && durRaw === 'custom';
  const customExpVal = (row?.querySelector('input[data-role="custom-exp-input"]')?.value || '').trim();
  const durationDays = isCustomExp ? 0 : (parseInt(durRaw, 10) || 0);

  showInlineModalAlert('admin-console-alert', '');
  if (isCustomExp && !customExpVal) {
    showInlineModalAlert('admin-console-alert', 'กรุณาเลือกวัน–เวลาหมดอายุที่ต้องการกำหนดก่อนกดบันทึก', 'error');
    row?.querySelector('input[data-role="custom-exp-input"]')?.focus();
    return;
  }

  const payload = {
    target_email: targetEmail,
    plan_tier: targetTier,
    duration_days: targetTier === 'free' ? 0 : durationDays
  };
  if (isCustomExp) {
    // Interpret Admin datetime-local strictly as Thailand time (UTC+7)
    payload.expires_at = `${customExpVal.length === 16 ? `${customExpVal}:00` : customExpVal}+07:00`;
  }

  const origTxt = btnEl.textContent;
  try {
    btnEl.disabled = true;
    btnEl.textContent = '...';
    const res = await fetch('/api/admin/set-user-tier', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getBackendAuthHeaders() },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || 'ไม่สามารถอัปเดตสิทธิ์สมาชิกได้');

    const savedExpIso = data.user?.plan_expires_at;
    const durLabel = targetTier === 'free'
      ? ''
      : (isCustomExp && savedExpIso
        ? ` (หมดอายุ ${formatDateTimeTh(savedExpIso)})`
        : (durationDays > 0 ? ` (+${durationDays} วัน)` : ' (ถาวร)'));
    const msg = `✓ อัปเดตสิทธิ์ของ ${targetEmail} เป็น ${targetTier.toUpperCase()}${durLabel} สำเร็จแล้ว`;
    showInlineModalAlert('admin-console-alert', msg, 'success');
    showPortfolioToast(msg);

    if (data.user && String(currentUser.email || '').toLowerCase() === targetEmail) {
      currentUser = { ...currentUser, ...data.user, token: currentUser.token || localStorage.getItem('qf_verified_session_token') };
      // Session user kept strictly in memory; only session token is persisted in localStorage
      updateAuthUI(currentUser);
    }
    await loadAdminConsoleOverview({ silent: true });
  } catch (err) {
    showInlineModalAlert('admin-console-alert', err.message || 'เกิดข้อผิดพลาดในการบันทึกสิทธิ์', 'error');
  } finally {
    btnEl.disabled = false;
    btnEl.textContent = origTxt;
  }
}

async function adminGenerateActivationCode() {
  if (!currentUser || !getUserTierInfo().isAdmin) return;
  showInlineModalAlert('admin-console-alert', '');
  const planTier = document.getElementById('admin-code-tier')?.value || 'pro';
  const durationDays = parseInt(document.getElementById('admin-code-duration')?.value || '30', 10) || 0;
  const maxUses = parseInt(document.getElementById('admin-code-max-uses')?.value || '1', 10) || 1;
  const codeValidDays = parseInt(document.getElementById('admin-code-valid-days')?.value || '30', 10) || 0;
  const noteEl = document.getElementById('admin-code-note');
  const note = (noteEl?.value || '').trim();
  const btn = document.getElementById('btn-admin-gen-code');

  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'กำลังสร้าง...';
    }
    const res = await fetch('/api/admin/codes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getBackendAuthHeaders() },
      body: JSON.stringify({
        plan_tier: planTier,
        duration_days: durationDays,
        max_uses: maxUses,
        code_valid_days: codeValidDays,
        note
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || 'ไม่สามารถสร้างรหัสเปิดใช้งานได้');
    if (noteEl) noteEl.value = '';
    const newCode = data.code?.code || '';
    showInlineModalAlert('admin-console-alert', `✓ สร้างรหัสใหม่สำเร็จ: ${newCode}`, 'success');
    showPortfolioToast(`สร้างรหัส ${newCode} เรียบร้อยแล้ว`);
    await loadAdminConsoleOverview({ silent: true });
  } catch (err) {
    showInlineModalAlert('admin-console-alert', err.message || 'ไม่สามารถสร้างรหัสได้', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '+ สร้างรหัสใหม่';
    }
  }
}

async function adminRevokeActivationCode(codeId) {
  if (!codeId || !currentUser || !getUserTierInfo().isAdmin) return;
  showInlineModalAlert('admin-console-alert', '');
  try {
    const res = await fetch(`/api/admin/codes/${encodeURIComponent(codeId)}/revoke`, {
      method: 'POST',
      headers: getBackendAuthHeaders()
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || 'ไม่สามารถยกเลิกรหัสได้');
    showInlineModalAlert('admin-console-alert', `✓ ยกเลิกรหัส ${data.code?.code || ''} เรียบร้อยแล้ว`, 'warning');
    showPortfolioToast('ยกเลิกรหัสเปิดใช้งานเรียบร้อยแล้ว');
    await loadAdminConsoleOverview({ silent: true });
  } catch (err) {
    showInlineModalAlert('admin-console-alert', err.message || 'เกิดข้อผิดพลาดในการยกเลิกรหัส', 'error');
  }
}

async function copyActivationCodeText(codeStr) {
  if (!codeStr) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(codeStr);
    } else {
      const ta = document.createElement('textarea');
      ta.value = codeStr;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    showPortfolioToast(`คัดลอกรหัส ${codeStr} แล้ว!`);
  } catch (e) {
    showPortfolioToast(`รหัส: ${codeStr}`);
  }
}

async function adminUpdateCustomerTier() {
  return loadAdminConsoleOverview();
}

window.getCurrentAuthenticatedUser = () => currentUser;
window.getUserTierInfo = getUserTierInfo;
window.getBackendAuthHeaders = getBackendAuthHeaders;
window.openProUpgradeModal = openProUpgradeModal;
window.closeProUpgradeModal = closeProUpgradeModal;
window.switchProModalTab = switchProModalTab;
window.switchAdminSubTab = switchAdminSubTab;
window.setProBillingCycle = setProBillingCycle;
window.toggleProCoreFeatures = toggleProCoreFeatures;
window.syncUpgradeRequestPriceHint = syncUpgradeRequestPriceHint;
window.selectUpgradeTargetTier = selectUpgradeTargetTier;
window.selectEnterpriseInquiry = selectEnterpriseInquiry;
window.submitActivationCodeUpgrade = submitActivationCodeUpgrade;
window.submitUpgradeRequest = submitUpgradeRequest;
window.loadMyUpgradeRequests = loadMyUpgradeRequests;
window.cancelMyUpgradeRequest = cancelMyUpgradeRequest;
window.adminSetPreviewTier = adminSetPreviewTier;
window.adminQuickSwitchOwnTier = adminQuickSwitchOwnTier;
window.loadAdminConsoleOverview = loadAdminConsoleOverview;
window.adminFilterUsersTable = adminFilterUsersTable;
window.adminDecideUpgradeRequest = adminDecideUpgradeRequest;
window.adminToggleCustomExpiryInput = adminToggleCustomExpiryInput;
window.adminUpdateUserRowTier = adminUpdateUserRowTier;
window.adminGenerateActivationCode = adminGenerateActivationCode;
window.adminRevokeActivationCode = adminRevokeActivationCode;
window.copyActivationCodeText = copyActivationCodeText;
window.adminUpdateCustomerTier = adminUpdateCustomerTier;
window.refreshSavedPortfoliosUI = () => renderSavedPortfoliosList(savedPortfoliosList);

// ปิด Dropdown บัญชีผู้ใช้เมื่อคลิกนอกพื้นที่
document.addEventListener('click', (e) => {
  const menu = document.getElementById('header-account-menu');
  const btn = document.getElementById('header-account-menu-btn');
  if (menu && !menu.classList.contains('hidden') && !menu.contains(e.target) && (!btn || !btn.contains(e.target))) {
    toggleHeaderAccountMenu(false);
  }
});

// รองรับปุ่ม Escape เพื่อปิด Modal และ Dropdown บัญชีอย่างนุ่มนวล
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const proModal = document.getElementById('pro-upgrade-modal');
  if (proModal && !proModal.classList.contains('hidden')) {
    closeProUpgradeModal();
    return;
  }
  const helpModal = document.getElementById('help-guide-modal');
  if (helpModal && !helpModal.classList.contains('hidden')) {
    helpModal.classList.add('hidden');
    return;
  }
  const deleteModal = document.getElementById('delete-account-confirm-modal');
  if (deleteModal && !deleteModal.classList.contains('hidden')) {
    closeDeleteAccountModal();
    return;
  }
  const settingsModal = document.getElementById('account-settings-modal');
  if (settingsModal && !settingsModal.classList.contains('hidden')) {
    closeAccountSettingsModal();
    return;
  }
  const loginModal = document.getElementById('supabase-config-modal');
  if (loginModal && !loginModal.classList.contains('hidden')) {
    closeSupabaseConfigModal();
    return;
  }
  toggleHeaderAccountMenu(false);
});

document.addEventListener('DOMContentLoaded', () => {
  initSupabaseAuth();
});
