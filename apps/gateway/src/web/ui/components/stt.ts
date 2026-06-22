/**
 * ASR / speech-to-text component (gateway §7 / multimodal §7): configures the
 * `stt` block of gateway.json — the backend that transcribes inbound voice
 * messages (OpenAI Whisper / StepFun / any OpenAI-compatible endpoint). The API
 * key goes to the keychain only. Lives in the Models tab. No backticks / ${}.
 */
export const sttCard = String.raw`
  <div class="card">
    <h2 data-i18n="sttTitle"></h2>
    <p class="hint" data-i18n="sttHint"></p>
    <div class="row"><label data-i18n="sttProvider"></label>
      <select id="stt-provider">
        <option value="" data-i18n="sttOff"></option>
        <option value="openai">OpenAI Whisper</option>
        <option value="stepfun">StepFun</option>
        <option value="custom" data-i18n="sttCustom"></option>
      </select>
    </div>
    <div class="row"><label data-i18n="sttKey"></label> <input id="stt-key" type="password" autocomplete="off" /></div>
    <div class="row"><label data-i18n="sttModel"></label> <input id="stt-model" placeholder="whisper-1 / step-asr" /></div>
    <div class="row"><label data-i18n="sttBase"></label> <input id="stt-base" placeholder="https://…/v1" /></div>
    <div class="row"><label data-i18n="sttLang"></label> <input id="stt-lang" placeholder="zh" /></div>
    <div class="row" style="margin-top:12px"><button onclick="saveStt()" data-i18n="sttSave"></button></div>
  </div>
`;

export const sttScript = String.raw`
RENDERERS.push(function(s){
  var st = s.stt || {};
  var prov = document.getElementById('stt-provider');
  if (prov && document.activeElement !== prov) prov.value = st.provider || '';
  var set = function(id, v){ var el=document.getElementById(id); if(el && document.activeElement!==el) el.value = (v==null?'':v); };
  set('stt-model', st.model); set('stt-base', st.baseURL); set('stt-lang', st.language);
  var key = document.getElementById('stt-key');
  if (key && document.activeElement !== key){ key.value=''; key.placeholder = st.hasKey ? t('sttKeySaved') : t('sttKeyPh'); }
});
async function saveStt(){
  try{
    await api('POST','/api/stt', {
      provider: document.getElementById('stt-provider').value,
      apiKey: document.getElementById('stt-key').value,
      model: document.getElementById('stt-model').value.trim(),
      baseURL: document.getElementById('stt-base').value.trim(),
      language: document.getElementById('stt-lang').value.trim(),
    });
    toast(t('updated')); load();
  }catch(e){ toast(t('errPrefix')+e.message); }
}
`;
