import { useEffect, useState } from 'react';
import { calculateBearing } from '../hooks/useDeviceOrientation';

const fDist = (m) => (m < 1000 ? `${m}m` : `${(m / 1000).toFixed(1)}km`);

/**
 * Mode navigation full-screen
 * Affiche la direction vers la station sélectionnée
 */
export function NavigationMode({ 
  target, 
  userPos, 
  heading, 
  onExit, 
  colors,
  onProximity,
}) {
  const [arrowRotation, setArrowRotation] = useState(0);

  useEffect(() => {
    if (!userPos || !target) return;
    
    const bearing = calculateBearing(userPos.lat, userPos.lng, target.lat, target.lng);
    let rotation = bearing - heading;
    
    // Normaliser
    while (rotation > 180) rotation -= 360;
    while (rotation < -180) rotation += 360;
    
    setArrowRotation(rotation);
    
    // Vibration de proximité
    if (onProximity && target.dist) {
      onProximity(target.dist);
    }
  }, [userPos, target, heading, onProximity]);

  if (!target) return null;

  const col = target.status === 'CLOSED' ? colors.closed :
              target.bikes === 0 ? colors.bad :
              target.bikes <= 2 ? colors.warn : colors.good;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: colors.bg,
        zIndex: 100,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      {/* Bouton fermer */}
      <button
        onPointerDown={onExit}
        style={{
          position: 'absolute',
          top: 20,
          left: 20,
          padding: '10px 16px',
          background: colors.card,
          border: `1px solid ${colors.border}`,
          borderRadius: 20,
          color: colors.text,
          fontSize: 12,
          fontFamily: colors.fnt || 'monospace',
          cursor: 'pointer',
        }}
      >
        ✕ ARRETER
      </button>

      {/* Nom station */}
      <h1
        style={{
          margin: '0 0 40px',
          fontSize: 24,
          fontFamily: colors.fnt || 'monospace',
          fontWeight: 700,
          color: colors.text,
          textAlign: 'center',
        }}
      >
        {target.name}
      </h1>

      {/* Flèche direction */}
      <div
        style={{
          width: 150,
          height: 150,
          borderRadius: '50%',
          border: `3px solid ${colors.border}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          marginBottom: 40,
        }}
      >
        {/* Cercles concentriques */}
        <div
          style={{
            position: 'absolute',
            inset: 20,
            borderRadius: '50%',
            border: `1px solid ${colors.border}`,
            opacity: 0.5,
          }}
        />
        
        {/* Flèche */}
        <div
          style={{
            fontSize: 80,
            color: col,
            transform: `rotate(${arrowRotation}deg)`,
            transition: 'transform 0.3s ease',
            filter: `drop-shadow(0 0 20px ${col})`,
            lineHeight: 1,
          }}
        >
          ↑
        </div>
      </div>

      {/* Distance */}
      <div
        style={{
          fontSize: 48,
          fontFamily: colors.fnt || 'monospace',
          fontWeight: 700,
          color: colors.text,
          marginBottom: 10,
        }}
      >
        {fDist(target.dist)}
      </div>

      {/* Vélos dispos */}
      <div
        style={{
          display: 'flex',
          gap: 20,
          marginBottom: 30,
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 32, color: col, fontWeight: 700 }}>{target.bikes}</div>
          <div style={{ fontSize: 10, color: colors.muted }}>vélos</div>
        </div>
        {target.elec > 0 && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 32, color: '#60A5FA', fontWeight: 700 }}>{target.elec}</div>
            <div style={{ fontSize: 10, color: colors.muted }}>élec</div>
          </div>
        )}
      </div>

      {/* Instructions */}
      <div
        style={{
          textAlign: 'center',
          color: colors.muted,
          fontSize: 12,
          fontFamily: colors.fnt || 'monospace',
          lineHeight: 1.6,
        }}
      >
        <p>Suis la flèche</p>
        <p style={{ opacity: 0.7 }}>Reste attentif à ton environnement</p>
      </div>

      {/* Barre de progression (distance) */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: 4,
          background: colors.border,
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${Math.max(0, Math.min(100, 100 - (target.dist / 1000) * 100))}%`,
            background: `linear-gradient(to right, ${col}, ${colors.accent})`,
            transition: 'width 0.5s ease',
          }}
        />
      </div>
    </div>
  );
}
