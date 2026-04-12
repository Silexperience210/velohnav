import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { 
  useDeviceOrientation, 
  calculateBearing, 
  isInFOV, 
  bearingToScreenX 
} from "../hooks/useDeviceOrientation";

// ── DESIGN CONSTANTS ──────────────────────────────────────────────
const C = {
  bg:"#080c0f", border:"rgba(255,255,255,0.07)",
  accent:"#F5820D", accentBg:"rgba(245,130,13,0.12)",
  good:"#2ECC8F", warn:"#F5820D", bad:"#E03E3E",
  blue:"#3B82F6", text:"#E2E6EE", muted:"#4A5568",
  fnt:"'Courier New', monospace",
};

const fDist = m => m<1000 ? `${m}m` : `${(m/1000).toFixed(1)}km`;
const fWalk = m => `${Math.round(m/80)} min`;
const bCol = s => s.status==="CLOSED"?"#444":s.bikes===0?C.bad:s.bikes<=2?C.warn:C.good;
const bTag = s => s.status==="CLOSED"?"FERMÉ":s.bikes===0?"VIDE":s.bikes<=2?"FAIBLE":"DISPO";

// ── CITY BACKGROUND (fallback quand caméra inactive) ──────────────
function CityBG({ off }) {
  const s = off % 80;
  return (
    <svg style={{ position:"absolute",inset:0,width:"100%",height:"100%" }}
      viewBox="0 0 400 600" preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0d2010"/><stop offset="100%" stopColor="#152a18"/>
        </linearGradient>
        <linearGradient id="rg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0e1a0e"/><stop offset="100%" stopColor="#1a2a1a"/>
        </linearGradient>
      </defs>
      <rect width="400" height="600" fill="#0a1a12"/>
      <rect width="400" height="280" fill="url(#sg)"/>
      <polygon points="80,380 320,380 400,600 0,600" fill="url(#rg)"/>
      {[0,1,2].map(i=><rect key={`l${i}`} x={i*35} y={180-i*20} width={30} height={200+i*20}
        fill={`rgba(10,${25+i*5},12,0.9)`} stroke="rgba(50,100,50,0.15)" strokeWidth="0.5"/>)}
      {[0,1,2].map(i=><rect key={`r${i}`} x={290+i*35} y={160+i*15} width={28} height={220-i*15}
        fill={`rgba(8,${20+i*4},10,0.9)`} stroke="rgba(50,100,50,0.12)" strokeWidth="0.5"/>)}
      {[0,1,2,3].map(i=><rect key={`m${i}`} x={197} y={420+i*50-(s*0.6)%50} width={6} height={28}
        fill="rgba(255,140,0,0.2)" rx="1"/>)}
      <rect width="400" height="600" fill="rgba(0,0,0,0.22)"/>
    </svg>
  );
}

