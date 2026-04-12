import { useMemo } from 'react';

const fDist = (m) => (m < 1000 ? `${m}m` : `${(m / 1000).toFixed(1)}km`);
const fWalk = (m) => `${Math.round(m / 80)} min`;

export function StationDetail({ 
  station, 
  onClose, 
  onNavigate, 
  colors,
  userPos,
  onShowOnMap,
}) {
  if (!station) return null;

  const col = station.status === 'CLOSED' ? colors.closed :
              station.bikes === 0 ? colors.bad :
              station.bikes <= 2 ? colors.warn : colors.good;

  const statusLabel = station.status === 'CLOSED' ? 'FERMÉ' :
                      station.bikes === 0 ? 'VIDE' :
                      station.bikes <= 2 ? 'FAIBLE' : 'DISPO';

  // Calculer ETA à pied
  const walkTime = useMemo(() => {
    if (!station.dist) return null;
    return Math.round(station.dist / 80);
  }, [station.dist]);

  return (
    <div
      style={{
        margin: '0 12px 12px',
        background: colors.card,
        border: `1px solid ${colors.border}`,
        borderTop: `3px solid ${col}`,
        borderRadius: 16,
        padding: 16,
        boxShadow: '0 -4px 24px rgba(0,0,0,0.2)',
        animation: 'slideUp 0.2s ease',
      }}
    >
      <style>{`
        @keyframes slideUp {
          from { transform: translateY(20px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
      `}</style>

      {/* Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: 12,
        }}
      >
        <div style={{ flex: 1, marginRight: 12 }}>
          <h2
            style={{
              margin: 0,
              fontSize: 18,
              fontFamily: colors.fnt || 'monospace',
              fontWeight: 700,
              color: colors.text,
              lineHeight: 1.3,
            }}
          >
            {station.name}
          </h2>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginTop: 6,
              fontSize: 11,
              fontFamily: colors.fnt || 'monospace',
              color: colors.muted,
            }}
          >
            <span style={{ color: col, fontWeight: 700 }}>{statusLabel}</span>
            <span>·</span>
            <span>{fDist(station.dist)}</span>
            {walkTime && (
              <>
                <span>·</span>
                <span>{walkTime} min à pied</span>
              </>
            )}
            {station._mock && <span style={{ opacity: 0.5 }}>· estimé</span>}
          </div>
        </div>
        
        <button
          onPointerDown={onClose}
          style={{
            padding: '8px',
            background: 'transparent',
            border: 'none',
            color: colors.muted,
            fontSize: 18,
            cursor: 'pointer',
            lineHeight: 1,
          }}
        >
          ✕
        </button>
      </div>

      {/* Stats grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 12,
          padding: '16px 0',
          borderTop: `1px solid ${colors.border}`,
          borderBottom: `1px solid ${colors.border}`,
        }}
      >
        {[
          { label: 'VÉLOS', value: station.bikes, color: col },
          { label: 'ÉLEC', value: station.elec, color: '#60A5FA' },
          { label: 'MÉCA', value: station.meca || station.bikes - station.elec, color: colors.text },
          { label: 'DOCKS', value: station.docks, color: colors.muted },
        ].map((stat) => (
          <div key={stat.label} style={{ textAlign: 'center' }}>
            <div
              style={{
                fontSize: 28,
                fontFamily: colors.fnt || 'monospace',
                fontWeight: 700,
                color: stat.color,
                lineHeight: 1,
              }}
            >
              {stat.value}
            </div>
            <div
              style={{
                fontSize: 8,
                fontFamily: colors.fnt || 'monospace',
                color: colors.muted,
                letterSpacing: 1,
                marginTop: 4,
              }}
            >
              {stat.label}
            </div>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div
        style={{
          display: 'flex',
          gap: 10,
          marginTop: 16,
        }}
      >
        <a
          href={`https://www.google.com/maps/dir/?api=1&destination=${station.lat},${station.lng}&travelmode=walking`}
          target="_blank"
          rel="noopener noreferrer"
          onPointerDown={onNavigate}
          style={{
            flex: 1,
            padding: '14px',
            background: colors.accentBg,
            border: `1px solid ${colors.accent}`,
            borderRadius: 10,
            color: colors.accent,
            fontSize: 12,
            fontFamily: colors.fnt || 'monospace',
            fontWeight: 700,
            textAlign: 'center',
            textDecoration: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          }}
        >
          <span>↗</span>
          <span>Y ALLER</span>
        </a>
        
        {station.elec > 0 && (
          <div
            style={{
              padding: '14px 18px',
              background: 'rgba(96,165,250,0.1)',
              border: '1px solid #60A5FA',
              borderRadius: 10,
              color: '#60A5FA',
              fontSize: 11,
              fontFamily: colors.fnt || 'monospace',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span>⚡</span>
            <span>ÉLEC</span>
          </div>
        )}
      </div>

      {/* Dernier update */}
      {station.last_update && (
        <div
          style={{
            marginTop: 12,
            textAlign: 'center',
            fontSize: 8,
            fontFamily: colors.fnt || 'monospace',
            color: colors.muted,
          }}
        >
          Mis à jour: {new Date(station.last_update).toLocaleTimeString('fr', { hour: '2-digit', minute: '2-digit' })}
        </div>
      )}
    </div>
  );
}
