import React, { Component } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { initSentry, captureErr } from './sentry.js'

// Init Sentry en fire-and-forget — JAMAIS bloquer le render
// si DSN absent → no-op instantané (pas d'import Sentry chargé)
// si DSN présent → chargement async en arrière-plan
initSentry().catch(() => {})

// Error Boundary global — affiche le message d'erreur à l'écran
// au lieu de l'écran noir silencieux
class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  // Les erreurs survenues AVANT le montage de React n'atteignent pas le boundary :
  // on les attrape ici pour que l'écran les affiche aussi.
  static __bootError = null;
  static getDerivedStateFromError(e) { return { error: e }; }
  componentDidCatch(e, info) {
    console.error('VelohNav crash:', e, info);
    try { captureErr(e, { componentStack: info.componentStack }); } catch {}
  }
  render() {
    if (this.state.error) return (
      <div style={{background:'#080c0f',color:'#F5820D',padding:20,fontFamily:'monospace',minHeight:'100vh',fontSize:11}}>
        <div style={{fontSize:16,fontWeight:700,marginBottom:12}}>⚠ VelohNav — Erreur d'affichage</div>
        <pre style={{color:'#fff',whiteSpace:'pre-wrap',fontSize:10,marginBottom:16}}>
          {String(this.state.error && (this.state.error.stack || this.state.error))}
        </pre>
        <pre style={{color:'#8a94a6',whiteSpace:'pre-wrap',fontSize:9,marginBottom:16}}>
          {'moteur : ' + navigator.userAgent}
        </pre>
        <button onClick={()=>window.location.reload()}
          style={{padding:'8px 20px',background:'#F5820D',color:'#000',border:'none',cursor:'pointer',fontFamily:'monospace',fontWeight:700}}>
          Recharger
        </button>
      </div>
    );
    return this.props.children;
  }
}

// Erreurs de démarrage (avant React) : on les rejoue dans le boundary pour qu'elles
// s'affichent à l'écran au lieu d'un écran noir muet.
window.addEventListener('error', e => {
  if (ErrorBoundary.__bootError) return;
  ErrorBoundary.__bootError = e.error || new Error(e.message);
});
window.addEventListener('unhandledrejection', e => {
  if (ErrorBoundary.__bootError) return;
  ErrorBoundary.__bootError = e.reason instanceof Error ? e.reason : new Error(String(e.reason));
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
