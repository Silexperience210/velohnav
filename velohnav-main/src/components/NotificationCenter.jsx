import { useEffect } from 'react';

const C = {
  bg: "#080c0f",
  card: "rgba(8,12,15,0.98)",
  border: "rgba(255,255,255,0.07)",
  accent: "#F5820D",
  good: "#2ECC8F",
  warn: "#F5A623",
  bad: "#E03E3E",
  text: "#E2E6EE",
  muted: "#4A5568",
  fnt: "'Courier New', monospace",
};

export function NotificationToast({ notification, onDismiss }) {
  useEffect(() => {
    if (!notification) return;
    
    const timer = setTimeout(() => {
      onDismiss?.();
    }, 5000);
    
    return () => clearTimeout(timer);
  }, [notification, onDismiss]);

  if (!notification) return null;

  return (
    <div style={{
      position: 'fixed',
      top: 100,
      left: 14,
      right: 14,
      zIndex: 2000,
      padding: '14px 16px',
      background: 'rgba(245,130,13,0.95)',
      borderRadius: 12,
      backdropFilter: 'blur(10px)',
      boxShadow: '0 10px 40px rgba(0,0,0,0.3)',
      animation: 'toastSlide 0.4s ease-out',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 24 }}>🔔</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>
            Alerte géolocalisée
          </div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.9)' }}>
            {notification.message}
          </div>
        </div>
        <button
          onClick={onDismiss}
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.2)',
            border: 'none',
            color: '#fff',
            fontSize: 16,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          ×
        </button>
      </div>
      
      {/* Barre de progression */}
      <div style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: 3,
        background: 'rgba(255,255,255,0.2)',
        borderRadius: '0 0 12px 12px',
        overflow: 'hidden',
      }}>
        <div style={{
          height: '100%',
          width: '100%',
          background: '#fff',
          animation: 'progress 5s linear forwards',
        }} />
      </div>

      <style>{`
        @keyframes toastSlide {
          from { transform: translateY(-20px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        @keyframes progress {
          from { width: 100%; }
          to { width: 0%; }
        }
      `}</style>
    </div>
  );
}

export function AlertSettings({ 
  alerts, 
  isOpen, 
  onClose, 
  onAddAlert, 
  onRemoveAlert, 
  onToggleAlert,
  stations,
  gpsPos,
}) {
  if (!isOpen) return null;

  const quickAlerts = [
    { type: 'nearby_bike', icon: '📍', title: 'Vélo à proximité', desc: 'Alerte quand je passe à côté d\'une station' },
    { type: 'rain_coming', icon: '🌧️', title: 'Pluie imminente', desc: 'Alerte météo active' },
  ];

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: C.bg,
      zIndex: 1000,
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{
        padding: '16px 14px',
        borderBottom: `1px solid ${C.border}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>
            🔔 Alertes
          </div>
          <div style={{ fontSize: 11, color: C.muted }}>
            {alerts.filter(a => a.active).length} alerte{alerts.filter(a => a.active).length > 1 ? 's' : ''} active
          </div>
        </div>
        <button
          onClick={onClose}
          style={{
            padding: '8px 12px',
            background: 'transparent',
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            color: C.muted,
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          ✕
        </button>
      </div>

      {/* Contenu */}
      <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
        
        {/* Alertes rapides */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 10, color: C.muted, letterSpacing: 2, marginBottom: 10 }}>
            ALERTES RAPIDES
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {quickAlerts.map(alert => {
              const isActive = alerts.some(a => a.type === alert.type && a.active);
              return (
                <button
                  key={alert.type}
                  onClick={() => {
                    if (isActive) {
                      const existing = alerts.find(a => a.type === alert.type);
                      if (existing) onRemoveAlert(existing.id);
                    } else {
                      onAddAlert({
                        type: alert.type,
                        title: alert.title,
                        radius: 100,
                        recurring: true,
                      });
                    }
                  }}
                  style={{
                    padding: 14,
                    background: isActive ? 'rgba(46,204,143,0.08)' : 'rgba(255,255,255,0.02)',
                    border: `1px solid ${isActive ? C.good : C.border}`,
                    borderRadius: 10,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ fontSize: 24 }}>{alert.icon}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
                      {alert.title}
                    </div>
                    <div style={{ fontSize: 10, color: C.muted }}>
                      {alert.desc}
                    </div>
                  </div>
                  <div style={{
                    width: 20,
                    height: 20,
                    borderRadius: '50%',
                    background: isActive ? C.good : 'transparent',
                    border: `2px solid ${isActive ? C.good : C.muted}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}>
                    {isActive && <span style={{ color: '#fff', fontSize: 12 }}>✓</span>}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Mes alertes */}
        {alerts.length > 0 && (
          <div>
            <div style={{ fontSize: 10, color: C.muted, letterSpacing: 2, marginBottom: 10 }}>
              MES ALERTES
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {alerts.map(alert => (
                <div
                  key={alert.id}
                  style={{
                    padding: 12,
                    background: alert.active ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.3)',
                    border: `1px solid ${alert.active ? C.border : 'transparent'}`,
                    borderRadius: 8,
                    opacity: alert.active ? 1 : 0.5,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <div>
                    <div style={{ fontSize: 12, color: C.text }}>
                      {alert.title}
                    </div>
                    <div style={{ fontSize: 9, color: C.muted }}>
                      {alert.type === 'nearby_bike' && `Rayon: ${alert.radius}m`}
                      {alert.type === 'station_available' && `Min: ${alert.minBikes} vélos`}
                      {alert.triggered && ' · Déclenchée'}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={() => onToggleAlert(alert.id)}
                      style={{
                        padding: '6px 10px',
                        background: alert.active ? C.good + '20' : C.muted + '20',
                        border: 'none',
                        borderRadius: 4,
                        color: alert.active ? C.good : C.muted,
                        fontSize: 10,
                        cursor: 'pointer',
                      }}
                    >
                      {alert.active ? 'ON' : 'OFF'}
                    </button>
                    <button
                      onClick={() => onRemoveAlert(alert.id)}
                      style={{
                        padding: '6px 10px',
                        background: C.bad + '20',
                        border: 'none',
                        borderRadius: 4,
                        color: C.bad,
                        fontSize: 10,
                        cursor: 'pointer',
                      }}
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
