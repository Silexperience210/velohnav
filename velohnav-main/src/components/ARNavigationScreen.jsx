import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { calculateBearing, isInFOV, bearingToScreenX } from '../hooks/useDeviceOrientation';

// ── UTILITAIRES ────────────────────────────────────────────────────
const fDist = (m) => m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`;
const fTime = (sec) => sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}min ${sec % 60}s`;

const COLORS = {
  bg: "#080c0f",
  accent: "#F5820D",
  accentGlow: "rgba(245,130,13,0.4)",
  good: "#2ECC8F",
  warn: "#F5A623",
  bad: "#E03E3E",
  text: "#E2E6EE",
  muted: "#4A5568",
  path: "rgba(245,130,13,0.6)",
  danger: "#FF0040",
};

// ── SON SPATIAL SIMULÉ ─────────────────────────────────────────────
function useSpatialAudio() {
  const audioCtxRef = useRef(null);
  
  const initAudio = useCallback(() => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
  }, []);

  const playDirectionalBeep = useCallback((direction, intensity = 1) => {
    if (!audioCtxRef.current) return;
    const ctx = audioCtxRef.current;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    // Fréquence selon direction: gauche = grave, droite = aigu
    const baseFreq = 440;
    const freq = direction === 'left' ? baseFreq * 0.8 : direction === 'right' ? baseFreq * 1.2 : baseFreq;
    
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.1 * intensity, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
    
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.15);
  }, []);

  const playSuccess = useCallback(() => {
    if (!audioCtxRef.current) return;
    const ctx = audioCtxRef.current;
    [523.25, 659.25, 783.99].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.1, ctx.currentTime + i * 0.1);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + i * 0.1 + 0.2);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.1);
      osc.stop(ctx.currentTime + i * 0.1 + 0.2);
    });
  }, []);

  return { initAudio, playDirectionalBeep, playSuccess };
}

// ── HAPTIC DIRECTIONNEL ────────────────────────────────────────────
function useHapticNav() {
  const vibrate = useCallback((pattern) => {
    if (navigator.vibrate) navigator.vibrate(pattern);
  }, []);

  const pulse = useCallback((direction) => {
    // Patterns différents selon la direction à prendre
    const patterns = {
      left: [50, 100, 50],      // Double court = gauche
      right: [100, 50, 100],    // Double long = droite
      straight: [30],           // Simple = tout droit
      uturn: [200, 100, 200],   // Long = demi-tour
      arrived: [50, 50, 50, 50, 50], // Successions = arrivée
    };
    vibrate(patterns[direction] || [30]);
  }, [vibrate]);

  const proximityPulse = useCallback((distance) => {
    if (distance < 50) vibrate([100]);
    else if (distance < 100) vibrate([50]);
    else if (distance < 200) vibrate([30]);
  }, [vibrate]);

  return { pulse, proximityPulse, vibrate };
}

// ── COMPOSANT CHEMIN AR ────────────────────────────────────────────
function ARPathOverlay({ waypoints, heading, screenSize, targetBearing }) {
  if (!waypoints.length || !screenSize.width) return null;

  // Générer les points du chemin
  const pathPoints = useMemo(() => {
    return waypoints.map((wp, i) => {
      const bearing = wp.bearing;
      const x = bearingToScreenX(bearing, heading, screenSize.width, 60);
      // Y dépend de la distance (plus loin = plus haut à l'écran)
      const y = screenSize.height * 0.5 - (wp.dist / 2000) * (screenSize.height * 0.4);
      return { x, y, opacity: 1 - (i / waypoints.length) * 0.5 };
    }).filter(p => p.x >= -50 && p.x <= screenSize.width + 50);
  }, [waypoints, heading, screenSize]);

  if (pathPoints.length < 2) return null;

  // Créer le SVG path
  const pathD = pathPoints.reduce((acc, p, i) => 
    `${acc} ${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`, ''
  );

  return (
    <svg 
      style={{ 
        position: 'absolute', 
        inset: 0, 
        pointerEvents: 'none',
        zIndex: 5 
      }}
      width={screenSize.width}
      height={screenSize.height}
    >
      <defs>
        <linearGradient id="pathGradient" x1="0%" y1="100%" x2="0%" y2="0%">
          <stop offset="0%" stopColor={COLORS.accent} stopOpacity="0.9" />
          <stop offset="100%" stopColor={COLORS.accent} stopOpacity="0.2" />
        </linearGradient>
        <filter id="pathGlow">
          <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
          <feMerge>
            <feMergeNode in="coloredBlur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>
      
      {/* Ligne principale */}
      <path
        d={pathD}
        fill="none"
        stroke="url(#pathGradient)"
        strokeWidth="6"
        strokeLinecap="round"
        filter="url(#pathGlow)"
        opacity="0.8"
      />
      
      {/* Points sur le chemin */}
      {pathPoints.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r={i === pathPoints.length - 1 ? 8 : 4}
          fill={i === pathPoints.length - 1 ? COLORS.accent : COLORS.path}
          opacity={p.opacity}
        >
          {i === pathPoints.length - 1 && (
            <animate attributeName="r" values="6;10;6" dur="1.5s" repeatCount="indefinite" />
          )}
        </circle>
      ))}
    </svg>
  );
}

