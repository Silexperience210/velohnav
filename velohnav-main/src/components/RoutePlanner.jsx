import { useState, useMemo, useCallback } from 'react';
import { calculateBearing } from '../hooks/useDeviceOrientation';

const C = {
  bg: "#080c0f",
  card: "rgba(8,12,15,0.98)",
  border: "rgba(255,255,255,0.07)",
  accent: "#F5820D",
  accentBg: "rgba(245,130,13,0.12)",
  good: "#2ECC8F",
  warn: "#F5A623",
  bad: "#E03E3E",
  text: "#E2E6EE",
  muted: "#4A5568",
  fnt: "'Courier New', monospace",
};

const fDist = (m) => m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`;

/**
 * Optimise l'ordre des stations (algorithme du plus proche voisin simplifié)
 */
function optimizeRoute(stations, startPos) {
  if (!stations.length) return [];
  
  const unvisited = [...stations];
  const route = [];
  let current = { lat: startPos.lat, lng: startPos.lng };
  
  while (unvisited.length > 0) {
    // Trouver la station la plus proche
    let nearest = unvisited[0];
    let minDist = Infinity;
    
    unvisited.forEach(s => {
      const dist = calculateDistance(current.lat, current.lng, s.lat, s.lng);
      if (dist < minDist) {
        minDist = dist;
        nearest = s;
      }
    });
    
    route.push({ ...nearest, legDistance: minDist });
    current = { lat: nearest.lat, lng: nearest.lng };
    
    // Retirer des unvisited
    const idx = unvisited.findIndex(s => s.id === nearest.id);
    unvisited.splice(idx, 1);
  }
  
  return route;
}

function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371e3;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;

  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

  return R * c;
}

export function RoutePlanner({ 
  stations, 
  gpsPos, 
  isOpen, 
  onClose, 
  onStartRoute,
}) {
  const [selectedStops, setSelectedStops] = useState([]);
  const [isOptimized, setIsOptimized] = useState(true);
  const [routeName, setRouteName] = useState('');

  // Calculer l'itinéraire
  const route = useMemo(() => {
    if (!gpsPos || selectedStops.length === 0) return [];
    
    if (isOptimized) {
      return optimizeRoute(selectedStops, gpsPos);
    }
    
    // Ordre manuel - calculer distances entre étapes
    return selectedStops.map((stop, i) => {
      let legDistance = stop.dist;
      if (i > 0) {
        const prev = selectedStops[i - 1];
        legDistance = calculateDistance(prev.lat, prev.lng, stop.lat, stop.lng);
      }
      return { ...stop, legDistance };
    });
  }, [selectedStops, gpsPos, isOptimized]);

  // Totaux
  const totals = useMemo(() => {
    const totalDist = route.reduce((acc, s) => acc + (s.legDistance || 0), 0);
    const totalTime = Math.round(totalDist / 4.2 / 60); // ~15km/h = 4.2m/s
    return { totalDist, totalTime };
  }, [route]);

  // Ajouter un arrêt
  const addStop = useCallback((station) => {
    if (selectedStops.find(s => s.id === station.id)) return;
    setSelectedStops(prev => [...prev, station]);
  }, [selectedStops]);

  // Retirer un arrêt
  const removeStop = useCallback((stationId) => {
    setSelectedStops(prev => prev.filter(s => s.id !== stationId));
  }, []);

  // Déplacer un arrêt (haut/bas)
  const moveStop = useCallback((index, direction) => {
    if (isOptimized) return; // Pas de réorganisation si optimisé
    
    setSelectedStops(prev => {
      const newStops = [...prev];
      const newIndex = index + direction;
      if (newIndex < 0 || newIndex >= newStops.length) return prev;
      
      [newStops[index], newStops[newIndex]] = [newStops[newIndex], newStops[index]];
      return newStops;
    });
  }, [isOptimized]);

  // Démarrer la navigation
  const handleStart = useCallback(() => {
    if (route.length === 0) return;
    onStartRoute?.(route, routeName || `Itinéraire ${selectedStops.length} arrêts`);
    onClose();
  }, [route, routeName, selectedStops.length, onStartRoute, onClose]);

  // Vider tout
  const clearAll = useCallback(() => {
    setSelectedStops([]);
    setRouteName('');
  }, []);

  if (!isOpen) return null;

  // Stations disponibles (pas déjà sélectionnées)
  const availableStations = stations
    .filter(s => !selectedStops.find(sel => sel.id === s.id))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 20);

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
            🗺️ Planifier un itinéraire
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
            {selectedStops.length} arrêt{selectedStops.length > 1 ? 's' : ''} · {fDist(totals.totalDist)} · {totals.totalTime}min
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

      {/* Input nom */}
      <div style={{ padding: 14 }}>
        <input
          type="text"
          value={routeName}
          onChange={(e) => setRouteName(e.target.value)}
          placeholder="Nom de l'itinéraire..."
          style={{
            width: '100%',
            padding: '12px 14px',
            background: 'rgba(0,0,0,0.3)',
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            color: C.text,
            fontSize: 14,
            fontFamily: C.fnt,
            outline: 'none',
          }}
        />
      </div>

      {/* Options */}
      <div style={{ 
        padding: '0 14px 14px',
        display: 'flex',
        gap: 10,
        borderBottom: `1px solid ${C.border}`,
      }}>
        <button
          onClick={() => setIsOptimized(true)}
          style={{
            flex: 1,
            padding: '10px',
            background: isOptimized ? C.accentBg : 'transparent',
            border: `1px solid ${isOptimized ? C.accent : C.border}`,
            borderRadius: 6,
            color: isOptimized ? C.accent : C.muted,
            fontSize: 11,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          🧭 Optimisé
        </button>
        <button
          onClick={() => setIsOptimized(false)}
          style={{
            flex: 1,
            padding: '10px',
            background: !isOptimized ? C.accentBg : 'transparent',
            border: `1px solid ${!isOptimized ? C.accent : C.border}`,
            borderRadius: 6,
            color: !isOptimized ? C.accent : C.muted,
            fontSize: 11,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          📋 Manuel
        </button>
      </div>

      {/* Contenu scrollable */}
      <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        
        {/* Liste des arrêts sélectionnés */}
        {selectedStops.length > 0 && (
          <div style={{ padding: 14 }}>
            <div style={{ fontSize: 10, color: C.muted, letterSpacing: 2, marginBottom: 10 }}>
              ARRÊTS SÉLECTIONNÉS
            </div>
            
            {route.map((stop, index) => (
              <div
                key={stop.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '12px',
                  background: 'rgba(255,255,255,0.02)',
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                  marginBottom: 8,
                }}
              >
                {/* Numéro */}
                <div style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  background: C.accentBg,
                  border: `1px solid ${C.accent}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 12,
                  fontWeight: 700,
                  color: C.accent,
                }}>
                  {index + 1}
                </div>
                
                {/* Info */}
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, color: C.text, fontWeight: 600 }}>
                    {stop.name}
                  </div>
                  <div style={{ fontSize: 10, color: C.muted }}>
                    {index === 0 ? `Départ · ${fDist(stop.legDistance || 0)}` : `+${fDist(stop.legDistance || 0)}`}
                    {' · '}
                    <span style={{ color: stop.bikes > 0 ? C.good : C.bad }}>
                      {stop.bikes} 🚲
                    </span>
                  </div>
                </div>
                
                {/* Contrôles ordre (mode manuel) */}
                {!isOptimized && (
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      onClick={() => moveStop(index, -1)}
                      disabled={index === 0}
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 4,
                        background: 'rgba(255,255,255,0.05)',
                        border: `1px solid ${C.border}`,
                        color: index === 0 ? C.muted : C.text,
                        fontSize: 12,
                        cursor: index === 0 ? 'not-allowed' : 'pointer',
                        opacity: index === 0 ? 0.5 : 1,
                      }}
                    >
                      ↑
                    </button>
                    <button
                      onClick={() => moveStop(index, 1)}
                      disabled={index === selectedStops.length - 1}
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 4,
                        background: 'rgba(255,255,255,0.05)',
                        border: `1px solid ${C.border}`,
                        color: index === selectedStops.length - 1 ? C.muted : C.text,
                        fontSize: 12,
                        cursor: index === selectedStops.length - 1 ? 'not-allowed' : 'pointer',
                        opacity: index === selectedStops.length - 1 ? 0.5 : 1,
                      }}
                    >
                      ↓
                    </button>
                  </div>
                )}
                
                {/* Supprimer */}
                <button
                  onClick={() => removeStop(stop.id)}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 4,
                    background: 'rgba(224,62,62,0.1)',
                    border: `1px solid ${C.bad}`,
                    color: C.bad,
                    fontSize: 14,
                    cursor: 'pointer',
                  }}
                >
                  ×
                </button>
              </div>
            ))}
            
            {/* Total */}
            <div style={{
              marginTop: 12,
              padding: '14px',
              background: C.accentBg,
              border: `1px solid ${C.accent}`,
              borderRadius: 8,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}>
              <div>
                <div style={{ fontSize: 10, color: C.accent, letterSpacing: 1 }}>TOTAL</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>
                  {fDist(totals.totalDist)} · {totals.totalTime} min
                </div>
              </div>
              <button
                onClick={clearAll}
                style={{
                  padding: '8px 14px',
                  background: 'transparent',
                  border: `1px solid ${C.border}`,
                  borderRadius: 6,
                  color: C.muted,
                  fontSize: 11,
                  cursor: 'pointer',
                }}
              >
                Vider
              </button>
            </div>
          </div>
        )}

        {/* Stations disponibles */}
        <div style={{ padding: 14, flex: 1 }}>
          <div style={{ fontSize: 10, color: C.muted, letterSpacing: 2, marginBottom: 10 }}>
            AJOUTER UN ARRÊT
          </div>
          
          <div style={{ display: 'grid', gap: 8 }}>
            {availableStations.map(station => (
              <button
                key={station.id}
                onClick={() => addStop(station)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '12px',
                  background: 'rgba(255,255,255,0.02)',
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
              >
                <span style={{ fontSize: 16 }}>+</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, color: C.text }}>{station.name}</div>
                  <div style={{ fontSize: 10, color: C.muted }}>
                    {fDist(station.dist)} · 
                    <span style={{ color: station.bikes > 0 ? C.good : C.bad }}>
                      {' '}{station.bikes} vélos
                    </span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Footer bouton start */}
      <div style={{
        padding: 14,
        borderTop: `1px solid ${C.border}`,
        background: 'rgba(8,12,15,0.98)',
      }}>
        <button
          onClick={handleStart}
          disabled={selectedStops.length === 0}
          style={{
            width: '100%',
            padding: '16px',
            background: selectedStops.length > 0 ? C.accent : C.muted,
            border: 'none',
            borderRadius: 8,
            color: '#fff',
            fontSize: 14,
            fontWeight: 700,
            cursor: selectedStops.length > 0 ? 'pointer' : 'not-allowed',
            opacity: selectedStops.length > 0 ? 1 : 0.5,
          }}
        >
          {selectedStops.length === 0 
            ? 'Sélectionne au moins un arrêt' 
            : `🚀 Démarrer la navigation (${selectedStops.length} arrêts)`}
        </button>
      </div>
    </div>
  );
}
