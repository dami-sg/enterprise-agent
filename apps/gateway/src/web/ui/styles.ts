/**
 * Config panel styles (gateway §7). Plain CSS extracted from the page so the
 * shell and components stay readable; injected verbatim into the served <style>.
 */
export const STYLES = String.raw`
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background: #0e1117; color: #d6dae0; }
  header { padding: 18px 24px; border-bottom: 1px solid #232a36; display: flex; align-items: baseline; gap: 14px; }
  header h1 { font-size: 17px; margin: 0; font-weight: 650; }
  header .sub { color: #7e8794; font-size: 12px; }
  header .spacer { flex: 1; }
  #lang { background: #232a36; color: #cbd2dc; border: 1px solid #2b3340; border-radius: 7px; padding: 5px 11px;
          cursor: pointer; font: inherit; align-self: center; }
  .layout { max-width: 1120px; margin: 0 auto; display: flex; align-items: flex-start; }
  nav.side { width: 176px; flex: none; padding: 22px 12px; position: sticky; top: 0; }
  nav.side .nav { display: block; width: 100%; text-align: left; background: transparent; color: #aeb6c2;
                  border: 1px solid transparent; border-radius: 8px; padding: 9px 12px; margin-bottom: 4px; }
  nav.side .nav:hover { background: #161b24; filter: none; }
  nav.side .nav.active { background: #1b2330; color: #fff; border-color: #2b3340; }
  main { flex: 1; min-width: 0; padding: 22px; }
  section[data-tab] { display: none; }
  section[data-tab].active { display: block; }
  .card { background: #161b24; border: 1px solid #232a36; border-radius: 10px; padding: 18px 20px; margin-bottom: 18px; }
  .card h2 { font-size: 14px; margin: 0 0 4px; }
  .card .hint { color: #7e8794; font-size: 12px; margin: 0 0 14px; }
  .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field label { font-size: 11px; color: #8b94a3; }
  input, select { background: #0e1117; border: 1px solid #2b3340; color: #e6e9ee; border-radius: 7px;
                  padding: 7px 9px; font: inherit; min-width: 120px; }
  input:focus, select:focus { outline: none; border-color: #3b82f6; }
  textarea { width: 100%; background: #0e1117; border: 1px solid #2b3340; color: #e6e9ee; border-radius: 7px;
             padding: 8px 9px; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; resize: vertical; }
  textarea:focus { outline: none; border-color: #3b82f6; }
  button { background: #2563eb; color: #fff; border: 0; border-radius: 7px; padding: 7px 13px; font: inherit;
           cursor: pointer; }
  button.ghost { background: #232a36; color: #cbd2dc; }
  button.danger { background: #3a2326; color: #f1a3a3; }
  button:hover { filter: brightness(1.08); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #232a36; }
  th { color: #8b94a3; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 99px; font-size: 11px; }
  .ok { background: #14331f; color: #6ee79e; }
  .no { background: #3a2326; color: #f1a3a3; }
  .muted { color: #7e8794; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  #toast { position: fixed; right: 18px; bottom: 18px; background: #1b2330; border: 1px solid #2b3340;
           padding: 10px 14px; border-radius: 8px; opacity: 0; transition: opacity .2s; max-width: 360px; }
  #toast.show { opacity: 1; }
  code { background: #0e1117; padding: 1px 5px; border-radius: 4px; color: #9fb6e0; }
  .qr { margin-top: 12px; }
  .qr img { width: 220px; height: 220px; background: #fff; border-radius: 8px; padding: 8px; }
  details summary { cursor: pointer; color: #8b94a3; font-size: 12px; margin-top: 8px; }
  .banner { background: #3a2f14; border: 1px solid #5c4a1e; color: #e8c66b; padding: 9px 13px;
            border-radius: 8px; margin-bottom: 16px; display: flex; gap: 12px; align-items: center; font-size: 13px; }
  .banner button { padding: 4px 11px; background: #2563eb; }
`;