// ── RADAR MINI OVERLAY ─────────────────────────────────────────────
function MiniRadar({ stations, heading, target, gpsPos, size = 120 }) {
  const radarRef = useRef(null);
  
  const dots = useMemo(() => {
    if (!gpsPos) return [];
    return stations
      .filter(s => s.dist < 500)
      .map(s => {
        const bearing = calculateBearing(gpsPos.lat, gpsPos.lng, s.lat, s.lng);
        const angle = ((bearing - heading) * Math.PI) / 180;
        const dist = s.dist / 500; // Normalisé 0-1
        return {
          x: size / 2 + Math.sin(angle) * (dist * size / 2),
          y: size / 2 - Math.cos(angle) * (dist * size / 2),
          isTarget: s.id === target?.id,
          color: s.bikes > 0 ? COLORS.good : COLORS.bad,
        };
      });
  }, [stations, heading, target, gpsPos, size]);

  return (
    <div style={{
      position: 'absolute',
      top: 100,
      right: 14,
      width: size,
      height: size,
      borderRadius: '50%',
      background: 'rgba(8,12,15,0.85)',
      border: `1px solid ${COLORS.border}`,
      backdropFilter: 'blur(10px)',
      zIndex: 20,
      overflow: 'hidden',
    }}>
      {/* Grille */}
      <svg width={size} height={size} style={{ position: 'absolute' }}>
        <circle cx={size/2} cy={size/2} r={size/4} fill="none" stroke={COLORS.muted} strokeWidth="0.5" opacity="0.3" />
        <circle cx={size/2} cy={size/2} r={size/2 - 2} fill="none" stroke={COLORS.muted} strokeWidth="0.5" opacity="0.3" />
        <line x1={size/2} y1={0} x2={size/2} y2={size} stroke={COLORS.muted} strokeWidth="0.5" opacity="0.3" />
        <line x1={0} y1={size/2} x2={size} y2={size/2} stroke={COLORS.muted} strokeWidth="0.5" opacity="0.3" />
      </svg>
      
      {/* Direction nord (triangle fixe en haut) */}
      <div style={{
        position: 'absolute',
        top: 4,
        left: '50%',
        transform: 'translateX(-50%)',
        fontSize: 10,
        color: COLORS.accent,
      }}>▲</div>
      
      {/* Points stations */}
      {dots.map((d, i) => (
        <div key={i} style={{
          position: 'absolute',
          left: d.x - (d.isTarget ? 6 : 3),
          top: d.y - (d.isTarget ? 6 : 3),
          width: d.isTarget ? 12 : 6,
          height: d.isTarget ? 12 : 6,
          borderRadius: '50%',
          background: d.isTarget ? COLORS.accent : d.color,
          boxShadow: d.isTarget ? `0 0 10px ${COLORS.accent}` : 'none',
          animation: d.isTarget ? 'pulse 1s infinite' : 'none',
        }} />
      ))}
      
      {/* Position utilisateur (centre) */}
      <div style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: COLORS.text,
        border: `2px solid ${COLORS.accent}`,
      }} />
      
      <style>{`
        @keyframes pulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.3); opacity: 0.7; }
        }
      `}</style>
    </div>
  );
}

