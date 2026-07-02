/**
 * Shared client runtime (gateway §7): DOM/JSON helpers and the render registry.
 * Each component registers a `function(state)` on `RENDERERS`; `load()` fetches
 * `/api/state` once and fans it out — so a section is added by dropping in a
 * component module, never by editing a central `load`. No backticks / ${}.
 */
export const RUNTIME_SCRIPT = String.raw`
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
// Safe interpolation of a value into a JS STRING inside an HTML attribute (e.g.
// onclick="fn('"+jsq(x)+"')"). esc() alone is unsafe there: the HTML parser
// decodes &#39; back to ' before the JS runs, so a value with a quote could break
// out. Backslash-escape the JS metacharacters FIRST, then HTML-escape.
function jsq(s){ return esc(String(s==null?'':s).replace(/[\\'"\n\r]/g, function(c){
  return {'\\':'\\\\',"'":"\\'",'"':'\\"','\n':'\\n','\r':'\\r'}[c]; })); }
// Build <option>s, keeping the current value selected (and present even if it
// isn't one of the offered presets, e.g. an advanced "policy:<file>" approval).
function selOpts(vals, cur){
  var list = vals.indexOf(cur)>=0 ? vals : [cur].concat(vals);
  return list.map(function(v){ return '<option'+(v===cur?' selected':'')+'>'+esc(v)+'</option>'; }).join(''); }
function toast(msg){ var t2=document.getElementById('toast'); t2.textContent=msg; t2.classList.add('show');
  clearTimeout(t2._h); t2._h=setTimeout(function(){ t2.classList.remove('show'); }, 3200); }
async function api(method, path, body){
  var opt={ method: method, headers: {'content-type':'application/json'} };
  if(body!==undefined) opt.body=JSON.stringify(body);
  var r=await fetch(path, opt);
  var j=await r.json().catch(function(){ return {}; });
  if(!r.ok) throw new Error(j.error || ('HTTP '+r.status));
  return j;
}
// Sidebar navigation: show one tab's section, highlight its nav button, remember it.
function showTab(name){
  var secs=document.querySelectorAll('[data-tab]');
  for(var i=0;i<secs.length;i++){ secs[i].classList.toggle('active', secs[i].getAttribute('data-tab')===name); }
  var btns=document.querySelectorAll('[data-tab-btn]');
  for(var j=0;j<btns.length;j++){ btns[j].classList.toggle('active', btns[j].getAttribute('data-tab-btn')===name); }
  try{ localStorage.setItem('ea-gw-tab', name); }catch(e){}
}
// Components push render(state) callbacks here; load() invokes each in order.
var RENDERERS=[];
async function load(){
  var s;
  try { s=await api('GET','/api/state'); } catch(e){ return; }
  for(var i=0;i<RENDERERS.length;i++){ try{ RENDERERS[i](s); }catch(e){} }
}
`;
