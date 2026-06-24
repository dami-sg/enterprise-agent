/**
 * Schedules component (§7 定时编排): list + add/edit (a single SCHEDULE.md) +
 * enable/disable + delete + run-now, under <root>/schedules. Owns #schedules and
 * the sc-* editor fields. A schedule's `dir` (folder) is its identity for
 * edit/delete/enable; run-now uses the frontmatter `name`.
 */
export const schedulesCard = String.raw`
  <div class="card">
    <h2 data-i18n="scdTitle"></h2>
    <p class="hint" data-i18n="scdHint"></p>
    <div id="schedules"></div>
    <details open><summary data-i18n="scdAdd"></summary>
      <div class="row" style="margin-top:10px"><span class="muted" id="sc-editing"></span></div>
      <textarea id="sc-content" rows="14" placeholder="---&#10;name: daily-digest&#10;description: daily ops report&#10;cron: 0 9 * * *&#10;mode: auto&#10;deliver-to: telegram:ops-group&#10;---&#10;Summarize yesterday's merged PRs and CI failures."></textarea>
      <div class="row" style="margin-top:8px">
        <button onclick="saveSchedule()" data-i18n="save"></button>
        <button class="ghost" onclick="scheduleNew()" data-i18n="scdNewBtn"></button>
      </div>
    </details>
  </div>
`;

export const schedulesScript = String.raw`
RENDERERS.push(function(s){
  var sc=s.schedules||[];
  document.getElementById('schedules').innerHTML = sc.length ?
    '<table><tr><th>'+t('colName')+'</th><th>'+t('scdCron')+'</th><th>'+t('colDesc')+'</th><th>'+t('colEnabled')+'</th><th></th></tr>'+
    sc.map(function(x){ return '<tr><td>'+esc(x.name)+'</td><td class="muted">'+esc(x.cron||'—')+'</td><td class="muted">'+esc(x.description)+'</td>'+
      '<td>'+(x.enabled?t('yes'):t('enNo'))+'</td>'+
      '<td><button onclick="scheduleRun(\''+esc(x.name)+'\')">'+t('scdRun')+'</button> '+
      '<button class="ghost" onclick="scheduleEdit(\''+esc(x.dir)+'\')">'+t('edit')+'</button> '+
      '<button class="ghost" onclick="scheduleToggle(\''+esc(x.dir)+'\','+(x.enabled?'false':'true')+')">'+(x.enabled?t('disable'):t('enable'))+'</button> '+
      '<button class="danger" onclick="scheduleDelete(\''+esc(x.dir)+'\')">'+t('colDelete')+'</button></td></tr>'; }).join('')+'</table>'
    : '<p class="muted">'+t('noSchedules')+'</p>';
});
var SCHEDULE_EDIT='';
function scheduleNew(){ SCHEDULE_EDIT=''; document.getElementById('sc-content').value='';
  document.getElementById('sc-editing').textContent=t('scdNewHint'); }
async function scheduleEdit(dir){
  try{ var r=await api('GET','/api/schedule/get?dir='+encodeURIComponent(dir));
    SCHEDULE_EDIT=dir; document.getElementById('sc-content').value=r.content||'';
    document.getElementById('sc-editing').textContent=ti('scdEditing',dir);
  }catch(e){ toast(t('errPrefix')+e.message); } }
async function saveSchedule(){
  try{
    await api('POST','/api/schedule',{ content:document.getElementById('sc-content').value, dir:SCHEDULE_EDIT||undefined });
    toast(t('updated')); scheduleNew(); load();
  }catch(e){ toast(t('errPrefix')+e.message); } }
async function scheduleToggle(dir, enabled){
  try{ await api('POST','/api/schedule/enable',{dir:dir, enabled:enabled}); toast(t('updated')); load(); }
  catch(e){ toast(t('errPrefix')+e.message); } }
async function scheduleDelete(dir){ if(!confirm(ti('confirmDelSchedule',dir))) return;
  try{ await api('POST','/api/schedule/delete',{dir:dir}); toast(t('deleted')); load(); }
  catch(e){ toast(t('errPrefix')+e.message); } }
async function scheduleRun(name){
  try{ toast(t('scdRunning')); var r=await api('POST','/api/schedule/run',{name:name});
    toast(ti('scdRanToast', r.status||'done')); load();
  }catch(e){ toast(t('errPrefix')+e.message); } }
`;
