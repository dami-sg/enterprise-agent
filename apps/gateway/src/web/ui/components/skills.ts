/**
 * Skills component (gateway §7 / agent §2.4): list + add (edit a single SKILL.md
 * or upload a zip bundle) + edit + delete skills under <root>/skills. Owns #skills
 * and the sk-* editor fields. A skill's `dir` (folder) is its identity for
 * edit/delete; add derives the folder from the SKILL.md frontmatter `name`.
 */
export const skillsCard = String.raw`
  <div class="card">
    <h2 data-i18n="skTitle"></h2>
    <p class="hint" data-i18n="skHint"></p>
    <div id="skills"></div>
    <details open><summary data-i18n="skAdd"></summary>
      <div class="row" style="margin-top:10px"><span class="muted" id="sk-editing"></span></div>
      <textarea id="sk-content" rows="12" placeholder="---&#10;name: my-skill&#10;description: what it does&#10;---&#10;# Steps…"></textarea>
      <div class="row" style="margin-top:8px">
        <button onclick="saveSkill()" data-i18n="save"></button>
        <button class="ghost" onclick="skillNew()" data-i18n="skNewBtn"></button>
      </div>
      <div class="row" style="margin-top:12px">
        <input type="file" id="sk-zip" accept=".zip,application/zip" />
        <button class="ghost" onclick="uploadZip()" data-i18n="skUploadZip"></button>
      </div>
    </details>
  </div>
`;

export const skillsScript = String.raw`
RENDERERS.push(function(s){
  var sk=s.skills||[];
  document.getElementById('skills').innerHTML = sk.length ?
    '<table><tr><th>'+t('colName')+'</th><th>'+t('colDesc')+'</th><th>'+t('colEnabled')+'</th><th></th></tr>'+
    sk.map(function(x){ return '<tr><td>'+esc(x.name)+'</td><td class="muted">'+esc(x.description)+'</td>'+
      '<td>'+(x.enabled?t('yes'):t('enNo'))+'</td>'+
      '<td><button class="ghost" onclick="skillEdit(\''+esc(x.dir)+'\')">'+t('edit')+'</button> '+
      '<button class="ghost" onclick="skillToggle(\''+esc(x.dir)+'\','+(x.enabled?'false':'true')+')">'+(x.enabled?t('disable'):t('enable'))+'</button> '+
      '<button class="danger" onclick="skillDelete(\''+esc(x.dir)+'\')">'+t('colDelete')+'</button></td></tr>'; }).join('')+'</table>'
    : '<p class="muted">'+t('noSkills')+'</p>';
});
var SKILL_EDIT='';
function skillNew(){ SKILL_EDIT=''; document.getElementById('sk-content').value='';
  document.getElementById('sk-editing').textContent=t('skNewHint'); }
async function skillEdit(dir){
  try{ var r=await api('GET','/api/skill/get?dir='+encodeURIComponent(dir));
    SKILL_EDIT=dir; document.getElementById('sk-content').value=r.content||'';
    document.getElementById('sk-editing').textContent=ti('skEditing',dir);
  }catch(e){ toast(t('errPrefix')+e.message); } }
async function saveSkill(){
  try{
    await api('POST','/api/skill',{ content:document.getElementById('sk-content').value, dir:SKILL_EDIT||undefined });
    toast(t('updated')); skillNew(); load();
  }catch(e){ toast(t('errPrefix')+e.message); } }
function skillFileB64(file){ return new Promise(function(res,rej){ var r=new FileReader();
  r.onload=function(){ var s=String(r.result); res(s.slice(s.indexOf(',')+1)); };
  r.onerror=function(){ rej(new Error('read failed')); }; r.readAsDataURL(file); }); }
async function uploadZip(){
  var f=document.getElementById('sk-zip').files[0]; if(!f){ toast(t('skPickZip')); return; }
  try{ var b64=await skillFileB64(f); await api('POST','/api/skill/zip',{ zip:b64 });
    toast(t('updated')); document.getElementById('sk-zip').value=''; load();
  }catch(e){ toast(t('errPrefix')+e.message); } }
async function skillToggle(dir, enabled){
  try{ await api('POST','/api/skill/enable',{dir:dir, enabled:enabled}); toast(t('updated')); load(); }
  catch(e){ toast(t('errPrefix')+e.message); } }
async function skillDelete(dir){ if(!confirm(ti('confirmDelSkill',dir))) return;
  try{ await api('POST','/api/skill/delete',{dir:dir}); toast(t('deleted')); load(); }
  catch(e){ toast(t('errPrefix')+e.message); } }
`;