// ── ALERTE DANGER ──────────────────────────────────────────────────
function DangerAlert({ type, distance, onDismiss }) {
  const [visible, setVisible] = useState(true);
  
  if (!visible) return null;

  const alerts = {
    intersection: { icon: '⚠️', text: 'Traversée', sub: 'Intersection à ' + fDist(distance) },
    road: { icon: '🚗', text: 'Route', sub: 'Attention aux véhicules' },
    stairs: { icon: '📶', text: 'Escaliers', sub: 'Descente à ' + fDist(distance) },
    deviation: { icon: '🔄', text: 'Déviation', sub: 'Chemin alternatif' },
  };
  
  const a = alerts[type] || alerts.intersection;

  return (
    <div style={{
      position: 'absolute',
      top: '30%',
      left: '50%',
      transform: 'translateX(-50%)',
      background: 'rgba(224, 62, 62, 0.95)',
      borderRadius: 12,
      padding: '16px 20px',
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      zIndex: 50,
      animation: 'dangerPulse 0.5s ease-out',
      boxShadow: '0 0 30px rgba(224,62,62,0.5)',
    }}>
      <span style={{ fontSize: 28 }}>{a.icon}</span>
      <div>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>{a.text}</div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.8)' }}>{a.sub}</div>
      </div>
      <button 
        onClick={() => setVisible(false)}
        style={{
          marginLeft: 8,
          background: 'rgba(255,255,255,0.2)',
          border: 'none',
          borderRadius: 4,
          padding: '4px 8px',
          color: '#fff',
          fontSize: 11,
          cursor: 'pointer',
        }}
      >
        OK
      </button>
      
      <style>{`
        @keyframes dangerPulse {
          0% { transform: translateX(-50%) scale(0.8); opacity: 0; }
          50% { transform: translateX(-50%) scale(1.05); }
          100% { transform: translateX(-50%) scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

// ── PANNEAU INFO AR ────────────────────────────────────────────────
function ARInfoPanel({ target, distance, eta, streak, calories, isNightMode }) {
  return (
    <div style={{
      position: 'absolute',
      bottom: 20,
      left: 14,
      right: 14,
      background: isNightMode ? 'rgba(8,12,15,0.95)' : 'rgba(255,255,255,0.95)',
      borderRadius: 16,
      padding: 16,
      zIndex: 20,
      backdropFilter: 'blur(20px)',
      border: `1px solid ${isNightMode ? COLORS.border : 'rgba(0,0,0,0.1)'}`,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <div style={{ 
            fontSize: 18, 
            fontWeight: 700, 
            color: isNightMode ? COLORS.text : '#1a1a1a',
            marginBottom: 2,
          }}>
            {target?.name || 'Destination'}
          </div>
          <div style={{ fontSize: 11, color: isNightMode ? COLORS.muted : '#666' }}>
            {target?.bikes > 0 ? `🚲 ${target.bikes} vélos dispos` : '⚠️ Station vide'}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 32, fontWeight: 800, color: COLORS.accent }}>
            {fDist(distance)}
          </div>
          <div style={{ fontSize: 10, color: isNightMode ? COLORS.muted : '#666' }}>
            ETA {eta > 0 ? fTime(eta) : '--'}
          </div>
        </div>
      </div>
      
      {/* Stats */}
      <div style={{ 
        display: 'flex', 
        gap: 16, 
        paddingTop: 12,
        borderTop: `1px solid ${isNightMode ? COLORS.border : 'rgba(0,0,0,0.1)'}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 14 }}>🔥</span>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: isNightMode ? COLORS.text : '#1a1a1a' }}>
              {streak}
            </div>
            <div style={{ fontSize: 8, color: isNightMode ? COLORS.muted : '#999' }}>STREAK</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 14 }}>⚡</span>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: isNightMode ? COLORS.text : '#1a1a1a' }}>
              {calories}
            </div>
            <div style={{ fontSize: 8, color: isNightMode ? COLORS.muted : '#999' }}>KCAL</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 14 }}>🎯</span>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: isNightMode ? COLORS.text : '#1a1a1a' }}>
              +50
            </div>
            <div style={{ fontSize: 8, color: isNightMode ? COLORS.muted : '#999' }}>POINTS</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── FLÈCHE DIRECTION 3D ────────────────────────────────────────────
function DirectionArrow({ rotation, distance, label }) {
  const getArrowStyle = () => {
    const absRot = Math.abs(rotation);
    let text = '↑';
    let color = COLORS.accent;
    
    if (absRot < 15) text = '↑'; // Tout droit
    else if (absRot < 45) text = rotation < 0 ? '↖' : '↗';
    else if (absRot < 90) text = rotation < 0 ? '←' : '→';
    else if (absRot < 135) text = rotation < 0 ? '↙' : '↘';
    else text = '↓';
    
    // Couleur selon distance
    if (distance < 50) color = COLORS.good;
    else if (distance < 200) color = COLORS.warn;
    
    return { text, color };
  };

  const { text, color } = getArrowStyle();

  return (
    <div style={{
      position: 'absolute',
      top: '40%',
      left: '50%',
      transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
      zIndex: 15,
      textAlign: 'center',
      pointerEvents: 'none',
    }}>
      <div style={{
        fontSize: 100,
        color: color,
        filter: `drop-shadow(0 0 30px ${color})`,
        textShadow: `0 0 60px ${color}`,
        lineHeight: 1,
        transition: 'transform 0.3s ease, color 0.3s ease',
      }}>
        {text}
      </div>
      
      {/* Label direction */}
      <div style={{
        position: 'absolute',
        top: '100%',
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(8,12,15,0.9)',
        padding: '4px 12px',
        borderRadius: 12,
        fontSize: 11,
        fontWeight: 700,
        color: COLORS.text,
        marginTop: 8,
        whiteSpace: 'nowrap',
        border: `1px solid ${COLORS.border}`,
      }}>
        {label || fDist(distance)}
      </div>
    </div>
  );
}

