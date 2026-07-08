/**
 * Access tab (gateway-consolidation §P3d): manage accounts and their access keys.
 * Admin creates accounts, issues a per-user access key (shown once), revokes all
 * keys, and unbinds a channel identity. The key authenticates `/rpc` (Bearer) and
 * IM (`/bind <key>`). Owns #acc-list / #acc-key. No backticks / ${}.
 */
export const accessCard = String.raw`
  <div class="card">
    <h2 data-i18n="accTitle"></h2>
    <p class="hint" data-i18n="accHint"></p>
    <div class="row" style="margin-bottom:12px">
      <input id="acc-name" data-i18n-ph="accNamePh" />
      <button onclick="accCreate()" data-i18n="accCreate"></button>
      <button class="ghost" onclick="refreshAccounts()" data-i18n="accRefresh"></button>
    </div>
    <div id="acc-key" style="display:none;margin:0 0 12px;padding:10px;border:1px solid #4a7;border-radius:8px"></div>
    <div id="acc-list"><span class="muted" data-i18n="loading"></span></div>
  </div>
`;

export const accessScript = String.raw`
function renderAccounts(list){
  var box=document.getElementById('acc-list'); if(!box) return;
  if(!list || !list.length){ box.innerHTML='<span class="muted">'+t('accNone')+'</span>'; return; }
  var html='';
  for(var i=0;i<list.length;i++){
    var a=list[i];
    var ids='';
    for(var j=0;j<(a.identities||[]).length;j++){
      var x=a.identities[j];
      ids += '<span class="pill">'+esc(x.provider+':'+x.providerUserId)
        +' <a href="#" title="unbind" onclick="accUnbind(\''+jsq(x.provider)+'\',\''+jsq(x.providerUserId)+'\');return false">✕</a></span> ';
    }
    if(!ids) ids='<span class="muted">'+t('accNoId')+'</span>';
    html += '<div style="border-top:1px solid #333;padding:10px 0">'
      + '<b>'+esc(a.displayName||a.accountId)+'</b> <span class="muted" style="font-size:12px">'+esc(a.accountId)+'</span>'
      + '<div style="margin:6px 0">'+ids+'</div>'
      + '<button onclick="accIssue(\''+jsq(a.accountId)+'\')">'+t('accIssue')+'</button> '
      + '<button class="danger" onclick="accRevoke(\''+jsq(a.accountId)+'\')">'+t('accRevoke')+'</button>'
      + '</div>';
  }
  box.innerHTML=html;
}
async function refreshAccounts(){ try{ renderAccounts(await api('GET','/api/accounts')); }catch(e){} }
async function accCreate(){
  var el=document.getElementById('acc-name'); var name=el?el.value.trim():'';
  try{ await api('POST','/api/account/create',{name:name}); if(el) el.value=''; toast(t('created')); refreshAccounts(); }
  catch(e){ toast(t('errPrefix')+e.message); }
}
async function accIssue(id){
  try{ var r=await api('POST','/api/account/key/issue',{accountId:id}); showKey(r.token); refreshAccounts(); }
  catch(e){ toast(t('errPrefix')+e.message); }
}
function showKey(token){
  var box=document.getElementById('acc-key'); if(!box) return;
  box.style.display='block';
  box.innerHTML='<b>'+t('accKeyOnce')+'</b><br><code style="word-break:break-all;user-select:all">'+esc(token)+'</code>';
}
async function accRevoke(id){
  if(!confirm(t('accRevokeConfirm'))) return;
  try{ var r=await api('POST','/api/account/key/revoke',{accountId:id}); toast(ti('accRevoked', (r.revoked||0)+' / '+(r.unbound||0))); refreshAccounts(); }
  catch(e){ toast(t('errPrefix')+e.message); }
}
async function accUnbind(p,u){
  if(!confirm(ti('accUnbindConfirm', p+':'+u))) return;
  try{ await api('POST','/api/identity/unbind',{provider:p,providerUserId:u}); toast(t('unbound')); refreshAccounts(); }
  catch(e){ toast(t('errPrefix')+e.message); }
}
refreshAccounts();
`;
