/**
 * Usage analytics component (gateway §7) — a read-only lens over the durable
 * usage ledger (agent §2.7). Pick a grouping dimension; the panel renders the
 * token + cost rollup. Owns #u-by and #usage.
 */
export const usageCard = String.raw`
  <div class="card">
    <h2 data-i18n="usageSec"></h2>
    <p class="hint" data-i18n="usageHint"></p>
    <div class="row">
      <div class="field"><label data-i18n="usageBy"></label>
        <select id="u-by" onchange="loadUsage()">
          <option value="day" data-i18n="uByDay"></option>
          <option value="month" data-i18n="uByMonth"></option>
          <option value="modelRef" data-i18n="uByModel"></option>
          <option value="provider" data-i18n="uByProvider"></option>
          <option value="agentId" data-i18n="uByAgent"></option>
          <option value="category" data-i18n="uByCategory"></option>
          <option value="day,modelRef" data-i18n="uByDayModel"></option>
          <option value="entryId" data-i18n="uByMessage"></option>
        </select></div>
      <button class="ghost" onclick="loadUsage()" data-i18n="usageRefresh"></button>
    </div>
    <div id="usage"></div>
  </div>
`;

export const usageScript = String.raw`
function ufmt(n){ n=n||0; return n>=1e6?(n/1e6).toFixed(2)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':String(n); }
async function loadUsage(){
  var by=document.getElementById('u-by').value;
  document.getElementById('usage').innerHTML='<p class="muted">…</p>';
  try{
    var rows=await api('GET','/api/usage?by='+encodeURIComponent(by));
    var dims=by.split(',');
    if(!rows.length){ document.getElementById('usage').innerHTML='<p class="muted">'+t('usageNone')+'</p>'; return; }
    var head=dims.map(function(d){ return '<th>'+esc(d)+'</th>'; }).join('')+
      '<th data-i18n="uColIn">in</th><th data-i18n="uColOut">out</th><th>$</th><th data-i18n="uColCalls">calls</th>';
    var tot={inp:0,out:0,cost:0,calls:0};
    var body=rows.slice(0,300).map(function(r){
      tot.inp+=r.inputTokens; tot.out+=r.outputTokens; tot.cost+=r.cost; tot.calls+=r.calls;
      var k=dims.map(function(d){ return '<td><code>'+esc(String(r.key[d]||''))+'</code></td>'; }).join('');
      return '<tr>'+k+'<td class="muted">'+ufmt(r.inputTokens)+'</td><td class="muted">'+ufmt(r.outputTokens)+
        '</td><td>$'+r.cost.toFixed(4)+'</td><td class="muted">'+r.calls+'</td></tr>';
    }).join('');
    document.getElementById('usage').innerHTML='<table><tr>'+head+'</tr>'+body+'</table>'+
      '<p class="muted">'+t('usageTotal')+' in '+ufmt(tot.inp)+' · out '+ufmt(tot.out)+' · $'+tot.cost.toFixed(4)+' · '+tot.calls+'</p>';
    if(window.applyLang) applyLang();
  }catch(e){ document.getElementById('usage').innerHTML='<p class="no">'+esc(e.message)+'</p>'; }
}
`;
