/**
 * Readiness component (gateway §7): the core-model + ready-channels pills.
 * `markup` is the card shell; `script` registers its renderer on RENDERERS.
 */
export const statusCard = String.raw`
  <div class="card">
    <h2 data-i18n="statusTitle"></h2>
    <div id="status"></div>
  </div>
`;

export const statusScript = String.raw`
RENDERERS.push(function(s){
  var chans=(s.ready.channels||[]);
  document.getElementById('status').innerHTML=
    t('coreLabel')+(s.ready.core?'<span class="pill ok">'+t('ready')+'</span>':'<span class="pill no">'+t('notReady')+'</span>')+
    '　'+t('channelsLabel')+(chans.length? chans.map(function(c){return '<span class="pill ok">'+esc(c)+'</span>';}).join(' '):'<span class="muted">'+t('none')+'</span>');
});
`;
