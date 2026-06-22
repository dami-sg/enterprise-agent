/**
 * Model-core component (gateway §7, sec ①): providers table + preset/add form,
 * model discovery, and the orchestrator binding. Owns #orch, #providers,
 * #p-preset, #m-provider, #models.
 */
export const coreCard = String.raw`
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
`;

export const coreScript = String.raw`
var PRESETS=[];
function applyPreset(){
  var id=document.getElementById('p-preset').value;
  var p=PRESETS.find(function(x){ return x.id===id; });
  if(!p) return;
  document.getElementById('p-id').value=p.id;
  document.getElementById('p-kind').value=p.kind;
  document.getElementById('p-base').value=p.baseURL||'';
}
RENDERERS.push(function(s){
  document.getElementById('orch').textContent=s.orchestrator||'—';
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
});
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
`;
