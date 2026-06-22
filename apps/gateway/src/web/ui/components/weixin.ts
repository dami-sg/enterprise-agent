/**
 * WeChat iLink QR-login component (gateway §7/§8.3, sec ③): starts a scan login
 * and polls until confirmed, then re-renders. Owns #wx-qr (no RENDERERS entry —
 * it's driven by the user pressing "start", not by /api/state).
 */
export const weixinCard = String.raw`
  <div class="card">
    <h2 data-i18n="sec3"></h2>
    <p class="hint" data-i18n="hint3"></p>
    <div class="row">
      <div class="field"><label>baseURL</label><input id="wx-base" value="https://ilinkai.weixin.qq.com" style="min-width:260px" /></div>
      <div class="field"><label data-i18n="wxAccountLabel"></label><input id="wx-account" /></div>
      <button onclick="weixinStart()" data-i18n="startScan"></button>
    </div>
    <div class="qr" id="wx-qr"></div>
  </div>
`;

export const weixinScript = String.raw`
var wxPoll=null;
async function weixinStart(){
  if(wxPoll){ clearInterval(wxPoll); wxPoll=null; }
  var box=document.getElementById('wx-qr');
  box.innerHTML='<p class="muted">'+t('gettingQr')+'</p>';
  try{
    var r=await api('POST','/api/weixin/login/start',{ baseURL:document.getElementById('wx-base').value,
      accountId:document.getElementById('wx-account').value||undefined });
    var src = r.qrcodeImg ? (r.qrcodeImg.indexOf('data:')===0 ? r.qrcodeImg : 'data:image/png;base64,'+r.qrcodeImg) : '';
    box.innerHTML = (src? '<img src="'+esc(src)+'" alt="qr" />' : '<p class="muted">'+t('qrContent')+'<code>'+esc(r.qrcode)+'</code></p>')+
      '<p class="muted" id="wx-status">'+t('scanPrompt')+'</p>';
    var lid=r.loginId;
    wxPoll=setInterval(async function(){
      try{
        var st=await api('GET','/api/weixin/login/status?loginId='+encodeURIComponent(lid));
        if(st.status==='confirmed'){ clearInterval(wxPoll); wxPoll=null;
          box.innerHTML='<p class="pill ok">'+t('loginOk')+esc(st.accountId||'')+'</p>'; toast(t('wxOk')); load(); }
        else if(st.status==='expired'){ clearInterval(wxPoll); wxPoll=null;
          var e1=document.getElementById('wx-status'); if(e1) e1.textContent=t('qrExpired'); }
        else { var el=document.getElementById('wx-status'); if(el) el.textContent=t('statusPrefix')+st.status; }
      }catch(e){ /* keep polling */ }
    }, 2000);
  }catch(e){ box.innerHTML='<p class="no">'+esc(e.message)+'</p>'; }
}
`;
