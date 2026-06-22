/**
 * Gateway-process component (gateway §7/§10): shows the resident gateway's state
 * (running / stopped / error) and starts / stops / restarts it. Polls
 * /api/gateway/status (its own endpoint, not /api/state) so a crash surfaces live.
 * Lives in the Status tab. Owns #gw-status.
 */
export const gatewayCard = String.raw`
  <div class="card">
    <h2 data-i18n="gwTitle"></h2>
    <p class="hint" data-i18n="gwHint"></p>
    <div id="gw-status"><span class="muted" data-i18n="loading"></span></div>
    <div class="row" style="margin-top:12px">
      <button onclick="gwAction('start')" data-i18n="gwStart"></button>
      <button class="ghost" onclick="gwAction('restart')" data-i18n="gwRestart"></button>
      <button class="danger" onclick="gwAction('stop')" data-i18n="gwStop"></button>
    </div>
  </div>
`;

export const gatewayScript = String.raw`
function gwUptime(since){
  var s=Math.max(0,Math.floor((Date.now()-since)/1000)), m=Math.floor(s/60), h=Math.floor(m/60);
  if(h>0) return h+'h '+(m%60)+'m'; if(m>0) return m+'m '+(s%60)+'s'; return s+'s';
}
function renderGateway(st){
  var box=document.getElementById('gw-status'); if(!box) return;
  var pill = st.state==='running' ? '<span class="pill ok">'+t('gwRunning')+'</span>'
    : st.state==='error' ? '<span class="pill no">'+t('gwError')+'</span>'
    : '<span class="pill">'+t('gwStopped')+'</span>';
  var meta='';
  if(st.pid) meta+=' <span class="muted">PID '+esc(st.pid)+'</span>';
  if(st.startedAt && st.state==='running') meta+=' <span class="muted">· '+t('gwUptime')+gwUptime(st.startedAt)+'</span>';
  var detail = (st.state==='error' && st.detail)
    ? '<pre class="muted" style="margin:10px 0 0;white-space:pre-wrap;font-size:12px">'+esc(st.detail)+'</pre>' : '';
  box.innerHTML = pill + meta + detail;
}
// Global "restart to apply" banner (shown on every tab when config changed since
// the running gateway started). The Status tab's card holds the same Restart.
function renderGwBanner(st){
  var b=document.getElementById('gw-banner'); if(!b) return;
  b.innerHTML = (st.state==='running' && st.stale)
    ? '<div class="banner"><span>⚠ '+t('gwStale')+'</span><button onclick="gwAction(\'restart\')">'+t('gwRestart')+'</button></div>'
    : '';
}
async function refreshGateway(){
  try{ var st=await api('GET','/api/gateway/status'); renderGateway(st); renderGwBanner(st); }
  catch(e){ /* panel still usable */ }
}
async function gwAction(action){
  try{
    renderGateway(await api('POST','/api/gateway/'+action, {}));
    toast(t('updated'));
    setTimeout(refreshGateway, 1500); // let a start/restart finish booting, then reflect it
  }catch(e){ toast(t('errPrefix')+e.message); }
}
refreshGateway();
setInterval(refreshGateway, 3000);
`;
