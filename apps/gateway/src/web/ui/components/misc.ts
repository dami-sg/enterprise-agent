/**
 * Routes / misc component (gateway §7, sec ④): the verbose toggle and the live
 * conversation→session routes table. Owns #verbose and #routes.
 */
export const miscCard = String.raw`
  <div class="card">
    <h2 data-i18n="sec4"></h2>
    <div class="row" style="margin-bottom:12px">
      <label class="muted"><input type="checkbox" id="verbose" onchange="setVerbose()" /> <span data-i18n="verboseLabel"></span></label>
    </div>
    <div id="routes"></div>
    <p class="hint" style="margin-top:14px" data-i18n-html="startHint"></p>
  </div>
`;

export const miscScript = String.raw`
RENDERERS.push(function(s){
  document.getElementById('verbose').checked=!!s.verbose;
  var rv=s.routes||[];
  document.getElementById('routes').innerHTML = rv.length ?
    '<table><tr><th>'+t('colRouteKey')+'</th><th>sessionId</th><th></th></tr>'+rv.map(function(r){
      var parts=r.key.split(':'); var chan=parts.shift(); var conv=parts.join(':');
      return '<tr><td><code>'+esc(r.key)+'</code></td><td class="muted">'+esc(r.entry.sessionId)+'</td>'+
      '<td><button class="ghost" onclick="delRoute(\''+jsq(chan)+'\',\''+jsq(conv)+'\')">'+t('unbind')+'</button></td></tr>'; }).join('')+'</table>'
    : '<p class="muted">'+t('noRoutes')+'</p>';
});
async function delRoute(chan, conv){ try{ await api('POST','/api/route/delete',{channel:chan, conversationId:conv}); toast(t('unbound')); load(); }
  catch(e){ toast(t('errPrefix')+e.message); } }
async function setVerbose(){ try{ await api('POST','/api/verbose',{verbose:document.getElementById('verbose').checked}); toast(t('updated')); }
  catch(e){ toast(t('errPrefix')+e.message); } }
`;
