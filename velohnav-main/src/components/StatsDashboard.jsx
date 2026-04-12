import { useMemo } from 'react';

const C = {
  bg: "#080c0f",
  card: "rgba(8,12,15,0.98)",
  border: "rgba(255,255,255,0.07)",
  accent: "#F5820D",
  accentBg: "rgba(245,130,13,0.12)",
  good: "#2ECC8F",
  warn: "#F5A623",
  bad: "#E03E3E",
  blue: "#3B82F6",
  purple: "#8B5CF6",
  text: "#E2E6EE",
  muted: "#4A5568",
  fnt: "'Courier New', monospace",
};

// Générer un graphique simple
function MiniChart({ data, color }) {
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  
  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-end',
      gap: 2,
      height: 40,
    }}>
      {data.map((val, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            height: `${((val - min) / range) * 100}%`,
            background: color,
            borderRadius: 1,
            minHeight: 2,
            opacity: 0.6 + (i / data.length) * 0.4,
          }}
        />
      ))}
    </div>
  );
}

export function StatsDashboard({ 
  stats, 
  formatted, 
  allBadges, 
  weeklyStats, 
  unlockedBadges,
  isOpen, 
  onClose,
}) {
  if (!isOpen || !formatted) return null;

  // Générer données mock pour le graphique (à remplacer par vraies données historiques)
  const mockWeekData = useMemo(() => {
    return [12, 8, 15, 22, 18, 25, 30]; // km par jour
  }, []);

  const mockMonthData = useMemo(() => {
    return [45, 62, 58, 71, 55, 80, 92];
  }, []);

  // Badges débloqués vs total
  const unlockedCount = allBadges.filter(b => b.unlocked).length;
  const totalBadges = allBadges.length;

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: C.bg,
      zIndex: 1000,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '16px 14px',
        borderBottom: `1px solid ${C.border}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 24 }}>📊</span>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>
              Statistiques
            </div>
            <div style={{ fontSize: 11, color: C.muted }}>
              {formatted.totalRides} trajets · {unlockedCount}/{totalBadges} badges
            </div>
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

      {/* Contenu scrollable */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        
        {/* Cartes principales */}
        <div style={{ padding: 14 }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 10,
          }}>
            {/* Distance totale */}
            <div style={{
              padding: 16,
              background: 'rgba(255,255,255,0.02)',
              border: `1px solid ${C.border}`,
              borderRadius: 12,
            }}>
              <div style={{ fontSize: 20, marginBottom: 4 }}>🚲</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: C.text }}>
                {formatted.totalDistanceKm}
              </div>
              <div style={{ fontSize: 10, color: C.muted, letterSpacing: 1 }}>KILOMÈTRES</div>
            </div>

            {/* CO2 */}
            <div style={{
              padding: 16,
              background: 'rgba(46,204,143,0.08)',
              border: `1px solid ${C.good}40`,
              borderRadius: 12,
            }}>
              <div style={{ fontSize: 20, marginBottom: 4 }}>🌍</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: C.good }}>
                {formatted.totalCO2SavedKg}
              </div>
              <div style={{ fontSize: 10, color: C.muted, letterSpacing: 1 }}>KG CO₂ ÉVITÉ</div>
            </div>

            {/* Économies */}
            <div style={{
              padding: 16,
              background: 'rgba(245,130,13,0.08)',
              border: `1px solid ${C.accent}40`,
              borderRadius: 12,
            }}>
              <div style={{ fontSize: 20, marginBottom: 4 }}>💰</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: C.accent }}>
                {formatted.totalMoneySaved}€
              </div>
              <div style={{ fontSize: 10, color: C.muted, letterSpacing: 1 }}>ÉCONOMISÉS</div>
            </div>

            {/* Calories */}
            <div style={{
              padding: 16,
              background: 'rgba(59,130,246,0.08)',
              border: `1px solid ${C.blue}40`,
              borderRadius: 12,
            }}>
              <div style={{ fontSize: 20, marginBottom: 4 }}>⚡</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: C.blue }}>
                {formatted.totalCalories}
              </div>
              <div style={{ fontSize: 10, color: C.muted, letterSpacing: 1 }}>KCAL BRÛLÉES</div>
            </div>
          </div>
        </div>

        {/* Streak */}
        <div style={{ padding: '0 14px 14px' }}>
          <div style={{
            padding: 16,
            background: 'rgba(139,92,246,0.08)',
            border: `1px solid ${C.purple}40`,
            borderRadius: 12,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ fontSize: 32 }}>🔥</div>
              <div>
                <div style={{ fontSize: 20, fontWeight: 800, color: C.purple }}>
                  {formatted.currentStreak} jours
                </div>
                <div style={{ fontSize: 11, color: C.muted }}>
                  Record: {formatted.maxStreak} jours · {formatted.uniqueStations} stations
                </div>
              </div>
            </div>
            <div style={{
              padding: '8px 12px',
              background: C.purple,
              borderRadius: 20,
              fontSize: 11,
              fontWeight: 700,
              color: '#fff',
            }}>
              STREAK
            </div>
          </div>
        </div>

        {/* Graphiques */}
        <div style={{ padding: '0 14px 14px' }}>
          <div style={{
            padding: 14,
            background: 'rgba(255,255,255,0.02)',
            border: `1px solid ${C.border}`,
            borderRadius: 12,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: C.text, fontWeight: 600 }}>Activité cette semaine</div>
              <div style={{ fontSize: 11, color: C.accent }}>
                {weeklyStats?.distance ? (weeklyStats.distance / 1000).toFixed(1) : 0} km
              </div>
            </div>
            <MiniChart data={mockWeekData} color={C.accent} />
            <div style={{ 
              display: 'flex', 
              justifyContent: 'space-between', 
              marginTop: 8,
              fontSize: 9,
              color: C.muted,
            }}>
              <span>L</span><span>M</span><span>M</span><span>J</span><span>V</span><span>S</span><span>D</span>
            </div>
          </div>
        </div>

        {/* Nouveaux badges */}
        {unlockedBadges.length > 0 && (
          <div style={{ padding: '0 14px 14px' }}>
            <div style={{ fontSize: 12, color: C.text, fontWeight: 600, marginBottom: 10 }}>
              🎉 Badges récemment débloqués
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {unlockedBadges.map(badge => (
                <div
                  key={badge.id}
                  style={{
                    padding: '12px 16px',
                    background: C.accentBg,
                    border: `1px solid ${C.accent}`,
                    borderRadius: 12,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    animation: 'badgePop 0.5s ease-out',
                  }}
                >
                  <span style={{ fontSize: 24 }}>{badge.icon}</span>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>
                      {badge.name}
                    </div>
                    <div style={{ fontSize: 9, color: C.muted }}>
                      {badge.description}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tous les badges */}
        <div style={{ padding: '0 14px 14px' }}>
          <div style={{ fontSize: 12, color: C.text, fontWeight: 600, marginBottom: 10 }}>
            🏆 Collection de badges
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {allBadges.map(badge => (
              <div
                key={badge.id}
                style={{
                  padding: 12,
                  background: badge.unlocked ? 'rgba(46,204,143,0.08)' : 'rgba(255,255,255,0.02)',
                  border: `1px solid ${badge.unlocked ? C.good + '40' : C.border}`,
                  borderRadius: 10,
                  opacity: badge.unlocked ? 1 : 0.6,
                }}
              >
                <div style={{ 
                  fontSize: 20, 
                  marginBottom: 4,
                  filter: badge.unlocked ? 'none' : 'grayscale(100%)',
                }}>
                  {badge.icon}
                </div>
                <div style={{ fontSize: 11, fontWeight: 600, color: C.text }}>
                  {badge.name}
                </div>
                <div style={{ fontSize: 9, color: C.muted, marginBottom: 6 }}>
                  {badge.description}
                </div>
                
                {/* Barre de progression */}
                {!badge.unlocked && (
                  <div>
                    <div style={{
                      height: 4,
                      background: 'rgba(255,255,255,0.1)',
                      borderRadius: 2,
                      overflow: 'hidden',
                    }}>
                      <div style={{
                        width: `${badge.progress}%`,
                        height: '100%',
                        background: C.accent,
                        borderRadius: 2,
                        transition: 'width 0.5s ease',
                      }} />
                    </div>
                    <div style={{ fontSize: 8, color: C.muted, marginTop: 2 }}>
                      {Math.round(badge.progress)}%
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Footer info */}
        <div style={{ padding: '14px', textAlign: 'center' }}>
          <div style={{ fontSize: 10, color: C.muted }}>
            Continue à rouler pour débloquer plus de badges ! 🚲
          </div>
        </div>
      </div>

      <style>{`
        @keyframes badgePop {
          0% { transform: scale(0.8); opacity: 0; }
          50% { transform: scale(1.05); }
          100% { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
