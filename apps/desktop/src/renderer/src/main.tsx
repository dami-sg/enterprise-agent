import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ArtifactWindowRoot } from './ArtifactWindowRoot';
import { BrowserWindowRoot } from './BrowserWindowRoot';
import './styles.css';

// The standalone popups load this same bundle at a route hash and render only
// their own chrome; everything else is the main app window.
const route = window.location.hash;
const isBrowserWindow = route === '#browser';
const isArtifactWindow = route === '#artifact';

// Theme (亮色/深色/跟随系统): main sets nativeTheme.themeSource from the saved
// setting, which Chromium reflects into prefers-color-scheme — mirroring the
// media query here covers all three modes with zero extra state. Applied before
// the first render to avoid a flash of the wrong theme.
const dark = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = (): void => {
  document.documentElement.classList.toggle('dark', dark.matches);
};
applyTheme();
dark.addEventListener('change', applyTheme);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isBrowserWindow ? <BrowserWindowRoot /> : isArtifactWindow ? <ArtifactWindowRoot /> : <App />}
  </StrictMode>,
);
