import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

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
    <App />
  </StrictMode>,
);
