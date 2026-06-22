/**
 * Media handling component (gateway §7 / multimodal §3.2): how inbound images
 * and PDFs are adapted to the orchestrator — passthrough to the model vs saved
 * for the agent. **Passthrough options are shown only when the current model
 * supports the modality** (read from /api/modalities); otherwise they're disabled
 * with a hint. Lives in the Models tab. No backticks / ${}.
 */
export const mediaCard = String.raw`
  <div class="card">
    <h2 data-i18n="mdTitle"></h2>
    <p class="hint" data-i18n="mdHint"></p>
    <div id="md-caps" class="hint" style="margin-bottom:10px"></div>
    <div class="row"><label data-i18n="mdImage"></label>
      <select id="md-image">
        <option value="auto" data-i18n="mdAuto"></option>
        <option value="passthrough" data-i18n="mdPassthrough"></option>
        <option value="off" data-i18n="mdOff"></option>
      </select>
    </div>
    <div class="row"><label data-i18n="mdPdf"></label>
      <select id="md-pdf">
        <option value="agent" data-i18n="mdAgent"></option>
        <option value="auto" data-i18n="mdPdfAuto"></option>
        <option value="passthrough" data-i18n="mdPassthrough"></option>
      </select>
    </div>
    <p class="hint" style="margin-top:12px" data-i18n="mdDeclare"></p>
    <div class="row">
      <label><input type="checkbox" id="md-decl-image" onchange="mdApplyCaps()" /> <span data-i18n="mdImage"></span></label>
      <label><input type="checkbox" id="md-decl-pdf" onchange="mdApplyCaps()" /> <span data-i18n="mdPdf"></span></label>
      <label><input type="checkbox" id="md-decl-audio" onchange="mdApplyCaps()" /> <span data-i18n="mdAudioWord"></span></label>
    </div>
    <div class="row" style="margin-top:12px"><button onclick="saveMedia()" data-i18n="mdSave"></button></div>
  </div>
`;

export const mediaScript = String.raw`
var MD_MODALITIES = { image:false, pdf:false, audio:false };
function mdChecked(id){ var e=document.getElementById(id); return !!(e && e.checked); }
// Effective modality = detected/declared on the server OR ticked live in the
// panel, so checking a box immediately enables its passthrough option (no
// save+reload round-trip needed to pick passthrough).
function mdEff(){ return {
  image: MD_MODALITIES.image || mdChecked('md-decl-image'),
  pdf:   MD_MODALITIES.pdf   || mdChecked('md-decl-pdf'),
  audio: MD_MODALITIES.audio || mdChecked('md-decl-audio'),
}; }
function mdApplyCaps(){
  // Disable passthrough when the model can't (and isn't declared to) accept that
  // modality (§3.2). auto stays available regardless.
  var eff = mdEff();
  var img = document.getElementById('md-image'), pdf = document.getElementById('md-pdf');
  if (img){ var io = img.querySelector('option[value=passthrough]'); if (io) io.disabled = !eff.image;
    if (!eff.image && img.value === 'passthrough') img.value = 'auto'; }
  if (pdf){ var po = pdf.querySelector('option[value=passthrough]'); if (po) po.disabled = !eff.pdf;
    if (!eff.pdf && pdf.value === 'passthrough') pdf.value = 'agent'; }
  var box = document.getElementById('md-caps');
  if (box) box.innerHTML = t('mdCaps') + ' ' +
    '<span class="pill ' + (eff.image?'ok':'') + '">' + (eff.image?'✓':'✗') + ' image</span> ' +
    '<span class="pill ' + (eff.pdf?'ok':'') + '">' + (eff.pdf?'✓':'✗') + ' pdf</span> ' +
    '<span class="pill ' + (eff.audio?'ok':'') + '">' + (eff.audio?'✓':'✗') + ' audio</span>';
}
RENDERERS.push(function(s){
  var m = s.media || {}; var d = m.modalities || {};
  var img = document.getElementById('md-image'); if (img && document.activeElement!==img) img.value = m.image || 'auto';
  var pdf = document.getElementById('md-pdf'); if (pdf && document.activeElement!==pdf) pdf.value = m.pdf || 'agent';
  var setChk = function(id, v){ var el=document.getElementById(id); if(el && document.activeElement!==el) el.checked = !!v; };
  setChk('md-decl-image', d.image); setChk('md-decl-pdf', d.pdf); setChk('md-decl-audio', d.audio);
  api('GET','/api/modalities').then(function(mod){ MD_MODALITIES = mod || MD_MODALITIES; mdApplyCaps(); }).catch(function(){ mdApplyCaps(); });
});
async function saveMedia(){
  try{
    await api('POST','/api/media', {
      image: document.getElementById('md-image').value,
      pdf: document.getElementById('md-pdf').value,
      modImage: document.getElementById('md-decl-image').checked,
      modPdf: document.getElementById('md-decl-pdf').checked,
      modAudio: document.getElementById('md-decl-audio').checked,
    });
    toast(t('updated')); load();
  }catch(e){ toast(t('errPrefix')+e.message); }
}
`;
