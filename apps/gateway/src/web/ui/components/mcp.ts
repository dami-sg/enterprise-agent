/**
 * MCP servers component (gateway §7 / agent §2.7): list + add/update/delete +
 * enable/disable global MCP servers (ConfigStore writes <root>/mcp/<name>.json).
 * The add/update form toggles stdio (command/args) vs sse/http (url) fields.
 * Owns #mcp and the mc-* form fields.
 */
export const mcpCard = String.raw`
  <div class="card">
    <h2 data-i18n="mcpTitle"></h2>
    <p class="hint" data-i18n="mcpHint"></p>
    <div id="mcp"></div>
    <details open><summary data-i18n="mcpAdd"></summary>
      <div class="grid2" style="margin-top:10px">
        <div class="field" data-mcp="common"><label>name</label><input id="mc-name" placeholder="my-server" /></div>
        <div class="field" data-mcp="common"><label>transport</label>
          <select id="mc-transport" onchange="onMcpTransport()"><option>stdio</option><option>sse</option><option>http</option></select></div>
        <div class="field" data-mcp="stdio"><label>command</label><input id="mc-command" placeholder="npx" /></div>
        <div class="field" data-mcp="stdio"><label>args</label><input id="mc-args" placeholder="-y @scope/server" /></div>
        <div class="field" data-mcp="net"><label>url</label><input id="mc-url" placeholder="https://…/mcp" style="min-width:240px" /></div>
        <div class="field" data-mcp="common"><label>riskTier</label>
          <select id="mc-risk"><option value="">—</option><option>readonly</option><option>write</option><option>exec</option><option>network</option></select></div>
        <div class="field" data-mcp="common"><label class="muted"><input type="checkbox" id="mc-enabled" checked /> enabled</label></div>
      </div>
      <div class="field" data-mcp="common" style="margin-top:8px"><label data-i18n="mcpEnvLabel"></label>
        <textarea id="mc-env" rows="3" placeholder="API_KEY=keyRef:my-secret&#10;REGION=us"></textarea></div>
      <div class="row" style="margin-top:10px"><button onclick="saveMcp()" data-i18n="save"></button></div>
    </details>
  </div>
`;

export const mcpScript = String.raw`
var MCP=[];
RENDERERS.push(function(s){
  MCP=s.mcp||[];
  document.getElementById('mcp').innerHTML = MCP.length ?
    '<table><tr><th>name</th><th>transport</th><th data-i18n="colTarget">'+t('colTarget')+'</th><th>'+t('colEnabled')+'</th><th></th></tr>'+
    MCP.map(function(m){
      var target = m.transport==='stdio' ? ((m.command||'')+' '+((m.args||[]).join(' '))).trim() : (m.url||'');
      return '<tr><td>'+esc(m.name)+'</td><td>'+esc(m.transport)+'</td><td class="muted"><code>'+esc(target)+'</code></td>'+
      '<td>'+(m.enabled?t('yes'):t('enNo'))+'</td>'+
      '<td><button class="ghost" onclick="mcpEdit(\''+esc(m.name)+'\')">'+t('edit')+'</button> '+
      '<button class="ghost" onclick="mcpToggle(\''+esc(m.name)+'\','+(m.enabled?'false':'true')+')">'+(m.enabled?t('disable'):t('enable'))+'</button> '+
      '<button class="danger" onclick="mcpDelete(\''+esc(m.name)+'\')">'+t('colDelete')+'</button></td></tr>'; }).join('')+'</table>'
    : '<p class="muted">'+t('noMcp')+'</p>';
});
function onMcpTransport(){
  var tr=document.getElementById('mc-transport').value;
  var rows=document.querySelectorAll('[data-mcp]');
  for(var i=0;i<rows.length;i++){ var k=rows[i].getAttribute('data-mcp');
    var show = k==='common' || (k==='stdio'&&tr==='stdio') || (k==='net'&&tr!=='stdio');
    rows[i].style.display = show ? '' : 'none'; }
}
function mcpEnvText(env){ if(!env) return '';
  return Object.keys(env).map(function(k){ var v=env[k];
    return k+'='+((v&&typeof v==='object'&&v.keyRef)?('keyRef:'+v.keyRef):v); }).join('\n'); }
function mcpEnvParse(text){ var env={}; (text||'').split('\n').forEach(function(line){
  var s=line.trim(); if(!s) return; var i=s.indexOf('='); if(i<0) return;
  var k=s.slice(0,i).trim(); var v=s.slice(i+1).trim();
  env[k]= v.indexOf('keyRef:')===0 ? {keyRef:v.slice(7)} : v; });
  return Object.keys(env).length?env:undefined; }
function mcpEdit(name){
  var m=MCP.find(function(x){return x.name===name;}); if(!m) return;
  document.getElementById('mc-name').value=m.name;
  document.getElementById('mc-transport').value=m.transport;
  document.getElementById('mc-command').value=m.command||'';
  document.getElementById('mc-args').value=(m.args||[]).join(' ');
  document.getElementById('mc-url').value=m.url||'';
  document.getElementById('mc-risk').value=m.riskTier||'';
  document.getElementById('mc-enabled').checked=m.enabled!==false;
  document.getElementById('mc-env').value=mcpEnvText(m.env);
  onMcpTransport();
}
async function saveMcp(){
  try{
    var tr=document.getElementById('mc-transport').value;
    var cfg={ name:document.getElementById('mc-name').value.trim(), transport:tr,
      enabled:document.getElementById('mc-enabled').checked };
    if(tr==='stdio'){ cfg.command=document.getElementById('mc-command').value.trim();
      var a=document.getElementById('mc-args').value.trim(); if(a) cfg.args=a.split(/\s+/); }
    else { cfg.url=document.getElementById('mc-url').value.trim(); }
    var env=mcpEnvParse(document.getElementById('mc-env').value); if(env) cfg.env=env;
    var risk=document.getElementById('mc-risk').value; if(risk) cfg.riskTier=risk;
    await api('POST','/api/mcp',cfg); toast(t('updated')); load();
  }catch(e){ toast(t('errPrefix')+e.message); }
}
async function mcpToggle(name, enabled){
  try{ await api('POST','/api/mcp/enable',{name:name, enabled:enabled}); toast(t('updated')); load(); }
  catch(e){ toast(t('errPrefix')+e.message); } }
async function mcpDelete(name){ if(!confirm(ti('confirmDelMcp',name))) return;
  try{ await api('POST','/api/mcp/delete',{name:name}); toast(t('deleted')); load(); }
  catch(e){ toast(t('errPrefix')+e.message); } }
`;
