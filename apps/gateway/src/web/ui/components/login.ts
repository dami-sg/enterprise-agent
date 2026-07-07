/**
 * Admin login overlay (gateway-consolidation §P3c). The panel shell always
 * renders; on boot `adminGate` asks `/api/admin/me` and either boots the panel
 * (authed / auth disabled) or shows this overlay to collect the admin secret.
 * A successful `/api/admin/login` sets the session cookie and boots. No backticks
 * / ${} (embedded verbatim in the app-html template literal).
 */
export const loginCard = String.raw`
<div id="login-overlay" style="display:none;position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.55);align-items:center;justify-content:center">
  <div style="background:var(--card,#1e1e1e);color:inherit;padding:28px;border-radius:12px;max-width:360px;width:90%;box-shadow:0 10px 40px rgba(0,0,0,.35)">
    <h2 data-i18n="loginTitle" style="margin:0 0 8px"></h2>
    <p class="hint" data-i18n="loginHint" style="margin:0 0 14px"></p>
    <input id="admin-secret" type="password" autocomplete="off" data-i18n-ph="loginPh"
      onkeydown="if(event.key==='Enter'){adminLogin();}"
      style="width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #666;background:transparent;color:inherit" />
    <div id="login-err" style="color:#e06c6c;font-size:13px;min-height:18px;margin:8px 0"></div>
    <button onclick="adminLogin()" data-i18n="loginBtn" style="width:100%;padding:10px"></button>
  </div>
</div>
`;

export const loginScript = String.raw`
function showLogin(show){ var o=document.getElementById('login-overlay'); if(o) o.style.display = show ? 'flex' : 'none'; }
var __eaBoot = null;
function adminGate(cb){
  __eaBoot = cb;
  api('GET','/api/admin/me').then(function(me){
    // Logout only makes sense once authed against a secret-gated panel.
    var lo=document.getElementById('logout'); if(lo) lo.style.display = (me && me.authed && me.required) ? '' : 'none';
    if(me && me.authed){ showLogin(false); cb(); } else { showLogin(true); var el=document.getElementById('admin-secret'); if(el) el.focus(); }
  }).catch(function(){ showLogin(true); });
}
async function adminLogin(){
  var el=document.getElementById('admin-secret'); var v=el?el.value:'';
  var err=document.getElementById('login-err'); if(err) err.textContent='';
  try{ await api('POST','/api/admin/login',{secret:v}); if(el) el.value=''; showLogin(false); if(__eaBoot) __eaBoot(); var lo=document.getElementById('logout'); if(lo) lo.style.display=''; }
  catch(e){ if(err) err.textContent=t('loginBad'); }
}
async function adminLogout(){ try{ await api('POST','/api/admin/logout',{}); }catch(e){} location.reload(); }
`;
