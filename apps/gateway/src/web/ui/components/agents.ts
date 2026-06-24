/**
 * Agents component (declarative sub-agents, agent §2.3): list + add (edit a single
 * AGENT.md or upload a zip bundle) + edit + enable/disable + delete agents under
 * <root>/agents. Owns #agents and the ag-* editor fields. An agent's `dir` (folder)
 * is its identity for edit/delete; add derives the folder from the AGENT.md
 * frontmatter `name`. Mirrors the skills component.
 */
export const agentsCard = String.raw`
  <div class="card">
    <h2 data-i18n="agTitle"></h2>
    <p class="hint" data-i18n="agHint"></p>
    <div id="agents"></div>
    <details><summary data-i18n="agBuiltinTitle"></summary>
      <p class="hint" data-i18n="agBuiltinHint"></p>
      <div id="bundled-agents"></div>
    </details>
    <details open><summary data-i18n="agAdd"></summary>
      <div class="row" style="margin-top:10px"><span class="muted" id="ag-editing"></span></div>
      <textarea id="ag-content" rows="14" placeholder="---&#10;name: my-agent&#10;description: what it specializes in&#10;tools: read, exec&#10;mcp: true&#10;---&#10;You are a focused sub-agent…"></textarea>
      <div class="row" style="margin-top:8px">
        <button onclick="saveAgent()" data-i18n="save"></button>
        <button class="ghost" onclick="agentNew()" data-i18n="agNewBtn"></button>
      </div>
      <div class="row" style="margin-top:12px">
        <input type="file" id="ag-zip" accept=".zip,application/zip" />
        <button class="ghost" onclick="uploadAgentZip()" data-i18n="agUploadZip"></button>
      </div>
    </details>
  </div>
`;

export const agentsScript = String.raw`
RENDERERS.push(function(s){
  var ag=s.agents||[];
  document.getElementById('agents').innerHTML = ag.length ?
    '<table><tr><th>'+t('colName')+'</th><th>'+t('colDesc')+'</th><th>'+t('colEnabled')+'</th><th></th></tr>'+
    ag.map(function(x){ return '<tr><td>'+esc(x.name)+'</td><td class="muted">'+esc(x.description)+'</td>'+
      '<td>'+(x.enabled?t('yes'):t('enNo'))+'</td>'+
      '<td><button class="ghost" onclick="agentEdit(\''+esc(x.dir)+'\')">'+t('edit')+'</button> '+
      '<button class="ghost" onclick="agentToggle(\''+esc(x.dir)+'\','+(x.enabled?'false':'true')+')">'+(x.enabled?t('disable'):t('enable'))+'</button> '+
      '<button class="danger" onclick="agentDelete(\''+esc(x.dir)+'\')">'+t('colDelete')+'</button></td></tr>'; }).join('')+'</table>'
    : '<p class="muted">'+t('noAgents')+'</p>';
});
RENDERERS.push(function(s){
  var ba=s.bundledAgents||[]; var box=document.getElementById('bundled-agents'); if(!box) return;
  box.innerHTML = ba.length ?
    '<table><tr><th>'+t('colName')+'</th><th>'+t('colDesc')+'</th><th></th></tr>'+
    ba.map(function(x){ return '<tr><td>'+esc(x.name)+'</td><td class="muted">'+esc((x.description||'').slice(0,140))+'</td>'+
      '<td>'+(x.installed
        ? '<span class="pill ok">'+t('agInstalled')+'</span> <button class="ghost" onclick="installBundledAgent(\''+esc(x.dir)+'\')">'+t('agReinstall')+'</button>'
        : '<button onclick="installBundledAgent(\''+esc(x.dir)+'\')">'+t('agInstall')+'</button>')+'</td></tr>'; }).join('')+'</table>'
    : '<p class="muted">'+t('agNoBuiltin')+'</p>';
});
async function installBundledAgent(dir){
  try{ await api('POST','/api/agent/bundled/install',{dir:dir}); toast(t('agInstalledToast')); load(); }
  catch(e){ toast(t('errPrefix')+e.message); }
}
var AGENT_EDIT='';
function agentNew(){ AGENT_EDIT=''; document.getElementById('ag-content').value='';
  document.getElementById('ag-editing').textContent=t('agNewHint'); }
async function agentEdit(dir){
  try{ var r=await api('GET','/api/agent/get?dir='+encodeURIComponent(dir));
    AGENT_EDIT=dir; document.getElementById('ag-content').value=r.content||'';
    document.getElementById('ag-editing').textContent=ti('agEditing',dir);
  }catch(e){ toast(t('errPrefix')+e.message); } }
async function saveAgent(){
  try{
    await api('POST','/api/agent',{ content:document.getElementById('ag-content').value, dir:AGENT_EDIT||undefined });
    toast(t('updated')); agentNew(); load();
  }catch(e){ toast(t('errPrefix')+e.message); } }
function agentFileB64(file){ return new Promise(function(res,rej){ var r=new FileReader();
  r.onload=function(){ var s=String(r.result); res(s.slice(s.indexOf(',')+1)); };
  r.onerror=function(){ rej(new Error('read failed')); }; r.readAsDataURL(file); }); }
async function uploadAgentZip(){
  var f=document.getElementById('ag-zip').files[0]; if(!f){ toast(t('agPickZip')); return; }
  try{ var b64=await agentFileB64(f); await api('POST','/api/agent/zip',{ zip:b64 });
    toast(t('updated')); document.getElementById('ag-zip').value=''; load();
  }catch(e){ toast(t('errPrefix')+e.message); } }
async function agentToggle(dir, enabled){
  try{ await api('POST','/api/agent/enable',{dir:dir, enabled:enabled}); toast(t('updated')); load(); }
  catch(e){ toast(t('errPrefix')+e.message); } }
async function agentDelete(dir){ if(!confirm(ti('confirmDelAgent',dir))) return;
  try{ await api('POST','/api/agent/delete',{dir:dir}); toast(t('deleted')); load(); }
  catch(e){ toast(t('errPrefix')+e.message); } }
`;
