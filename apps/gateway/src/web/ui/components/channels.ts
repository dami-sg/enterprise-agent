/**
 * Channels component (gateway §7, sec ②): the channels table (with inline
 * mode/approval editors) and the add/update form. Owns #channels and the c-*
 * form fields.
 */
export const channelsCard = String.raw`
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
          <select id="c-mode"><option>ask</option><option>auto</option><option>plan</option><option>full</option></select></div>
        <div class="field" data-chan="common"><label data-i18n="wdLabel"></label><input id="c-wd" placeholder="/srv/ws/tg" /></div>
        <div class="field" data-chan="common"><label data-i18n="approvalLabel"></label>
          <select id="c-approval"><option>reject</option><option>auto:once</option><option>auto:session</option></select></div>
        <div class="field" data-chan="common"><label data-i18n="resetLabel"></label>
          <select id="c-reset" onchange="onReset()"><option value="" data-i18n="resetNone"></option><option value="idle">idle</option><option value="daily">daily</option><option value="command">command</option></select></div>
        <div class="field" data-chan="common" id="c-reset-arg-wrap"><label data-i18n="resetArgLabel"></label><input id="c-reset-arg" placeholder="240 / 04:00" /></div>
        <div class="field" data-chan="common"><label data-i18n="adminsLabel"></label><input id="c-admins" placeholder="42,99" /></div>
        <div class="field" data-chan="common"><label data-i18n="workspaceLabel"></label>
          <select id="c-workspace"><option value="per-user">per-user</option><option value="shared">shared</option></select></div>
      </div>
      <p class="hint" data-chan="weixin" data-i18n="wxTokenHint" style="margin-top:8px"></p>
      <div class="row" style="margin-top:10px"><button onclick="saveChannel()" data-i18n="saveChannel"></button></div>
    </details>
  </div>
`;

export const channelsScript = String.raw`
RENDERERS.push(function(s){
  var cv=s.channels||[];
  document.getElementById('channels').innerHTML = cv.length ?
    '<table><tr><th>'+t('colChannel')+'</th><th>'+t('colAccount')+'</th><th>'+t('colEnabled')+'</th><th>'+t('colToken')+'</th><th title="'+esc(t('fullHint'))+'">'+t('colMode')+'</th><th>'+t('colApproval')+'</th><th></th></tr>'+
    cv.map(function(c,i){
      var mode=(c.session&&c.session.executionMode)||'ask';
      return '<tr><td>'+esc(c.name)+'</td><td class="muted">'+esc(c.accountId||'—')+'</td>'+
      '<td>'+(c.enabled?t('yes'):t('enNo'))+'</td><td>'+(c.hasToken?'<span class="pill ok">'+t('has')+'</span>':'<span class="pill no">'+t('no')+'</span>')+'</td>'+
      '<td><select id="mode-'+i+'">'+selOpts(['ask','auto','plan','full'],mode)+'</select></td>'+
      '<td><select id="appr-'+i+'">'+selOpts(['reject','auto:once','auto:session'],c.approval||'reject')+'</select></td>'+
      '<td><button onclick="saveChannelPolicy(\''+jsq(c.name)+'\',\''+jsq(c.accountId||'')+'\','+i+')">'+t('save')+'</button> '+
      '<button class="ghost" onclick="toggleChannel(\''+jsq(c.name)+'\',\''+jsq(c.accountId||'')+'\','+(c.enabled?'false':'true')+')">'+(c.enabled?t('disable'):t('enable'))+'</button> '+
      '<button class="danger" onclick="delChannel(\''+jsq(c.name)+'\',\''+jsq(c.accountId||'')+'\')">'+t('colDelete')+'</button></td></tr>'; }).join('')+'</table>'
    : '<p class="muted">'+t('noChannels')+'</p>';
});
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
    ch.workspace=document.getElementById('c-workspace').value;
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
async function saveChannelPolicy(name, acc, i){
  try{
    await api('POST','/api/channel/update',{ name:name, accountId:acc||undefined,
      executionMode:document.getElementById('mode-'+i).value,
      approval:document.getElementById('appr-'+i).value });
    toast(t('updated')); load();
  }catch(e){ toast(t('errPrefix')+e.message); } }
`;
