import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import SalienceGatedCognition from './SalienceGatedCognition';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('SGC: #root element not found in index.html');
}

createRoot(rootEl).render(
  <StrictMode>
    <SalienceGatedCognition />
  </StrictMode>,
);
