import { createRoot } from 'react-dom/client';
import { App } from './ui/App.tsx';
import './ui/styles.css';

const el = document.getElementById('root');
if (!el) throw new Error('缺少 #root 挂载点');
createRoot(el).render(<App />);