// ── AR PIN COMPONENT ─────────────────────────────────────────────
function ARPin({ s, isSelected, onSelect }) {
  const col = bCol(s);
  
  return (
    <div 
      onPointerDown={onSelect}
      style={{ 
        position: "absolute", 
        left: s.screenX, 
        top: s.screenY,
        transform: "translate(-50%, -50%)", 
        cursor: "pointer",
        zIndex: isSelected ? 25 : 14,
        padding: 14,
        margin: -14,
        transition: "left 0.1s ease-out" // Légère transition pour smoothness
      }}
    >
      {/* Halo pulsant */}
      <div style={{ 
        position: "absolute", 
        top: 14, 
        left: 14, 
        width: 13, 
        height: 13, 
        borderRadius: "50%",
        boxShadow: `0 0 0 3px ${col}22`,
        pointerEvents: "none" 
      }}/>
      
      {/* Point central */}
      <div style={{ 
        width: isSelected ? 18 : 13, 
        height: isSelected ? 18 : 13, 
        borderRadius: "50%", 
        background: col,
        border: `2px solid ${isSelected ? "#fff" : "rgba(0,0,0,0.55)"}`, 
        boxShadow: `0 0 10px ${col}`,
        transform: `scale(${isSelected ? 1.3 : s.scale || 1})`, 
        transition: "transform 0.15s, width 0.15s, height 0.15s",
        position: "relative", 
        zIndex: 2 
      }}/>
      
      {/* Label */}
      <div style={{
        position: "absolute",
        top: "50%",
        transform: "translateY(-50%)",
        ...(s.labelRight ? { left: 22 } : { right: 22 }),
        background: "rgba(6,10,14,0.94)",
        border: `1px solid ${isSelected ? col : col + "55"}`,
        borderRadius: 5,
        padding: "5px 9px",
        whiteSpace: "nowrap",
        boxShadow: isSelected ? `0 0 16px ${col}40` : "none",
        pointerEvents: "none",
        transition: "border-color 0.15s, box-shadow 0.15s",
      }}>
        <div style={{ 
          color: isSelected ? col : C.text, 
          fontSize: 10, 
          fontFamily: C.fnt, 
          fontWeight: 700 
        }}>
          {s.name}
        </div>
        <div style={{ display: "flex", gap: 7, marginTop: 2, alignItems: "center" }}>
          <span style={{ color: col, fontSize: 13, fontFamily: C.fnt, fontWeight: 900 }}>
            {s.bikes}
          </span>
          {s.elec > 0 && <span style={{ color: "#60A5FA", fontSize: 8 }}>⚡{s.elec}</span>}
          <span style={{ color: C.muted, fontSize: 8 }}>{fDist(s.dist)}</span>
          {s._mock && <span style={{ color: "#444", fontSize: 7 }}>~</span>}
        </div>
      </div>
    </div>
  );
}

// ── COMPASS INDICATOR ────────────────────────────────────────────
function CompassIndicator({ heading, stations }) {
  // Calculer les stations visibles par quadrant
  const visibleStations = useMemo(() => {
    return stations.filter(s => s.inFOV).length;
  }, [stations]);

  return (
    <div style={{ 
      position: "absolute", 
      top: 10, 
      left: "50%", 
      transform: "translateX(-50%)", 
      zIndex: 20, 
      pointerEvents: "none",
      display: "flex",
      flexDirection: "column",
      alignItems: "center"
    }}>
      {/* Boussole numérique */}
      <div style={{ 
        background: "rgba(8,12,15,0.82)", 
        border: `1px solid ${C.border}`, 
        borderRadius: 3, 
        padding: "6px 14px",
        display: "flex",
        alignItems: "center",
        gap: 8
      }}>
        <span style={{ 
          color: C.accent, 
          fontSize: 14, 
          fontFamily: C.fnt, 
          fontWeight: 700,
          minWidth: 45,
          textAlign: "center"
        }}>
          {Math.round(heading)}°
        </span>
        <span style={{ color: C.muted, fontSize: 10 }}>
          {heading >= 337 || heading < 23 ? "N" :
           heading >= 23 && heading < 68 ? "NE" :
           heading >= 68 && heading < 113 ? "E" :
           heading >= 113 && heading < 158 ? "SE" :
           heading >= 158 && heading < 203 ? "S" :
           heading >= 203 && heading < 248 ? "SW" :
           heading >= 248 && heading < 293 ? "W" : "NW"}
        </span>
      </div>
      
      {/* Indicateur stations visibles */}
      <div style={{
        marginTop: 4,
        background: "rgba(8,12,15,0.7)",
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        padding: "2px 10px",
        fontSize: 8,
        fontFamily: C.fnt,
        color: C.muted
      }}>
        {visibleStations} station{visibleStations > 1 ? 's' : ''} visible{visibleStations > 1 ? 's' : ''}
      </div>
      
      <div style={{ color: C.accent, fontSize: 8, textAlign: "center", lineHeight: "4px" }}>▾</div>
    </div>
  );
}

