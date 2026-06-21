/**
 * The gateway config panel's single page (gateway §7). Embedded as a string so
 * the compiled `dist` is self-contained (no asset copying, no front-end build).
 * Vanilla JS + fetch against the §7 admin API in server.ts. Bilingual (中文 /
 * English) via a small i18n dictionary + a header toggle (remembered in
 * localStorage). Intentionally avoids backticks / ${} so it can live inside this
 * TS template literal verbatim.
 */
export const APP_HTML = String.raw`<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Enterprise Agent Gateway</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background: #0e1117; color: #d6dae0; }
  header { padding: 18px 24px; border-bottom: 1px solid #232a36; display: flex; align-items: baseline; gap: 14px; }
  header h1 { font-size: 17px; margin: 0; font-weight: 650; }
  header .sub { color: #7e8794; font-size: 12px; }
  header .spacer { flex: 1; }
  #lang { background: #232a36; color: #cbd2dc; border: 1px solid #2b3340; border-radius: 7px; padding: 5px 11px;
          cursor: pointer; font: inherit; align-self: center; }
  main { max-width: 980px; margin: 0 auto; padding: 22px; }
  .card { background: #161b24; border: 1px solid #232a36; border-radius: 10px; padding: 18px 20px; margin-bottom: 18px; }
  .card h2 { font-size: 14px; margin: 0 0 4px; }
  .card .hint { color: #7e8794; font-size: 12px; margin: 0 0 14px; }
  .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field label { font-size: 11px; color: #8b94a3; }
  input, select { background: #0e1117; border: 1px solid #2b3340; color: #e6e9ee; border-radius: 7px;
                  padding: 7px 9px; font: inherit; min-width: 120px; }
  input:focus, select:focus { outline: none; border-color: #3b82f6; }
  button { background: #2563eb; color: #fff; border: 0; border-radius: 7px; padding: 7px 13px; font: inherit;
           cursor: pointer; }
  button.ghost { background: #232a36; color: #cbd2dc; }
  button.danger { background: #3a2326; color: #f1a3a3; }
  button:hover { filter: brightness(1.08); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #232a36; }
  th { color: #8b94a3; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 99px; font-size: 11px; }
  .ok { background: #14331f; color: #6ee79e; }
  .no { background: #3a2326; color: #f1a3a3; }
  .muted { color: #7e8794; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  #toast { position: fixed; right: 18px; bottom: 18px; background: #1b2330; border: 1px solid #2b3340;
           padding: 10px 14px; border-radius: 8px; opacity: 0; transition: opacity .2s; max-width: 360px; }
  #toast.show { opacity: 1; }
  code { background: #0e1117; padding: 1px 5px; border-radius: 4px; color: #9fb6e0; }
  .qr { margin-top: 12px; }
  .qr img { width: 220px; height: 220px; background: #fff; border-radius: 8px; padding: 8px; }
  details summary { cursor: pointer; color: #8b94a3; font-size: 12px; margin-top: 8px; }
</style>
</head>
<body>
<header>
  <h1 data-i18n="title"></h1>
  <span class="sub" data-i18n="sub"></span>
  <span class="spacer"></span>
  <button id="lang" onclick="toggleLang()"></button>
</header>
<main>
  <div class="card">
    <h2 data-i18n="statusTitle"></h2>
    <div id="status"></div>
  </div>

  <div class="card">
    <h2 data-i18n="sec1"></h2>
    <p class="hint" data-i18n="hint1"></p>
    <div id="providers"></div>
    <div class="row" style="margin-top:12px">
      <div class="field"><label data-i18n="preset"></label>
        <select id="p-preset" onchange="applyPreset()"></select></div>
      <div class="field"><label>id</label><input id="p-id" data-i18n-ph="idPh" /></div>
      <div class="field"><label>kind</label>
        <select id="p-kind">
          <option>anthropic</option><option>openai</option><option>google</option>
          <option>openai-compatible</option><option>gateway</option>
        </select></div>
      <div class="field"><label data-i18n="baseUrlLabel"></label><input id="p-base" placeholder="https://…/v1" style="min-width:220px" /></div>
      <div class="field"><label data-i18n="keyLabel"></label><input id="p-key" type="password" placeholder="sk-…" /></div>
      <button onclick="addProvider()" data-i18n="addProvider"></button>
    </div>
    <div class="row" style="margin-top:14px">
      <div class="field"><label data-i18n="discoverLabel"></label>
        <select id="m-provider"></select></div>
      <button class="ghost" onclick="discover()" data-i18n="discoverBtn"></button>
      <span class="muted"><span data-i18n="orchLabel"></span><code id="orch">—</code></span>
    </div>
    <div id="models"></div>
  </div>

  <div class="card">
    <h2 data-i18n="sec2"></h2>
    <p class="hint" data-i18n="hint2"></p>
    <div id="channels"></div>
    <details open><summary data-i18n="addChannel"></summary>
      <div class="grid2" style="margin-top:10px">
        <div class="field" data-chan="common"><label data-i18n="channelLabel"></label>
          <select id="c-name" onchange="onChannelKind()">
            <option>telegram</option><option>weixin</option>
          </select></div>
        <div class="field" data-chan="telegram"><label data-i18n="tokenLabel"></label><input id="c-token" type="password" placeholder="123456:ABC-…" /></div>
        <div class="field" data-chan="weixin"><label data-i18n="accountLabel"></label><input id="c-account" placeholder="bot-xxx" /></div>
        <div class="field" data-chan="weixin"><label data-i18n="groupLabel"></label>
          <select id="c-group"><option value="">—</option><option>disabled</option><option>enabled</option></select></div>
        <div class="field" data-chan="common"><label data-i18n="modeLabel"></label>
          <select id="c-mode"><option>ask</option><option>auto</option><option>plan</option></select></div>
        <div class="field" data-chan="common"><label data-i18n="wdLabel"></label><input id="c-wd" placeholder="/srv/ws/tg" /></div>
        <div class="field" data-chan="common"><label data-i18n="approvalLabel"></label>
          <select id="c-approval"><option>reject</option><option>auto:once</option><option>auto:session</option></select></div>
        <div class="field" data-chan="common"><label data-i18n="resetLabel"></label>
          <select id="c-reset" onchange="onReset()"><option value="" data-i18n="resetNone"></option><option value="idle">idle</option><option value="daily">daily</option><option value="command">command</option></select></div>
        <div class="field" data-chan="common" id="c-reset-arg-wrap"><label data-i18n="resetArgLabel"></label><input id="c-reset-arg" placeholder="240 / 04:00" /></div>
        <div class="field" data-chan="common"><label data-i18n="adminsLabel"></label><input id="c-admins" placeholder="42,99" /></div>
      </div>
      <p class="hint" data-chan="weixin" data-i18n="wxTokenHint" style="margin-top:8px"></p>
      <div class="row" style="margin-top:10px"><button onclick="saveChannel()" data-i18n="saveChannel"></button></div>
    </details>
  </div>

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

  <div class="card">
    <h2 data-i18n="sec4"></h2>
    <div class="row" style="margin-bottom:12px">
      <label class="muted"><input type="checkbox" id="verbose" onchange="setVerbose()" /> <span data-i18n="verboseLabel"></span></label>
    </div>
    <div id="routes"></div>
    <p class="hint" style="margin-top:14px" data-i18n-html="startHint"></p>
  </div>
</main>
<div id="toast"></div>

<script>
var I18N = {
  zh: {
    title: 'Gateway 配置面板', sub: '从 0 配置：模型 → 通道 → 密钥 → 微信扫码。写入与 ea 同一份 ~/.enterprise-agent',
    langBtn: 'English',
    statusTitle: '就绪状态', loading: '加载中…', coreLabel: '核心模型：', ready: '就绪', notReady: '未配置',
    channelsLabel: '就绪通道：', none: '无',
    sec1: '① 模型核心', hint1: 'Gateway 不自带模型——先接一个 Provider 并把它的模型绑为 orchestrator（新会话即用）。',
    preset: '预设', custom: '（自定义）', idPh: '如 anthropic / ollama',
    baseUrlLabel: 'baseURL（兼容/gateway 必填）', keyLabel: 'API Key（本地端点可空）', addProvider: '添加 Provider',
    discoverLabel: '发现模型（选 Provider）', discoverBtn: '发现模型', orchLabel: '当前 orchestrator：',
    sec2: '② 通道', hint2: 'Telegram 直接填 token；微信用下方扫码登录。token 只写进 keychain，配置里只存引用。',
    addChannel: '添加 / 更新通道', channelLabel: '通道', tokenLabel: 'Bot Token（telegram）', modeLabel: '执行模式',
    wdLabel: '工作目录（文件边界）', approvalLabel: '审批策略', resetLabel: '重置', resetNone: '不重置',
    resetArgLabel: 'idle 分钟 / daily 时刻', adminsLabel: '管理员 userId（逗号分隔，可空=全员）',
    accountLabel: 'accountId（微信）', groupLabel: '群（微信，默认 disabled）', saveChannel: '保存通道',
    enable: '启用', disable: '停用', wxTokenHint: '微信的 bot_token 通过下方 ③ 扫码获取；此处用相同 accountId 保存会话/审批等配置。',
    sec3: '③ 微信 iLink 扫码登录', hint3: '扫码确认后自动写 keychain + 在上方通道里追加 weixin。iLink 是新接口，可能需要重试。',
    wxAccountLabel: 'accountId（可空，默认取 bot id）', startScan: '开始扫码',
    sec4: '④ 路由 / 杂项', verboseLabel: '在聊天里显示工具/子代理轨迹（verbose）',
    startHint: '配置完成后，运行 <code>ea-gateway start</code> 启动网关。',
    colKind: 'kind', colKey: 'key', colDelete: '删除', has: '有', no: '无', noProviders: '尚无 Provider。',
    colModelRef: '模型 ref', colSource: '来源', setOrch: '设为编排模型', discovering: '发现中…',
    noModels: '未发现模型（可手动设 ref）。', noChannels: '尚无通道。',
    colChannel: '通道', colAccount: 'account', colEnabled: '启用', colToken: 'token', colMode: '模式', colApproval: '审批',
    yes: '是', enNo: '否', colRouteKey: '路由键', unbind: '解绑', noRoutes: '尚无会话路由。',
    gettingQr: '获取二维码…', scanPrompt: '请用微信扫码并确认…', qrContent: '二维码内容：',
    loginOk: '登录成功：', qrExpired: '二维码已过期，请重试。', statusPrefix: '状态：',
    addedProvider: '已添加 Provider', confirmDelProvider: '删除 provider {x}？', deleted: '已删除',
    pickProvider: '先添加 Provider', savedChannel: '已保存通道 {x}', confirmDelChannel: '删除通道 {x}？',
    unbound: '已解绑', updated: '已更新', wxOk: '微信登录成功', errPrefix: '错误：',
  },
  en: {
    title: 'Gateway Config Panel', sub: 'Configure from zero: models → channels → secrets → WeChat QR. Writes the same ~/.enterprise-agent as the ea CLI.',
    langBtn: '中文',
    statusTitle: 'Readiness', loading: 'Loading…', coreLabel: 'Core model: ', ready: 'Ready', notReady: 'Not configured',
    channelsLabel: 'Ready channels: ', none: 'none',
    sec1: '① Model core', hint1: 'The gateway ships no model — add a Provider and bind one of its models as the orchestrator (used by new sessions).',
    preset: 'Preset', custom: '(custom)', idPh: 'e.g. anthropic / ollama',
    baseUrlLabel: 'baseURL (required for compatible/gateway)', keyLabel: 'API Key (optional for local)', addProvider: 'Add Provider',
    discoverLabel: 'Discover models (pick Provider)', discoverBtn: 'Discover', orchLabel: 'Current orchestrator: ',
    sec2: '② Channels', hint2: 'Telegram: enter the token; WeChat: scan below. Tokens go to the keychain only — config keeps just a reference.',
    addChannel: 'Add / update channel', channelLabel: 'Channel', tokenLabel: 'Bot Token (telegram)', modeLabel: 'Execution mode',
    wdLabel: 'Working dir (file boundary)', approvalLabel: 'Approval policy', resetLabel: 'Reset', resetNone: 'No reset',
    resetArgLabel: 'idle minutes / daily time', adminsLabel: 'Admin userIds (comma-sep; empty = everyone)',
    accountLabel: 'accountId (WeChat)', groupLabel: 'Group (WeChat, default disabled)', saveChannel: 'Save channel',
    enable: 'Enable', disable: 'Disable', wxTokenHint: 'WeChat bot_token comes from the QR login (③) below; here, with the same accountId, save the session/approval config.',
    sec3: '③ WeChat iLink QR login', hint3: 'After scanning, the bot_token is written to the keychain and a weixin channel is appended above. iLink is new — may need a retry.',
    wxAccountLabel: 'accountId (optional, defaults to bot id)', startScan: 'Start QR login',
    sec4: '④ Routes / misc', verboseLabel: 'Show tool/sub-agent trace in chat (verbose)',
    startHint: 'When done, run <code>ea-gateway start</code> to launch the gateway.',
    colKind: 'kind', colKey: 'key', colDelete: 'Delete', has: 'yes', no: 'no', noProviders: 'No providers yet.',
    colModelRef: 'Model ref', colSource: 'Source', setOrch: 'Set as orchestrator', discovering: 'Discovering…',
    noModels: 'No models found (set ref manually).', noChannels: 'No channels yet.',
    colChannel: 'Channel', colAccount: 'account', colEnabled: 'Enabled', colToken: 'token', colMode: 'Mode', colApproval: 'Approval',
    yes: 'Yes', enNo: 'No', colRouteKey: 'Route key', unbind: 'Unbind', noRoutes: 'No session routes yet.',
    gettingQr: 'Fetching QR…', scanPrompt: 'Scan with WeChat and confirm…', qrContent: 'QR content: ',
    loginOk: 'Login OK: ', qrExpired: 'QR expired, please retry.', statusPrefix: 'Status: ',
    addedProvider: 'Provider added', confirmDelProvider: 'Delete provider {x}?', deleted: 'Deleted',
    pickProvider: 'Add a Provider first', savedChannel: 'Channel {x} saved', confirmDelChannel: 'Delete channel {x}?',
    unbound: 'Unbound', updated: 'Updated', wxOk: 'WeChat login OK', errPrefix: 'Error: ',
  },
};
var LANG = localStorage.getItem('ea-gw-lang') || 'zh';
function t(k){ return (I18N[LANG] && I18N[LANG][k]) || (I18N.zh[k] || k); }
function ti(k, v){ return t(k).split('{x}').join(v); }
function toggleLang(){ LANG = (LANG === 'zh') ? 'en' : 'zh'; localStorage.setItem('ea-gw-lang', LANG); applyLang(); }
function applyLang(){
  document.documentElement.lang = LANG;
  document.getElementById('lang').textContent = t('langBtn');
  var els = document.querySelectorAll('[data-i18n]');
  for (var i=0;i<els.length;i++){ els[i].textContent = t(els[i].getAttribute('data-i18n')); }
  var hs = document.querySelectorAll('[data-i18n-html]');
  for (var j=0;j<hs.length;j++){ hs[j].innerHTML = t(hs[j].getAttribute('data-i18n-html')); }
  var phs = document.querySelectorAll('[data-i18n-ph]');
  for (var p=0;p<phs.length;p++){ phs[p].placeholder = t(phs[p].getAttribute('data-i18n-ph')); }
  load();
}

function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function toast(msg){ var t2=document.getElementById('toast'); t2.textContent=msg; t2.classList.add('show');
  clearTimeout(t2._h); t2._h=setTimeout(function(){ t2.classList.remove('show'); }, 3200); }
async function api(method, path, body){
  var opt={ method: method, headers: {'content-type':'application/json'} };
  if(body!==undefined) opt.body=JSON.stringify(body);
  var r=await fetch(path, opt);
  var j=await r.json().catch(function(){ return {}; });
  if(!r.ok) throw new Error(j.error || ('HTTP '+r.status));
  return j;
}

var PRESETS=[];
function applyPreset(){
  var id=document.getElementById('p-preset').value;
  var p=PRESETS.find(function(x){ return x.id===id; });
  if(!p) return;
  document.getElementById('p-id').value=p.id;
  document.getElementById('p-kind').value=p.kind;
  document.getElementById('p-base').value=p.baseURL||'';
}

async function load(){
  var s;
  try { s=await api('GET','/api/state'); } catch(e){ return; }
  var chans=(s.ready.channels||[]);
  document.getElementById('status').innerHTML=
    t('coreLabel')+(s.ready.core?'<span class="pill ok">'+t('ready')+'</span>':'<span class="pill no">'+t('notReady')+'</span>')+
    '　'+t('channelsLabel')+(chans.length? chans.map(function(c){return '<span class="pill ok">'+esc(c)+'</span>';}).join(' '):'<span class="muted">'+t('none')+'</span>');
  document.getElementById('orch').textContent=s.orchestrator||'—';
  document.getElementById('verbose').checked=!!s.verbose;
  PRESETS=s.presets||[];
  var psel=document.getElementById('p-preset');
  psel.innerHTML='<option value="">'+t('custom')+'</option>'+PRESETS.map(function(p){
    return '<option value="'+esc(p.id)+'">'+esc(p.name)+' · '+esc(p.kind)+'</option>'; }).join('');
  var pv=s.providers||[];
  document.getElementById('providers').innerHTML = pv.length ?
    '<table><tr><th>id</th><th>'+t('colKind')+'</th><th>baseURL</th><th>'+t('colKey')+'</th><th></th></tr>'+
    pv.map(function(p){ return '<tr><td><code>'+esc(p.id)+'</code></td><td>'+esc(p.kind)+'</td><td class="muted">'+esc(p.baseURL||'—')+'</td><td>'+
      (p.hasKey?'<span class="pill ok">'+t('has')+'</span>':'<span class="pill no">'+t('no')+'</span>')+'</td>'+
      '<td><button class="danger" onclick="delProvider(\''+esc(p.id)+'\')">'+t('colDelete')+'</button></td></tr>'; }).join('')+'</table>'
    : '<p class="muted">'+t('noProviders')+'</p>';
  var msel=document.getElementById('m-provider');
  msel.innerHTML=pv.map(function(p){ return '<option value="'+esc(p.id)+'">'+esc(p.id)+'</option>'; }).join('');
  var cv=s.channels||[];
  document.getElementById('channels').innerHTML = cv.length ?
    '<table><tr><th>'+t('colChannel')+'</th><th>'+t('colAccount')+'</th><th>'+t('colEnabled')+'</th><th>'+t('colToken')+'</th><th>'+t('colMode')+'</th><th>'+t('colApproval')+'</th><th></th></tr>'+
    cv.map(function(c){ return '<tr><td>'+esc(c.name)+'</td><td class="muted">'+esc(c.accountId||'—')+'</td>'+
      '<td>'+(c.enabled?t('yes'):t('enNo'))+'</td><td>'+(c.hasToken?'<span class="pill ok">'+t('has')+'</span>':'<span class="pill no">'+t('no')+'</span>')+'</td>'+
      '<td>'+esc((c.session&&c.session.executionMode)||'ask')+'</td><td class="muted">'+esc(c.approval)+'</td>'+
      '<td><button class="ghost" onclick="toggleChannel(\''+esc(c.name)+'\',\''+esc(c.accountId||'')+'\','+(c.enabled?'false':'true')+')">'+(c.enabled?t('disable'):t('enable'))+'</button> '+
      '<button class="danger" onclick="delChannel(\''+esc(c.name)+'\',\''+esc(c.accountId||'')+'\')">'+t('colDelete')+'</button></td></tr>'; }).join('')+'</table>'
    : '<p class="muted">'+t('noChannels')+'</p>';
  var rv=s.routes||[];
  document.getElementById('routes').innerHTML = rv.length ?
    '<table><tr><th>'+t('colRouteKey')+'</th><th>sessionId</th><th></th></tr>'+rv.map(function(r){
      var parts=r.key.split(':'); var chan=parts.shift(); var conv=parts.join(':');
      return '<tr><td><code>'+esc(r.key)+'</code></td><td class="muted">'+esc(r.entry.sessionId)+'</td>'+
      '<td><button class="ghost" onclick="delRoute(\''+esc(chan)+'\',\''+esc(conv)+'\')">'+t('unbind')+'</button></td></tr>'; }).join('')+'</table>'
    : '<p class="muted">'+t('noRoutes')+'</p>';
}

async function addProvider(){
  try{
    await api('POST','/api/provider',{ kind:document.getElementById('p-kind').value,
      id:document.getElementById('p-id').value, baseURL:document.getElementById('p-base').value,
      key:document.getElementById('p-key').value });
    document.getElementById('p-key').value='';
    toast(t('addedProvider')); load();
  }catch(e){ toast(t('errPrefix')+e.message); }
}
async function delProvider(id){ if(!confirm(ti('confirmDelProvider',id))) return;
  try{ await api('POST','/api/provider/delete',{id:id}); toast(t('deleted')); load(); }catch(e){ toast(t('errPrefix')+e.message); } }

async function discover(){
  var id=document.getElementById('m-provider').value;
  if(!id){ toast(t('pickProvider')); return; }
  document.getElementById('models').innerHTML='<p class="muted">'+t('discovering')+'</p>';
  try{
    var r=await api('GET','/api/models?id='+encodeURIComponent(id));
    var ms=r.models||[];
    document.getElementById('models').innerHTML = ms.length ?
      '<table><tr><th>'+t('colModelRef')+'</th><th>'+t('colSource')+'</th><th></th></tr>'+ms.slice(0,200).map(function(m){
        return '<tr><td><code>'+esc(m.ref)+'</code></td><td class="muted">'+esc(m.source)+'</td>'+
        '<td><button onclick="setOrch(\''+esc(m.ref)+'\')">'+t('setOrch')+'</button></td></tr>'; }).join('')+'</table>'
      : '<p class="muted">'+t('noModels')+'</p>';
  }catch(e){ document.getElementById('models').innerHTML='<p class="no">'+esc(e.message)+'</p>'; }
}
async function setOrch(ref){ try{ await api('POST','/api/model',{ref:ref}); toast('orchestrator = '+ref); load(); }
  catch(e){ toast(t('errPrefix')+e.message); } }

function onChannelKind(){
  var n=document.getElementById('c-name').value;
  var all=document.querySelectorAll('[data-chan]');
  for(var i=0;i<all.length;i++){ var dc=all[i].getAttribute('data-chan');
    all[i].style.display=(dc==='common'||dc===n)?'':'none'; }
  onReset();
}
function onReset(){
  var m=document.getElementById('c-reset').value;
  document.getElementById('c-reset-arg-wrap').style.display=(m==='idle'||m==='daily')?'flex':'none';
}
async function saveChannel(){
  try{
    var name=document.getElementById('c-name').value;
    var ch={ name:name, enabled:true,
      session:{ executionMode:document.getElementById('c-mode').value } };
    var wd=document.getElementById('c-wd').value; if(wd) ch.session.workingDir=wd;
    ch.approval=document.getElementById('c-approval').value;
    var rm=document.getElementById('c-reset').value;
    if(rm==='idle') ch.reset={mode:'idle', idleMinutes:Number(document.getElementById('c-reset-arg').value||'1440')};
    else if(rm==='daily') ch.reset={mode:'daily', at:document.getElementById('c-reset-arg').value||'04:00'};
    else if(rm==='command') ch.reset={mode:'command'};
    var admins=document.getElementById('c-admins').value.split(',').map(function(x){return x.trim();}).filter(Boolean);
    if(admins.length) ch.allowAdminFrom=admins;
    if(name==='telegram'){
      var token=document.getElementById('c-token').value;
      if(token){ await api('POST','/api/secret',{ref:'telegram-bot-token', value:token}); }
      ch.token={keyRef:'telegram-bot-token'};
      document.getElementById('c-token').value='';
    } else if(name==='weixin'){
      var acc=document.getElementById('c-account').value;
      if(acc) ch.accountId=acc;
      var grp=document.getElementById('c-group').value; if(grp) ch.group=grp;
      ch.token={keyRef:'weixin-bot-token-'+(acc||'default')};
    }
    await api('POST','/api/channel',ch);
    toast(ti('savedChannel',name)); load();
  }catch(e){ toast(t('errPrefix')+e.message); }
}
async function delChannel(name, acc){ if(!confirm(ti('confirmDelChannel',name))) return;
  try{ await api('POST','/api/channel/delete',{name:name, accountId:acc||undefined}); toast(t('deleted')); load(); }
  catch(e){ toast(t('errPrefix')+e.message); } }
async function toggleChannel(name, acc, enabled){
  try{ await api('POST','/api/channel/enable',{name:name, accountId:acc||undefined, enabled:enabled}); toast(t('updated')); load(); }
  catch(e){ toast(t('errPrefix')+e.message); } }
async function delRoute(chan, conv){ try{ await api('POST','/api/route/delete',{channel:chan, conversationId:conv}); toast(t('unbound')); load(); }
  catch(e){ toast(t('errPrefix')+e.message); } }
async function setVerbose(){ try{ await api('POST','/api/verbose',{verbose:document.getElementById('verbose').checked}); toast(t('updated')); }
  catch(e){ toast(t('errPrefix')+e.message); } }

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

onReset(); onChannelKind(); applyLang();
</script>
</body>
</html>`;
