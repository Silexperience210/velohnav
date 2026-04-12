import { useState, useMemo, useRef } from 'react';
import { useMapFilters, FILTER_MODES } from '../hooks/useMapFilters';
import { useClustering } from '../hooks/useClustering';
import { useHaptic } from '../hooks/useHaptic';
import { useTheme } from '../hooks/useTheme';
import { FilterBar } from './FilterBar';
import { RadarView } from './RadarView';
import { StationDetail } from './StationDetail';
import { ThemeToggle } from './ThemeToggle';
import { NavigationMode } from './NavigationMode';

// ── CONSTANTS ─────────────────────────────────────────────────────
const MAX_ZOOM = 18;
const MIN_ZOOM = 10;

const fDist = (m) => (m < 1000 ? `${m}m` : `${(m / 1000).toFixed(1)}km`);

// ── MAIN COMPONENT ────────────────────────────────────────────────
export function MapScreen({ stations, sel, setSel, gpsPos, heading = 0 }) {
  // Hooks
  const { theme, toggleTheme, colors, isDark } = useTheme();
  const { 
    activeFilter, 
    setActiveFilter, 
    filteredStations, 
    counts,
    nearbyRadius,
    setNearbyRadius,
  } = useMapFilters(stations, gpsPos);
  const { lightImpact, mediumImpact, proximityAlert } = useHaptic();
  
  // State
  const [zoom, setZoom] = useState(15);
  const [showRadar, setShowRadar] = useState(true);
  const [isNavigating, setIsNavigating] = useState(false);
  const containerRef = useRef(null);

  // Calculer bounds
  const bounds = useMemo(() => {
    if (filteredStations.length === 0) {
      return { minLat: 49.6, maxLat: 49.62, minLng: 6.12, maxLng: 6.15 };
    }
    const lats = filteredStations.map((s) => s.lat);
    const lngs = filteredStations.map((s) => s.lng);
    const padding = 0.002;
    return {
      minLat: Math.min(...lats) - padding,
      maxLat: Math.max(...lats) + padding,
      minLng: Math.min(...lngs) - padding,
      maxLng: Math.max(...lngs) + padding,
    };
  }, [filteredStations]);

  // Clustering
  const clusters = useClustering(filteredStations, zoom, bounds);

  // Convertir lat/lng en pixels
  const toPosition = (lat, lng) => ({
    left: ((lng - bounds.minLng) / (bounds.maxLng - bounds.minLng)) * 100,
    top: 100 - ((lat - bounds.minLat) / (bounds.maxLat - bounds.minLat)) * 100,
  });

  const selectedStation = filteredStations.find((s) => s.id === sel);

  // Handlers
  const handleSelect = async (id) => {
    await lightImpact();
    setSel(id);
  };

  const handleNavigate = async () => {
    await mediumImpact();
    setIsNavigating(true);
  };

  const handleZoom = (delta) => {
    setZoom((z) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z + delta)));
  };

  // Couleur d'une station
  const getStationColor = (s) => {
    if (s.status === 'CLOSED') return colors.closed;
    if (s.bikes === 0) return colors.bad;
    if (s.bikes <= 2) return colors.warn;
    return colors.good;
  };

  // Mode navigation
  if (isNavigating && selectedStation) {
    return (
      <NavigationMode
        target={selectedStation}
        userPos={gpsPos}
        heading={heading}
        onExit={() => setIsNavigating(false)}
        colors={colors}
        onProximity={proximityAlert}
      />
    );
  }

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        background: colors.bg,
        position: 'relative',
      }}
    >
      {/* THEME TOGGLE */}
      <ThemeToggle
        theme={theme}
        toggleTheme={toggleTheme}
        isDark={isDark}
        colors={colors}
      />

      {/* FILTER BAR */}
      <FilterBar
        activeFilter={activeFilter}
        setActiveFilter={setActiveFilter}
        counts={counts}
        colors={colors}
        nearbyRadius={nearbyRadius}
        setNearbyRadius={setNearbyRadius}
      />

      {/* RADAR VIEW */}
      {showRadar && gpsPos && (
        <RadarView
          stations={filteredStations}
          userPos={gpsPos}
          heading={heading}
          selectedId={sel}
          onSelect={handleSelect}
          colors={colors}
        />
      )}

      {/* TOGGLE RADAR BUTTON */}
      <button
        onPointerDown={() => setShowRadar((v) => !v)}
        style={{
          position: 'absolute',
          bottom: showRadar ? 230 : 100,
          right: 10,
          width: 36,
          height: 36,
          background: colors.card,
          border: `1px solid ${colors.border}`,
          borderRadius: '50%',
          fontSize: 14,
          cursor: 'pointer',
          zIndex: 30,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {showRadar ? '◉' : '○'}
      </button>

      {/* ZOOM CONTROLS */}
      <div
        style={{
          position: 'absolute',
          bottom: showRadar ? 230 : 100,
          right: 54,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          zIndex: 30,
        }}
      >
        <button
          onPointerDown={() => handleZoom(1)}
          style={{
            width: 36,
            height: 36,
            background: colors.card,
            border: `1px solid ${colors.border}`,
            borderRadius: '50%',
            fontSize: 18,
            cursor: 'pointer',
            color: colors.text,
          }}
        >
          +
        </button>
        <button
          onPointerDown={() => handleZoom(-1)}
          style={{
            width: 36,
            height: 36,
            background: colors.card,
            border: `1px solid ${colors.border}`,
            borderRadius: '50%',
            fontSize: 18,
            cursor: 'pointer',
            color: colors.text,
          }}
        >
          −
        </button>
      </div>

      {/* MAP AREA */}
      <div
        style={{
          flex: 1,
          position: 'relative',
          margin: 12,
          marginTop: 100, // Space for filters
          background: colors.mapBg,
          border: `1px solid ${colors.border}`,
          borderRadius: 16,
          overflow: 'hidden',
        }}
      >
        {/* Grid background */}
        <svg style={{ position: 'absolute', inset: 0, opacity: 0.03 }}>
          <defs>
            <pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse">
              <path d="M 50 0 L 0 0 0 50" fill="none" stroke={colors.accent} strokeWidth="0.5" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid)" />
        </svg>

        {/* User position */}
        {gpsPos && (
          <div
            style={{
              position: 'absolute',
              ...toPosition(gpsPos.lat, gpsPos.lng),
              transform: 'translate(-50%, -50%)',
              zIndex: 10,
            }}
          >
            <div
              style={{
                position: 'absolute',
                inset: -15,
                borderRadius: '50%',
                border: `2px solid ${colors.user}`,
                opacity: 0.3,
                animation: 'pulse 2s infinite',
              }}
            />
            <div
              style={{
                width: 14,
                height: 14,
                borderRadius: '50%',
                background: colors.user,
                border: '2px solid #fff',
                boxShadow: `0 0 15px ${colors.user}`,
              }}
            />
          </div>
        )}

        {/* Stations / Clusters */}
        {clusters.map((cluster) => {
          const pos = toPosition(cluster.center.lat, cluster.center.lng);
          const isCluster = cluster.isCluster;
          const isSel = sel === cluster.id;
          
          // Pour un cluster, on prend la couleur de la première station
          const col = isCluster 
            ? colors.muted 
            : getStationColor(cluster.stations[0]);

          return (
            <div
              key={cluster.id}
              onPointerDown={() => {
                if (isCluster) {
                  // Zoom sur le cluster
                  setZoom((z) => Math.min(MAX_ZOOM, z + 2));
                } else {
                  handleSelect(cluster.id);
                }
              }}
              style={{
                position: 'absolute',
                left: `${pos.left}%`,
                top: `${pos.top}%`,
                transform: `translate(-50%, -50%) scale(${isSel ? 1.4 : 1})`,
                zIndex: isSel ? 20 : 5,
                cursor: 'pointer',
                transition: 'transform 0.15s ease',
              }}
            >
              {isCluster ? (
                // Affichage cluster
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: '50%',
                    background: colors.accentBg,
                    border: `2px solid ${colors.accent}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: colors.accent,
                    fontSize: 11,
                    fontWeight: 700,
                    fontFamily: colors.fnt || 'monospace',
                  }}
                >
                  {cluster.stations.length}
                </div>
              ) : (
                // Affichage station simple
                <>
                  <div
                    style={{
                      width: isSel ? 18 : 12,
                      height: isSel ? 18 : 12,
                      borderRadius: '50%',
                      background: col,
                      border: `2px solid ${isSel ? '#fff' : 'rgba(0,0,0,0.6)'}`,
                      boxShadow: isSel ? `0 0 20px ${col}` : `0 0 8px ${col}80`,
                      transition: 'all 0.15s ease',
                    }}
                  />
                  {/* Numéro de vélos */}
                  <div
                    style={{
                      position: 'absolute',
                      top: 14,
                      left: '50%',
                      transform: 'translateX(-50%)',
                      fontSize: 8,
                      fontFamily: colors.fnt || 'monospace',
                      color: colors.muted,
                      whiteSpace: 'nowrap',
                      textShadow: `0 1px 2px ${colors.bg}`,
                    }}
                  >
                    {cluster.stations[0].bikes}
                  </div>
                </>
              )}
            </div>
          );
        })}

        {/* Legend */}
        <div
          style={{
            position: 'absolute',
            top: 10,
            left: 10,
            display: 'flex',
            gap: 10,
            zIndex: 20,
          }}
        >
          {[
            { c: colors.good, l: 'Dispo' },
            { c: colors.warn, l: 'Faible' },
            { c: colors.bad, l: 'Vide' },
            { c: colors.closed, l: 'Fermé' },
          ].map((item) => (
            <div
              key={item.l}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '4px 8px',
                background: colors.card,
                border: `1px solid ${colors.border}`,
                borderRadius: 10,
              }}
            >
              <div
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: item.c,
                  boxShadow: `0 0 4px ${item.c}`,
                }}
              />
              <span style={{ fontSize: 8, fontFamily: colors.fnt || 'monospace', color: colors.muted }}>
                {item.l}
              </span>
            </div>
          ))}
        </div>

        {/* Zoom level indicator */}
        <div
          style={{
            position: 'absolute',
            top: 10,
            right: 10,
            padding: '4px 10px',
            background: colors.card,
            border: `1px solid ${colors.border}`,
            borderRadius: 10,
            fontSize: 9,
            fontFamily: colors.fnt || 'monospace',
            color: colors.muted,
            zIndex: 20,
          }}
        >
          Zoom: {zoom}
        </div>
      </div>

      {/* STATION DETAIL PANEL */}
      {selectedStation ? (
        <StationDetail
          station={selectedStation}
          onClose={() => setSel(null)}
          onNavigate={handleNavigate}
          colors={colors}
          userPos={gpsPos}
        />
      ) : (
        <div
          style={{
            margin: '0 12px 12px',
            padding: '14px',
            background: colors.card,
            border: `1px solid ${colors.border}`,
            borderRadius: 12,
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 10, fontFamily: colors.fnt || 'monospace', color: colors.muted }}>
            {filteredStations.filter((s) => s.bikes > 0).length} stations disponibles
            {activeFilter !== FILTER_MODES.ALL && ` (filtre: ${activeFilter})`}
          </div>
        </div>
      )}

      {/* CSS Animations */}
      <style>{`
        @keyframes pulse {
          0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 0.3; }
          50% { transform: translate(-50%, -50%) scale(1.5); opacity: 0.1; }
        }
      `}</style>
    </div>
  );
}
