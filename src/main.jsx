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
  static getDerivedStateFromError(e) { return { error: e }; }
  componentDidCatch(e, info) {
    console.error('VelohNav crash:', e, info);
    try { captureErr(e, { componentStack: info.componentStack }); } catch {}
  }
  render() {
    if (this.state.error) return (
      <div style={{background:'#080c0f',color:'#F5820D',padding:20,fontFamily:'monospace',minHeight:'100vh',fontSize:11}}>
        <div style={{fontSize:16,fontWeight:700,marginBottom:12}}>⚠ VelohNav — Erreur au démarrage</div>
        <pre style={{color:'#fff',whiteSpace:'pre-wrap',fontSize:10,marginBottom:16}}>
          {String(this.state.error)}
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

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
