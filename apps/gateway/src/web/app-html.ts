/**
 * The gateway config panel's single page (gateway §7), composed from per-section
 * UI components under `ui/`. Embedded as one string so the compiled `dist` stays
 * self-contained (no asset copying, no front-end build): the shell here lays out
 * a sidebar + three tabs (Status / Models / Channels), stitches the shared styles
 * + each component's `markup`, then concatenates every component's client `script`
 * into one <script> (so hoisting / boot order is unchanged). Components avoid
 * backticks / ${} so they sit inside these template literals verbatim.
 */
import { STYLES } from './ui/styles.js';
import { I18N_SCRIPT } from './ui/i18n.js';
import { RUNTIME_SCRIPT } from './ui/runtime.js';
import { statusCard, statusScript } from './ui/components/status.js';
import { gatewayCard, gatewayScript } from './ui/components/gateway.js';
import { coreCard, coreScript } from './ui/components/core.js';
import { sttCard, sttScript } from './ui/components/stt.js';
import { mediaCard, mediaScript } from './ui/components/media.js';
import { channelsCard, channelsScript } from './ui/components/channels.js';
import { weixinCard, weixinScript } from './ui/components/weixin.js';
import { miscCard, miscScript } from './ui/components/misc.js';
import { mcpCard, mcpScript } from './ui/components/mcp.js';
import { skillsCard, skillsScript } from './ui/components/skills.js';

/** Tabs: each holds the cards shown under its sidebar nav item. */
const TABS = String.raw`
    <section data-tab="status">${statusCard}${gatewayCard}</section>
    <section data-tab="models">${coreCard}${sttCard}${mediaCard}</section>
    <section data-tab="channels">${channelsCard}${weixinCard}${miscCard}</section>
    <section data-tab="mcp">${mcpCard}</section>
    <section data-tab="skills">${skillsCard}</section>
`;

/** Client scripts: i18n + runtime first (helpers + `load` + `showTab`), then each
 *  component registers its renderer / handlers, then boot. One <script>, so
 *  declarations hoist across all of it and the boot line runs last. */
const SCRIPT = [
  I18N_SCRIPT,
  RUNTIME_SCRIPT,
  statusScript,
  gatewayScript,
  coreScript,
  sttScript,
  mediaScript,
  channelsScript,
  weixinScript,
  miscScript,
  mcpScript,
  skillsScript,
  "onReset(); onChannelKind(); onMcpTransport(); showTab(localStorage.getItem('ea-gw-tab')||'status'); applyLang();",
].join('\n');

export const APP_HTML = String.raw`<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Enterprise Agent Gateway</title>
<style>${STYLES}</style>
</head>
<body>
<header>
  <h1 data-i18n="title"></h1>
  <span class="sub" data-i18n="sub"></span>
  <span class="spacer"></span>
  <button id="lang" onclick="toggleLang()"></button>
</header>
<div class="layout">
  <nav class="side">
    <button class="nav" data-tab-btn="status" onclick="showTab('status')" data-i18n="navStatus"></button>
    <button class="nav" data-tab-btn="models" onclick="showTab('models')" data-i18n="navModels"></button>
    <button class="nav" data-tab-btn="channels" onclick="showTab('channels')" data-i18n="navChannels"></button>
    <button class="nav" data-tab-btn="mcp" onclick="showTab('mcp')" data-i18n="navMcp"></button>
    <button class="nav" data-tab-btn="skills" onclick="showTab('skills')" data-i18n="navSkills"></button>
  </nav>
  <main>
    <div id="gw-banner"></div>
${TABS}
  </main>
</div>
<div id="toast"></div>

<script>
${SCRIPT}
</script>
</body>
</html>`;