// ── ÉCRAN NAVIGATION AR PRINCIPAL ──────────────────────────────────
export function ARNavigationScreen({ 
  target, 
  userPos, 
  heading,
  stations,
  onExit,
  streak = 0,
  isNightMode = false,
}) {
  const vidRef = useRef(null);
  const containerRef = useRef(null);
  const [camState, setCamState] = useState('idle'); // idle | active | denied
  const [screenSize, setScreenSize] = useState({ width: 0, height: 0 });
  const [eta, setEta] = useState(0);
  const [calories, setCalories] = useState(0);
  const [showDanger, setShowDanger] = useState(null);
  const [arrowRotation, setArrowRotation] = useState(0);
  const [waypoints, setWaypoints] = useState([]);
  
  // Ref pour throttler les feedbacks (éviter spam)
  const lastFeedbackRef = useRef(0);
  const lastProximityRef = useRef(0);
  
  // Hooks
  const { initAudio, playDirectionalBeep, playSuccess } = useSpatialAudio();
  const { pulse, proximityPulse } = useHapticNav();

  // Calculer taille écran
  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        setScreenSize({
          width: containerRef.current.offsetWidth,
          height: containerRef.current.offsetHeight,
        });
      }
    };
    updateSize();
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, []);

  // Démarrer caméra
  useEffect(() => {
    const startCam = async () => {
      setCamState('requesting');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          video: { facingMode: 'environment' } 
        });
        if (vidRef.current) {
          vidRef.current.srcObject = stream;
          await vidRef.current.play();
        }
        setCamState('active');
        initAudio();
      } catch (e) {
        console.warn('Cam:', e);
        setCamState('denied');
      }
    };
    startCam();
    
    return () => {
      vidRef.current?.srcObject?.getTracks().forEach(t => t.stop());
    };
  }, [initAudio]);

  // Calculer direction et waypoints
  useEffect(() => {
    if (!userPos || !target) return;
    
    const bearing = calculateBearing(userPos.lat, userPos.lng, target.lat, target.lng);
    let rotation = bearing - heading;
    
    // Normaliser
    while (rotation > 180) rotation -= 360;
    while (rotation < -180) rotation += 360;
    
    setArrowRotation(rotation);
    
    // Générer waypoints virtuels pour le chemin AR
    const wp = [];
    const steps = 5;
    for (let i = 1; i <= steps; i++) {
      const ratio = i / steps;
      const lat = userPos.lat + (target.lat - userPos.lat) * ratio;
      const lng = userPos.lng + (target.lng - userPos.lng) * ratio;
      const dist = target.dist * (1 - ratio);
      wp.push({ 
        lat, lng, 
        dist,
        bearing: calculateBearing(userPos.lat, userPos.lng, lat, lng)
      });
    }
    setWaypoints(wp);
    
    // Calculer ETA (vitesse moyenne vélo ~15km/h = 4.2m/s)
    const etaSec = Math.round(target.dist / 4.2);
    setEta(etaSec);
    
    // Calories (~25 kcal/km)
    setCalories(Math.round((target.dist / 1000) * 25));
    
    // Feedback directionnel (throttle: max 1 fois par seconde)
    const now = Date.now();
    if (now - lastFeedbackRef.current > 1000) {
      if (Math.abs(rotation) > 30) {
        const dir = rotation < 0 ? 'left' : 'right';
        pulse(dir);
        playDirectionalBeep(dir, Math.min(Math.abs(rotation) / 90, 1));
        lastFeedbackRef.current = now;
      }
    }
    
    // Proximité (throttle: max 1 fois par 3 secondes)
    if (now - lastProximityRef.current > 3000) {
      proximityPulse(target.dist);
      lastProximityRef.current = now;
    }
    
    // Arrivée (pas de throttle, une seule fois quand on passe sous 20m)
    if (target.dist < 20 && !lastFeedbackRef.currentArrived) {
      playSuccess();
      pulse('arrived');
      lastFeedbackRef.currentArrived = true;
    } else if (target.dist >= 20) {
      lastFeedbackRef.currentArrived = false;
    }
    
  }, [userPos, target, heading, pulse, proximityPulse, playDirectionalBeep, playSuccess]);

  // Simuler des alertes danger (à remplacer par vraie détection)
  useEffect(() => {
    if (target?.dist < 150 && target?.dist > 100) {
      setShowDanger('intersection');
      setTimeout(() => setShowDanger(null), 5000);
    }
  }, [target?.dist]);

  if (!target) return null;

  const directionLabel = Math.abs(arrowRotation) < 15 ? 'TOUT DROIT' :
                         Math.abs(arrowRotation) < 45 ? (arrowRotation < 0 ? 'TOURNE GAUCHE' : 'TOURNE DROITE') :
                         Math.abs(arrowRotation) < 90 ? (arrowRotation < 0 ? 'VIRE GAUCHE' : 'VIRE DROITE') :
                         'FAIS DEMI-TOUR';

  return (
    <div 
      ref={containerRef}
      style={{
        position: 'fixed',
        inset: 0,
        background: COLORS.bg,
        zIndex: 1000,
        overflow: 'hidden',
      }}
    >
      {/* Vidéo caméra */}
      <video
        ref={vidRef}
        autoPlay
        playsInline
        muted
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          filter: isNightMode ? 'brightness(0.7) contrast(1.1)' : 'none',
        }}
      />
      
      {/* Overlay nuit */}
      {isNightMode && (
        <div style={{
          position: 'absolute',
          inset: 0,
          background: 'radial-gradient(ellipse at center, transparent 0%, rgba(0,20,40,0.3) 100%)',
          pointerEvents: 'none',
          zIndex: 1,
        }} />
      )}
      
      {/* Chemin AR */}
      <ARPathOverlay 
        waypoints={waypoints}
        heading={heading}
        screenSize={screenSize}
        targetBearing={arrowRotation}
      />
      
      {/* Flèche direction */}
      <DirectionArrow 
        rotation={arrowRotation}
        distance={target.dist}
        label={directionLabel}
      />
      
      {/* Mini radar */}
      <MiniRadar 
        stations={stations}
        heading={heading}
        target={target}
        gpsPos={userPos}
      />
      
      {/* Alerte danger */}
      {showDanger && (
        <DangerAlert 
          type={showDanger}
          distance={target.dist}
          onDismiss={() => setShowDanger(null)}
        />
      )}
      
      {/* Bouton fermer */}
      <button
        onPointerDown={onExit}
        style={{
          position: 'absolute',
          top: 14,
          left: 14,
          padding: '10px 16px',
          background: 'rgba(8,12,15,0.9)',
          border: `1px solid ${COLORS.border}`,
          borderRadius: 20,
          color: COLORS.text,
          fontSize: 12,
          fontWeight: 700,
          cursor: 'pointer',
          zIndex: 30,
          backdropFilter: 'blur(10px)',
        }}
      >
        ✕ QUITTER
      </button>
      
      {/* Mode nuit toggle */}
      <button
        onPointerDown={() => {}} // Géré par parent
        style={{
          position: 'absolute',
          top: 14,
          right: 14,
          width: 40,
          height: 40,
          borderRadius: '50%',
          background: isNightMode ? 'rgba(245,130,13,0.2)' : 'rgba(8,12,15,0.9)',
          border: `1px solid ${isNightMode ? COLORS.accent : COLORS.border}`,
          color: isNightMode ? COLORS.accent : COLORS.text,
          fontSize: 18,
          cursor: 'pointer',
          zIndex: 30,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {isNightMode ? '🌙' : '☀️'}
      </button>
      
      {/* Panneau info */}
      <ARInfoPanel 
        target={target}
        distance={target.dist}
        eta={eta}
        streak={streak}
        calories={calories}
        isNightMode={isNightMode}
      />
      
      {/* Fallback si caméra refusée */}
      {camState === 'denied' && (
        <div style={{
          position: 'absolute',
          inset: 0,
          background: COLORS.bg,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 40,
          textAlign: 'center',
          zIndex: 100,
        }}>
          <div style={{ fontSize: 48, marginBottom: 20 }}>📷❌</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: COLORS.text, marginBottom: 10 }}>
            Caméra non disponible
          </div>
          <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 20 }}>
            Le mode AR nécessite l'accès à la caméra. Tu peux utiliser le mode navigation standard.
          </div>
          <button
            onPointerDown={onExit}
            style={{
              padding: '12px 24px',
              background: COLORS.accent,
              border: 'none',
              borderRadius: 8,
              color: '#fff',
              fontSize: 14,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            RETOUR
          </button>
        </div>
      )}
    </div>
  );
}
