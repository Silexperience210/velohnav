import { FILTER_MODES } from '../hooks/useMapFilters';

export function FilterBar({ 
  activeFilter, 
  setActiveFilter, 
  counts, 
  colors,
  nearbyRadius,
  setNearbyRadius,
}) {
  const filters = [
    { id: FILTER_MODES.ALL, label: 'TOUTES', count: counts.all, icon: '◎' },
    { id: FILTER_MODES.AVAILABLE, label: 'DISPO', count: counts.available, icon: '✓' },
    { id: FILTER_MODES.ELECTRIC, label: 'ÉLEC', count: counts.electric, icon: '⚡' },
    { id: FILTER_MODES.NEARBY, label: 'PROCHE', count: counts.nearby, icon: '⌖' },
  ];

  return (
    <div
      style={{
        position: 'absolute',
        top: 50,
        left: 10,
        right: 10,
        display: 'flex',
        gap: 8,
        zIndex: 25,
        overflowX: 'auto',
        padding: '4px 0',
        scrollbarWidth: 'none',
        msOverflowStyle: 'none',
      }}
    >
      <style>{`
        div::-webkit-scrollbar {
          display: none;
        }
      `}</style>
      
      {filters.map((f) => {
        const isActive = activeFilter === f.id;
        
        return (
          <button
            key={f.id}
            onPointerDown={() => setActiveFilter(isActive ? FILTER_MODES.ALL : f.id)}
            style={{
              flexShrink: 0,
              padding: '8px 14px',
              background: isActive ? colors.accentBg : colors.card,
              border: `1px solid ${isActive ? colors.accent : colors.border}`,
              borderRadius: 20,
              color: isActive ? colors.accent : colors.text,
              fontSize: 10,
              fontFamily: colors.fnt || 'monospace',
              fontWeight: isActive ? 700 : 500,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              boxShadow: isActive ? `0 2px 8px ${colors.accent}40` : '0 2px 8px rgba(0,0,0,0.1)',
              transition: 'all 0.15s ease',
            }}
          >
            <span>{f.icon}</span>
            <span>{f.label}</span>
            <span
              style={{
                background: isActive ? colors.accent : colors.border,
                color: isActive ? colors.bg : colors.text,
                padding: '2px 6px',
                borderRadius: 10,
                fontSize: 8,
                minWidth: 16,
              }}
            >
              {f.count}
            </span>
          </button>
        );
      })}
      
      {/* Sélecteur de rayon pour le filtre NEARBY */}
      {activeFilter === FILTER_MODES.NEARBY && (
        <div
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '4px 12px',
            background: colors.card,
            border: `1px solid ${colors.border}`,
            borderRadius: 20,
          }}
        >
          <span style={{ fontSize: 9, color: colors.muted }}>Rayon:</span>
          {[300, 500, 1000].map((r) => (
            <button
              key={r}
              onPointerDown={() => setNearbyRadius(r)}
              style={{
                padding: '4px 8px',
                background: nearbyRadius === r ? colors.accent : 'transparent',
                border: 'none',
                borderRadius: 12,
                color: nearbyRadius === r ? colors.bg : colors.text,
                fontSize: 9,
                fontFamily: colors.fnt || 'monospace',
                cursor: 'pointer',
              }}
            >
              {r}m
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
