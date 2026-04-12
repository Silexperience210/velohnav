import { useMemo } from 'react';
import { calculateBearing } from '../hooks/useDeviceOrientation';

/**
 * Mini radar qui montre les stations autour de l'utilisateur
 * S'affiche dans un coin de l'écran
 */
export function RadarView({ 
  stations, 
  userPos, 
  heading = 0, 
  selectedId,
  onSelect,
  colors,
  style = {} 
}) {
  const RADAR_SIZE = 120;
  const CENTER = RADAR_SIZE / 2;
  const MAX_DIST = 500; // Afficher stations jusqu'à 500m

  const radarStations = useMemo(() => {
    if (!userPos) return [];
    
    return stations
      .filter(s => s.dist <= MAX_DIST)
      .map(s => {
        // Calculer l'angle relatif au heading
        const bearing = calculateBearing(userPos.lat, userPos.lng, s.lat, s.lng);
        let angle = bearing - heading;
        
        // Normaliser
        while (angle > 180) angle -= 360;
        while (angle < -180) angle += 360;
        
        // Convertir en radians
        const rad = (angle * Math.PI) / 180;
        
        // Distance normalisée (0-1)
        const distNorm = s.dist / MAX_DIST;
        
        // Position sur le radar (polaire -> cartésien)
        // Y est inversé car canvas/SVG coordonnées
        const x = CENTER + Math.sin(rad) * (distNorm * (RADAR_SIZE/2 - 10));
        const y = CENTER - Math.cos(rad) * (distNorm * (RADAR_SIZE/2 - 10));
        
        return {
          ...s,
          x,
          y,
          angle,
        };
      });
  }, [stations, userPos, heading]);

  if (!userPos) return null;

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 100,
        right: 10,
        width: RADAR_SIZE,
        height: RADAR_SIZE,
        background: colors.card,
        border: `1px solid ${colors.border}`,
        borderRadius: '50%',
        overflow: 'hidden',
        boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
        zIndex: 30,
        ...style,
      }}
    >
      <svg width={RADAR_SIZE} height={RADAR_SIZE}>
        {/* Cercles concentriques */}
        {[0.33, 0.66, 1].map((r, i) => (
          <circle
            key={i}
            cx={CENTER}
            cy={CENTER}
            r={(RADAR_SIZE/2 - 10) * r}
            fill="none"
            stroke={colors.border}
            strokeWidth="1"
            opacity={0.5}
          />
        ))}
        
        {/* Ligne direction (Nord/Heading) */}
        <line
          x1={CENTER}
          y1={CENTER}
          x2={CENTER}
          y2={8}
          stroke={colors.accent}
          strokeWidth="2"
        />
        
        {/* Point central (utilisateur) */}
        <circle
          cx={CENTER}
          cy={CENTER}
          r={4}
          fill={colors.user}
        />
        
        {/* Flèche direction */}
        <polygon
          points={`${CENTER},6 ${CENTER-4},12 ${CENTER+4},12`}
          fill={colors.accent}
        />
        
        {/* Stations */}
        {radarStations.map(s => {
          const isSelected = s.id === selectedId;
          const col = s.status === 'CLOSED' ? colors.closed : 
                      s.bikes === 0 ? colors.bad : 
                      s.bikes <= 2 ? colors.warn : colors.good;
          
          return (
            <g
              key={s.id}
              onPointerDown={(e) => {
                e.stopPropagation();
                onSelect?.(s.id);
              }}
              style={{ cursor: 'pointer' }}
            >
              <circle
                cx={s.x}
                cy={s.y}
                r={isSelected ? 6 : 4}
                fill={col}
                stroke={isSelected ? '#fff' : 'none'}
                strokeWidth="1"
                opacity={isSelected ? 1 : 0.8}
              />
              {/* Label distance pour la sélection */}
              {isSelected && (
                <text
                  x={s.x}
                  y={s.y - 10}
                  textAnchor="middle"
                  fill={colors.text}
                  fontSize="8"
                  fontFamily={colors.fnt || 'monospace'}
                >
                  {s.dist < 1000 ? `${s.dist}m` : `${(s.dist/1000).toFixed(1)}km`}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      
      {/* Label */}
      <div
        style={{
          position: 'absolute',
          bottom: 4,
          left: 0,
          right: 0,
          textAlign: 'center',
          fontSize: 7,
          fontFamily: colors.fnt || 'monospace',
          color: colors.muted,
        }}
      >
        RADAR {MAX_DIST}m
      </div>
    </div>
  );
}
