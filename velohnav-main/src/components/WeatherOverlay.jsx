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

export function WeatherOverlay({ 
  weather, 
  advice, 
  gpsPos, 
  onRefresh,
  loading,
}) {
  // Rafraîchir la météo quand la position change significativement
  useEffect(() => {
    if (gpsPos && onRefresh) {
      onRefresh(gpsPos.lat, gpsPos.lng);
    }
  }, [gpsPos?.lat, gpsPos?.lng]); // eslint-disable-line

  if (!weather) {
    return (
      <div style={{
        position: 'absolute',
        top: 60,
        left: 14,
        zIndex: 20,
        padding: '10px 14px',
        background: 'rgba(8,12,15,0.9)',
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <span style={{ fontSize: 16 }}>🌡️</span>
        <span style={{ fontSize: 11, color: C.muted }}>
          {loading ? 'Chargement...' : 'Météo indisponible'}
        </span>
      </div>
    );
  }

  // Couleur selon température
  const tempColor = weather.temp < 5 ? '#60A5FA' :
                    weather.temp > 25 ? '#F59E0B' : 
                    C.text;

  // Alerte météo
  const hasAlert = advice && advice.urgency !== 'low';

  return (
    <div style={{
      position: 'absolute',
      top: 60,
      left: 14,
      right: 14,
      zIndex: 20,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }}>
      {/* Info météo principale */}
      <div style={{
        padding: '12px 14px',
        background: hasAlert ? 'rgba(224,62,62,0.15)' : 'rgba(8,12,15,0.9)',
        border: `1px solid ${hasAlert ? C.bad : C.border}`,
        borderRadius: 10,
        backdropFilter: 'blur(10px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 28 }}>{weather.icon}</span>
          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{ 
                fontSize: 20, 
                fontWeight: 800, 
                color: tempColor,
              }}>
                {weather.temp}°
              </span>
              <span style={{ fontSize: 11, color: C.muted }}>
                {weather.label}
              </span>
            </div>
            <div style={{ fontSize: 9, color: C.muted, marginTop: 2 }}>
              💨 {weather.windSpeed}km/h · 💧 {weather.humidity}%
            </div>
          </div>
        </div>

        {/* Bouton refresh */}
        <button
          onClick={() => gpsPos && onRefresh?.(gpsPos.lat, gpsPos.lng)}
          disabled={loading}
          style={{
            width: 32,
            height: 32,
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.05)',
            border: `1px solid ${C.border}`,
            color: C.muted,
            fontSize: 14,
            cursor: loading ? 'wait' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transform: loading ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.5s',
          }}
        >
          ↻
        </button>
      </div>

      {/* Alerte/Conseil */}
      {advice && (
        <div style={{
          padding: '12px 14px',
          background: advice.type === 'danger' ? 'rgba(224,62,62,0.9)' :
                      advice.type === 'warning' ? 'rgba(245,166,35,0.9)' :
                      advice.type === 'success' ? 'rgba(46,204,143,0.9)' :
                      'rgba(8,12,15,0.9)',
          borderRadius: 10,
          backdropFilter: 'blur(10px)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          animation: 'slideDown 0.3s ease-out',
          boxShadow: advice.urgency === 'high' ? `0 0 20px ${C.bad}50` : 'none',
        }}>
          <span style={{ fontSize: 24 }}>{advice.icon}</span>
          <div style={{ flex: 1 }}>
            <div style={{ 
              fontSize: 12, 
              fontWeight: 700, 
              color: advice.type === 'danger' || advice.type === 'warning' ? '#000' : C.text,
            }}>
              {advice.title}
            </div>
            <div style={{ 
              fontSize: 10, 
              color: advice.type === 'danger' || advice.type === 'warning' ? 'rgba(0,0,0,0.7)' : C.muted,
            }}>
              {advice.message}
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes slideDown {
          from { transform: translateY(-10px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

// Variante compacte pour l'écran AR
export function WeatherCompact({ weather, advice }) {
  if (!weather) return null;

  const hasAlert = advice && advice.urgency !== 'low';

  return (
    <div style={{
      position: 'absolute',
      top: 60,
      right: 14,
      zIndex: 20,
      padding: '8px 12px',
      background: hasAlert ? 'rgba(224,62,62,0.9)' : 'rgba(8,12,15,0.9)',
      border: `1px solid ${hasAlert ? C.bad : C.border}`,
      borderRadius: 20,
      backdropFilter: 'blur(10px)',
      display: 'flex',
      alignItems: 'center',
      gap: 6,
    }}>
      <span style={{ fontSize: 16 }}>{weather.icon}</span>
      <span style={{ 
        fontSize: 13, 
        fontWeight: 700, 
        color: hasAlert ? '#fff' : C.text,
      }}>
        {weather.temp}°
      </span>
      {hasAlert && <span style={{ fontSize: 12 }}>{advice.icon}</span>}
    </div>
  );
}