// ── GYROSCOPE CALIBRATION MODAL ─────────────────────────────────
function GyroPermissionModal({ onRequest, permission, isSupported }) {
  if (permission === 'granted' || !isSupported) return null;
  
  return (
    <div style={{
      position: "absolute",
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)",
      zIndex: 40,
      background: "rgba(8,12,15,0.98)",
      border: `1px solid ${C.accent}`,
      borderRadius: 12,
      padding: "24px",
      maxWidth: 280,
      textAlign: "center"
    }}>
      <div style={{ fontSize: 24, marginBottom: 12 }}>🧭</div>
      <div style={{ 
        color: C.text, 
        fontSize: 14, 
        fontFamily: C.fnt, 
        fontWeight: 700,
        marginBottom: 8 
      }}>
        ACTIVER LE GYROSCOPE
      </div>
      <div style={{ 
        color: C.muted, 
        fontSize: 10, 
        fontFamily: C.fnt,
        lineHeight: 1.6,
        marginBottom: 16
      }}>
        Pour voir les stations en AR, l'app a besoin d'accéder à l'orientation de ton téléphone.
      </div>
      <button 
        onClick={onRequest}
        style={{
          background: C.accentBg,
          border: `1px solid ${C.accent}`,
          color: C.accent,
          borderRadius: 6,
          padding: "10px 24px",
          fontSize: 11,
          fontFamily: C.fnt,
          fontWeight: 700,
          cursor: "pointer",
          width: "100%"
        }}
      >
        AUTORISER
      </button>
    </div>
  );
}

