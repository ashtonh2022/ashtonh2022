import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App';
import { preload } from './audio';
import './styles.css';

// Sounds are created lazily on the first interaction so autoplay policies do not complain.
window.addEventListener('pointerdown', preload, { once: true });
window.addEventListener('keydown', preload, { once: true });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
