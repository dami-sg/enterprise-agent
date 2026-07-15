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
      '<td><button class="danger" onclick="delProvider(\''+jsq(p.id)+'\')">'+t('colDelete')+'</button></td></tr>'; }).join('')+'</table>'
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
      '<table><tr><th>'+t('colModelRef')+'</th><th>'+t('colSource')+'</th><th>'+t('colCtx')+'</th><th>'+t('colPrice')+'</th><th>'+t('colCaps')+'</th><th></th></tr>'+ms.slice(0,200).map(function(m,i){
        // A model with no built-in/models.dev preset (hasMeta:false) leaves its
        // meta undefined; offer inline inputs so the operator can fill it in.
        if(!m.hasMeta){
          return '<tr><td><code>'+esc(m.ref)+'</code></td><td class="muted">'+esc(m.source)+'</td>'+
          '<td><input id="mm-ctx-'+i+'" type="number" min="1" placeholder="'+t('phCtx')+'" style="width:78px"> '+
              '<input id="mm-out-'+i+'" type="number" min="1" placeholder="'+t('phOut')+'" style="width:70px"></td>'+
          '<td><input id="mm-pin-'+i+'" type="number" min="0" step="0.01" placeholder="in" style="width:58px"> '+
              '<input id="mm-pout-'+i+'" type="number" min="0" step="0.01" placeholder="out" style="width:58px"></td>'+
          '<td><input id="mm-caps-'+i+'" placeholder="'+t('phCaps')+'" style="width:160px"></td>'+
          '<td><button onclick="saveMeta(\''+jsq(m.ref)+'\','+i+')">'+t('saveMeta')+'</button> '+
              '<button class="ghost" onclick="setOrch(\''+jsq(m.ref)+'\')">'+t('setOrch')+'</button></td></tr>';
        }
        var caps=(m.capabilities||[]).join(' ');
        var ctx=m.contextWindow?(m.contextWindow>=1000?Math.round(m.contextWindow/1000)+'k':String(m.contextWindow)):'—';
        var price=m.price?(m.price.input+'/'+m.price.output):'—';
        return '<tr><td><code>'+esc(m.ref)+'</code></td><td class="muted">'+esc(m.source)+'</td>'+
        '<td class="muted">'+esc(ctx)+'</td>'+
        '<td class="muted">'+esc(price)+'</td>'+
        '<td class="muted">'+(caps?esc(caps):'—')+'</td>'+
        '<td><button onclick="setOrch(\''+jsq(m.ref)+'\')">'+t('setOrch')+'</button></td></tr>'; }).join('')+'</table>'
      : '<p class="muted">'+t('noModels')+'</p>';
  }catch(e){ document.getElementById('models').innerHTML='<p class="no">'+esc(e.message)+'</p>'; }
}
// Persist manual metadata for a discovered model with no preset, then re-run
// discovery so the row re-renders with the now-known values (hasMeta:true).
async function saveMeta(ref,i){
  var ctx=parseInt((document.getElementById('mm-ctx-'+i)||{}).value,10);
  var out=parseInt((document.getElementById('mm-out-'+i)||{}).value,10);
  if(!ctx||ctx<=0||!out||out<=0){ toast(t('needCtxOut')); return; }
  var payload={ ref:ref, contextWindow:ctx, maxOutputTokens:out };
  var pin=(document.getElementById('mm-pin-'+i)||{}).value, pout=(document.getElementById('mm-pout-'+i)||{}).value;
  if(pin!==''&&pin!=null&&pout!==''&&pout!=null){ payload.price={ input:parseFloat(pin), output:parseFloat(pout) }; }
  var caps=((document.getElementById('mm-caps-'+i)||{}).value||'').trim();
  if(caps){ payload.capabilities=caps.split(/[\s,]+/).filter(Boolean); }
  try{ await api('POST','/api/model-meta',payload); toast(t('savedMeta')); discover(); }
  catch(e){ toast(t('errPrefix')+e.message); }
}
async function setOrch(ref){ try{ await api('POST','/api/model',{ref:ref}); toast('orchestrator = '+ref); load(); }
  catch(e){ toast(t('errPrefix')+e.message); } }
`;
