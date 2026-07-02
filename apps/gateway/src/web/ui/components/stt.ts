/**
 * ASR / speech-to-text component (gateway §7 / multimodal §7): manages the `stt`
 * list of gateway.json — the backends that transcribe inbound voice messages
 * (OpenAI Whisper / StepFun / any OpenAI-compatible endpoint). Mirrors the
 * model-core providers table: saved backends are listed, one is marked active
 * (it transcribes voice), and the form below adds or updates an entry keyed by
 * id. API keys go to the keychain only. Lives in the Models tab. No backticks / ${}.
 */
export const sttCard = String.raw`
  <div class="card">
    <h2 data-i18n="sttTitle"></h2>
    <p class="hint" data-i18n="sttHint"></p>
    <div id="stt-list"></div>
    <div class="row" style="margin-top:12px">
      <div class="field"><label data-i18n="sttProvider"></label>
        <select id="stt-provider" onchange="sttPreset()">
          <option value="openai">OpenAI Whisper</option>
          <option value="stepfun">StepFun</option>
          <option value="custom" data-i18n="sttCustom"></option>
        </select></div>
      <div class="field"><label data-i18n="sttId"></label><input id="stt-id" data-i18n-ph="sttIdPh" /></div>
      <div class="field"><label data-i18n="sttModel"></label><input id="stt-model" placeholder="whisper-1 / step-asr" /></div>
      <div class="field"><label data-i18n="sttBase"></label><input id="stt-base" placeholder="https://…/v1" style="min-width:200px" /></div>
      <div class="field"><label data-i18n="sttLang"></label><input id="stt-lang" placeholder="zh" /></div>
      <div class="field"><label data-i18n="sttKey"></label><input id="stt-key" type="password" autocomplete="off" /></div>
      <button onclick="saveStt()" data-i18n="sttAdd"></button>
    </div>
  </div>
`;

export const sttScript = String.raw`
function sttPreset(){
  // Default the id to the chosen preset so single-backend setups need no id.
  var prov = document.getElementById('stt-provider').value;
  var id = document.getElementById('stt-id');
  if (id && (!id.value.trim() || id.dataset.auto === '1')){ id.value = prov === 'custom' ? '' : prov; id.dataset.auto = '1'; }
}
RENDERERS.push(function(s){
  var stt = s.stt || {}; var entries = stt.entries || []; var active = stt.active || '';
  var box = document.getElementById('stt-list');
  if (box) box.innerHTML = entries.length ?
    '<table><tr><th>id</th><th>provider</th><th>model</th><th>baseURL</th><th>'+t('colKey')+'</th><th>'+t('sttActiveCol')+'</th><th></th></tr>'+
    entries.map(function(e){
      var on = e.id === active;
      return '<tr><td><code>'+esc(e.id)+'</code></td><td>'+esc(e.provider||'—')+'</td><td>'+esc(e.model||'—')+'</td>'+
        '<td class="muted">'+esc(e.baseURL||'—')+'</td>'+
        '<td>'+(e.hasKey?'<span class="pill ok">'+t('has')+'</span>':'<span class="pill no">'+t('no')+'</span>')+'</td>'+
        '<td>'+(on?'<span class="pill ok">'+t('sttOn')+'</span>'
                  :'<button onclick="setSttActive(\''+jsq(e.id)+'\')">'+t('sttUse')+'</button>')+'</td>'+
        '<td><button class="danger" onclick="delStt(\''+jsq(e.id)+'\')">'+t('colDelete')+'</button></td></tr>';
    }).join('')+'</table>'
    : '<p class="muted">'+t('sttNone')+'</p>';
  var key = document.getElementById('stt-key');
  if (key && document.activeElement !== key){ key.placeholder = t('sttKeyPh'); }
});
async function saveStt(){
  try{
    await api('POST','/api/stt', {
      id: document.getElementById('stt-id').value.trim(),
      provider: document.getElementById('stt-provider').value,
      apiKey: document.getElementById('stt-key').value,
      model: document.getElementById('stt-model').value.trim(),
      baseURL: document.getElementById('stt-base').value.trim(),
      language: document.getElementById('stt-lang').value.trim(),
    });
    document.getElementById('stt-key').value='';
    var id=document.getElementById('stt-id'); id.value=''; id.dataset.auto='1';
    toast(t('updated')); load();
  }catch(e){ toast(t('errPrefix')+e.message); }
}
async function setSttActive(id){
  try{ await api('POST','/api/stt/active',{id:id}); toast(t('updated')); load(); }
  catch(e){ toast(t('errPrefix')+e.message); }
}
async function delStt(id){
  if(!confirm(ti('sttConfirmDel', id))) return;
  try{ await api('POST','/api/stt/delete',{id:id}); toast(t('deleted')); load(); }
  catch(e){ toast(t('errPrefix')+e.message); }
}
`;