// ── MAIN AR SCREEN ───────────────────────────────────────────────
export function ARScreen({ stations, sel, setSel, gpsPos, onNavigateAR }) {
  const vidRef = useRef(null);
  const containerRef = useRef(null);
  const [cam, setCam] = useState("idle"); // idle | requesting | active | denied
  const [bgOff, setBgOff] = useState(0);
  const [screenSize, setScreenSize] = useState({ width: 0, height: 0 });
  
  // Hook gyroscope réel
  const { 
    alpha: heading, 
    beta, 
    gamma,
    permission, 
    isSupported, 
    requestPermission,
    calibrated 
  } = useDeviceOrientation();

  // Mettre à jour la taille de l'écran
  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        setScreenSize({
          width: containerRef.current.offsetWidth,
          height: containerRef.current.offsetHeight
        });
      }
    };
    updateSize();
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, []);

  // Animation background fallback
  useEffect(() => { 
    const t = setInterval(() => setBgOff(o => o + 0.5), 50); 
    return () => clearInterval(t); 
  }, []);

  // Démarrer caméra
  const startCam = useCallback(async () => {
    setCam("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: "environment" } 
      });
      if (vidRef.current) { 
        vidRef.current.srcObject = stream; 
        await vidRef.current.play(); 
      }
      setCam("active");
    } catch (e) { 
      console.warn("Cam:", e); 
      setCam("denied"); 
    }
  }, []);

  // Cleanup caméra
  useEffect(() => {
    return () => { 
      vidRef.current?.srcObject?.getTracks().forEach(t => t.stop()); 
    };
  }, []);

  // Calculer les positions AR des stations
  const arStations = useMemo(() => {
    if (!gpsPos || screenSize.width === 0) return [];
    
    const FOV = 60; // Field of view horizontal en degrés
    const MAX_DISTANCE = 2000; // Ne pas montrer au-delà de 2km
    
    return stations
      .filter(s => s.dist <= MAX_DISTANCE)
      .map(s => {
        // Calculer le bearing (direction) vers la station
        const bearing = calculateBearing(gpsPos.lat, gpsPos.lng, s.lat, s.lng);
        
        // Vérifier si dans le champ de vision
        const inFOV = isInFOV(bearing, heading, FOV);
        
        // Calculer position X écran
        const screenX = bearingToScreenX(bearing, heading, screenSize.width, FOV);
        
        // Calculer position Y (simplifié - distance = hauteur)
        // Plus c'est proche, plus c'est bas (à l'horizon)
        const horizonY = screenSize.height * 0.6;
        const distanceFactor = Math.min(s.dist / 1000, 1); // 0-1
        const screenY = horizonY - (1 - distanceFactor) * (screenSize.height * 0.3);
        
        // Échelle selon distance (plus proche = plus gros)
        const scale = Math.max(0.6, 1 - (s.dist / 2000));
        
        return {
          ...s,
          bearing,
          inFOV,
          screenX,
          screenY,
          scale,
          labelRight: screenX < screenSize.width / 2
        };
      })
      .sort((a, b) => b.dist - a.dist); // Trier par distance (lointains d'abord pour z-index)
  }, [stations, heading, gpsPos, screenSize]);

  const selectedStation = arStations.find(s => s.id === sel);

  return (
    <div 
      ref={containerRef}
      style={{ 
        position: "relative", 
        flex: 1, 
        overflow: "hidden", 
        minHeight: 0, 
        background: "#000" 
      }}
    >
      {/* Vidéo caméra */}
      <video 
        ref={vidRef} 
        muted 
        playsInline 
        autoPlay 
        style={{
          position: "absolute", 
          inset: 0, 
          width: "100%", 
          height: "100%", 
          objectFit: "cover", 
          zIndex: 1,
          opacity: cam === "active" ? 1 : 0, 
          transition: "opacity 0.5s" 
        }}
      />
      
      {/* Fallback background */}
      {cam !== "active" && (
        <div style={{ position: "absolute", inset: 0, zIndex: 2 }}>
          <CityBG off={bgOff}/>
        </div>
      )}

      {/* Overlays visuels */}
      <div style={{ position: "absolute", inset: 0, zIndex: 5, pointerEvents: "none" }}>
        <div style={{ 
          position: "absolute", 
          inset: 0, 
          background: "radial-gradient(ellipse at center,transparent 30%,rgba(0,0,0,0.4) 100%)"
        }}/>
        <div style={{ 
          position: "absolute", 
          top: 0, 
          left: 0, 
          right: 0, 
          height: 70, 
          background: "linear-gradient(to bottom,rgba(8,12,15,0.65),transparent)"
        }}/>
        <div style={{ 
          position: "absolute", 
          bottom: 0, 
          left: 0, 
          right: 0, 
          height: 230, 
          background: "linear-gradient(to top,rgba(8,12,15,0.98),rgba(8,12,15,0.4) 60%,transparent)"
        }}/>
      </div>

      {/* Boussole et indicateurs */}
      <CompassIndicator heading={heading} stations={arStations} />

      {/* Lignes de visée horizontales */}
      <div style={{ 
        position: "absolute", 
        top: "46%", 
        left: 0, 
        right: 0, 
        height: 1, 
        zIndex: 6, 
        pointerEvents: "none",
        background: `linear-gradient(to right,transparent,${C.accent}45,${C.accent}45,transparent)` 
      }}/>

      {/* Cible centrale */}
      <div style={{ 
        position: "absolute", 
        top: "46%", 
        left: "50%", 
        transform: "translate(-50%,-50%)", 
        pointerEvents: "none", 
        zIndex: 6 
      }}>
        <svg width="26" height="26" viewBox="0 0 26 26">
          <circle cx="13" cy="13" r="4" fill="none" stroke={`${C.accent}45`} strokeWidth="1"/>
          <line x1="13" y1="0" x2="13" y2="7" stroke={`${C.accent}45`} strokeWidth="1"/>
          <line x1="13" y1="19" x2="13" y2="26" stroke={`${C.accent}45`} strokeWidth="1"/>
          <line x1="0" y1="13" x2="7" y2="13" stroke={`${C.accent}45`} strokeWidth="1"/>
          <line x1="19" y1="13" x2="26" y2="13" stroke={`${C.accent}45`} strokeWidth="1"/>
        </svg>
      </div>

      {/* Modal permission gyroscope */}
      <GyroPermissionModal 
        onRequest={requestPermission}
        permission={permission}
        isSupported={isSupported}
      />

      {/* Bouton caméra */}
      {cam !== "active" && permission === 'granted' && (
        <div style={{ 
          position: "absolute", 
          top: "50%", 
          left: "50%", 
          transform: "translate(-50%,-50%)",
          zIndex: 30, 
          display: "flex", 
          flexDirection: "column", 
          alignItems: "center", 
          gap: 14 
        }}>
          {cam === "idle" && (
            <>
              <div style={{ 
                color: C.muted, 
                fontSize: 9, 
                fontFamily: C.fnt, 
                letterSpacing: 3 
              }}>
                VUE AR REAL
              </div>
              <div style={{
                color: C.accent,
                fontSize: 10,
                fontFamily: C.fnt,
                textAlign: "center",
                maxWidth: 200,
                lineHeight: 1.6
              }}>
                Pointe ton téléphone vers les stations pour les voir apparaître
              </div>
              <button 
                onClick={startCam}
                style={{
                  background: C.accentBg, 
                  border: `1px solid ${C.accent}`, 
                  color: C.accent,
                  borderRadius: 5, 
                  padding: "12px 32px", 
                  fontSize: 12, 
                  fontFamily: C.fnt,
                  fontWeight: 700, 
                  cursor: "pointer", 
                  letterSpacing: 2, 
                  boxShadow: `0 0 20px ${C.accent}25`,
                  marginTop: 8
                }}
              >
                ▶ ACTIVER CAMÉRA
              </button>
            </>
          )}
          {cam === "requesting" && (
            <div style={{ color: C.accent, fontSize: 10, fontFamily: C.fnt, letterSpacing: 3 }}>
              ACCÈS CAMÉRA…
            </div>
          )}
          {cam === "denied" && (
            <div style={{ textAlign: "center", padding: "0 32px" }}>
              <div style={{ color: C.bad, fontSize: 10, fontFamily: C.fnt, marginBottom: 8 }}>
                CAMÉRA REFUSÉE
              </div>
              <div style={{ color: C.muted, fontSize: 9, fontFamily: C.fnt, lineHeight: 1.7 }}>
                Paramètres → Apps → VelohNav → Autorisations → Caméra
              </div>
              <button 
                onClick={startCam}
                style={{
                  background: "rgba(224,62,62,0.1)", 
                  border: `1px solid ${C.bad}`, 
                  color: C.bad,
                  borderRadius: 4, 
                  padding: "8px 20px", 
                  fontSize: 9, 
                  fontFamily: C.fnt,
                  cursor: "pointer", 
                  marginTop: 12 
                }}
              >
                RÉESSAYER
              </button>
            </div>
          )}
        </div>
      )}

      {/* Pins AR dynamiques */}
      <div style={{ position: "absolute", inset: 0, zIndex: 15 }}>
        {arStations
          .filter(s => s.inFOV)
          .map(s => (
            <ARPin 
              key={s.id} 
              s={s} 
              isSelected={sel === s.id}
              onSelect={() => setSel(sel === s.id ? null : s.id)}
            />
          ))}
      </div>

      {/* Info station sélectionnée */}
      <div style={{ 
        position: "absolute", 
        bottom: 0, 
        left: 0, 
        right: 0, 
        padding: "0 14px 14px", 
        zIndex: 22 
      }}>
        {selectedStation ? (
          <div style={{ 
            background: "rgba(8,12,15,0.97)", 
            borderRadius: 8, 
            padding: "13px 15px",
            border: `1px solid ${C.border}`, 
            borderTop: `2px solid ${bCol(selectedStation)}`,
            boxShadow: "0 -4px 24px rgba(0,0,0,0.85)" 
          }}>
            <div style={{ 
              display: "flex", 
              justifyContent: "space-between", 
              alignItems: "flex-start", 
              marginBottom: 11 
            }}>
              <div>
                <div style={{ 
                  color: C.muted, 
                  fontSize: 7, 
                  fontFamily: C.fnt, 
                  letterSpacing: 1.5, 
                  marginBottom: 3 
                }}>
                  {bTag(selectedStation)} · {fDist(selectedStation.dist)} · {fWalk(selectedStation.dist)} à pied
                  {selectedStation._mock && " · dispo simulées"}
                  {" · "}{Math.round(selectedStation.bearing)}°
                </div>
                <div style={{ 
                  color: C.text, 
                  fontSize: 15, 
                  fontFamily: C.fnt, 
                  fontWeight: 700 
                }}>
                  {selectedStation.name}
                </div>
              </div>
              <div 
                onClick={() => setSel(null)} 
                style={{ 
                  padding: "6px 9px",
                  background: "rgba(255,255,255,0.04)", 
                  border: `1px solid ${C.border}`,
                  borderRadius: 4, 
                  color: C.muted, 
                  fontSize: 11, 
                  cursor: "pointer" 
                }}
              >
                ✕
              </div>
            </div>
            <div style={{ 
              display: "flex", 
              borderTop: `1px solid ${C.border}`, 
              paddingTop: 11 
            }}>
              {[
                { l: "VÉLOS", v: selectedStation.bikes, col: bCol(selectedStation) },
                { l: "ÉLEC.", v: selectedStation.elec, col: "#60A5FA" },
                { l: "MÉCA.", v: selectedStation.meca, col: C.text },
                { l: "DOCKS", v: selectedStation.docks, col: C.text },
              ].map((m, i) => (
                <div 
                  key={m.l} 
                  style={{ 
                    flex: 1, 
                    textAlign: "center", 
                    borderRight: i < 3 ? `1px solid ${C.border}` : "none" 
                  }}
                >
                  <div style={{ 
                    color: m.col, 
                    fontSize: 20, 
                    fontFamily: C.fnt, 
                    fontWeight: 700 
                  }}>
                    {m.v}
                  </div>
                  <div style={{ 
                    color: C.muted, 
                    fontSize: 7, 
                    fontFamily: C.fnt, 
                    letterSpacing: 1, 
                    marginTop: 1 
                  }}>
                    {m.l}
                  </div>
                </div>
              ))}
            </div>
            {/* Bouton Navigation AR */}
            {onNavigateAR && (
              <div 
                onClick={() => onNavigateAR()}
                style={{
                  marginTop: 11,
                  padding: "12px 16px",
                  background: "rgba(245,130,13,0.15)",
                  border: `1px solid ${C.accent}`,
                  borderRadius: 6,
                  color: C.accent,
                  fontSize: 12,
                  fontFamily: C.fnt,
                  fontWeight: 700,
                  textAlign: "center",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 14 }}>🧭</span>
                NAVIGATION AR
              </div>
            )}
          </div>
        ) : (
          <div style={{ 
            background: "rgba(8,12,15,0.85)", 
            border: `1px solid ${C.border}`,
            borderRadius: 8, 
            padding: "11px 15px", 
            textAlign: "center" 
          }}>
            <div style={{ 
              color: C.muted, 
              fontSize: 8, 
              fontFamily: C.fnt, 
              letterSpacing: 2 
            }}>
              {arStations.filter(s => s.inFOV).length}/{arStations.length} EN VUE · TOURNE TON TÉLÉPHONE
            </div>
            {!calibrated && (
              <div style={{ 
                color: C.warn, 
                fontSize: 8, 
                fontFamily: C.fnt, 
                marginTop: 4 
              }}>
                ⚠️ Calibration du gyroscope en cours...
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
