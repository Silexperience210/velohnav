import { useState, useEffect } from 'react';

// ── CONSTANTS ─────────────────────────────────────────────────────
const C = {
  bg: "#080c0f",
  card: "rgba(8,12,15,0.98)",
  border: "rgba(255,255,255,0.07)",
  accent: "#F5820D",
  accentBg: "rgba(245,130,13,0.12)",
  good: "#2ECC8F",
  warn: "#F5820D",
  bad: "#E03E3E",
  text: "#E2E6EE",
  muted: "#4A5568",
  fnt: "'Courier New', monospace",
};

// ── TOGGLE COMPONENT ──────────────────────────────────────────────
function Toggle({ label, sub, val, set, colors }) {
  return (
    <div style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      padding: "11px 0",
      borderBottom: `1px solid ${colors?.border || C.border}`,
    }}>
      <div style={{ flex: 1, marginRight: 12 }}>
        <div style={{ color: colors?.text || C.text, fontSize: 11, fontFamily: colors?.fnt || C.fnt }}>
          {label}
        </div>
        {sub && (
          <div style={{ 
            color: colors?.muted || C.muted, 
            fontSize: 8, 
            fontFamily: colors?.fnt || C.fnt, 
            marginTop: 2, 
            lineHeight: 1.5 
          }}>
            {sub}
          </div>
        )}
      </div>
      <div 
        onPointerDown={() => set(v => !v)}
        style={{
          width: 38,
          height: 20,
          borderRadius: 10,
          cursor: "pointer",
          position: "relative",
          flexShrink: 0,
          background: val ? (colors?.accentBg || C.accentBg) : "rgba(255,255,255,0.04)",
          border: `1px solid ${val ? (colors?.accent || C.accent) : (colors?.border || C.border)}`,
          boxShadow: val ? `0 0 8px ${colors?.accent || C.accent}30` : "none",
          transition: "all 0.2s",
        }}
      >
        <div style={{
          position: "absolute",
          top: 3,
          width: 14,
          height: 14,
          borderRadius: "50%",
          background: val ? (colors?.accent || C.accent) : (colors?.muted || C.muted),
          left: val ? 21 : 3,
          transition: "left 0.2s, background 0.2s",
        }}/>
      </div>
    </div>
  );
}

// ── API KEY INPUT COMPONENT ───────────────────────────────────────
function ApiKeyInput({ 
  label, 
  sub,
  value, 
  onChange, 
  onSave, 
  isValid, 
  isSaving,
  placeholder,
  colors,
  icon,
  helpUrl,
  helpText,
}) {
  const [showKey, setShowKey] = useState(false);

  return (
    <div style={{
      background: "rgba(255,255,255,0.02)",
      border: `1px solid ${colors?.border || C.border}`,
      borderRadius: 12,
      padding: 14,
      marginBottom: 12,
    }}>
      {/* Status indicator */}
      <div style={{
        background: isValid ? "rgba(46,204,143,0.08)" : "rgba(245,130,13,0.08)",
        border: `1px solid ${isValid ? (colors?.good || C.good) + "40" : (colors?.accent || C.accent) + "40"}`,
        borderRadius: 6,
        padding: "8px 12px",
        marginBottom: 12,
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}>
        <span style={{ fontSize: 14 }}>{icon}</span>
        <div>
          <div style={{
            color: isValid ? (colors?.good || C.good) : (colors?.accent || C.accent),
            fontSize: 9,
            fontFamily: colors?.fnt || C.fnt,
            fontWeight: 700,
          }}>
            {isValid ? "✓ CONNECTÉ" : "⚠ NON CONFIGURÉ"}
          </div>
          <div style={{
            color: colors?.muted || C.muted,
            fontSize: 8,
            fontFamily: colors?.fnt || C.fnt,
            marginTop: 2,
          }}>
            {sub}
          </div>
        </div>
      </div>

      {/* Input field */}
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <div style={{ flex: 1, position: "relative" }}>
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            type={showKey ? "text" : "password"}
            style={{
              width: "100%",
              background: "rgba(0,0,0,0.4)",
              border: `1px solid ${colors?.border || C.border}`,
              borderRadius: 6,
              padding: "10px 36px 10px 12px",
              color: colors?.text || C.text,
              fontSize: 11,
              fontFamily: colors?.fnt || C.fnt,
              outline: "none",
              boxSizing: "border-box",
            }}
          />
          <button
            onPointerDown={() => setShowKey(v => !v)}
            style={{
              position: "absolute",
              right: 8,
              top: "50%",
              transform: "translateY(-50%)",
              background: "transparent",
              border: "none",
              color: colors?.muted || C.muted,
              fontSize: 12,
              cursor: "pointer",
              padding: "4px",
            }}
          >
            {showKey ? "🙈" : "👁️"}
          </button>
        </div>
        <button
          onPointerDown={onSave}
          disabled={isSaving || !value.trim()}
          style={{
            background: isSaving ? "rgba(46,204,143,0.15)" : (colors?.accentBg || C.accentBg),
            border: `1px solid ${isSaving ? (colors?.good || C.good) : (colors?.accent || C.accent)}`,
            color: isSaving ? (colors?.good || C.good) : (colors?.accent || C.accent),
            borderRadius: 6,
            padding: "10px 16px",
            fontSize: 10,
            fontFamily: colors?.fnt || C.fnt,
            fontWeight: 700,
            cursor: value.trim() ? "pointer" : "not-allowed",
            whiteSpace: "nowrap",
            opacity: value.trim() ? 1 : 0.5,
          }}
        >
          {isSaving ? "✓ OK" : "SAUVER"}
        </button>
      </div>

      {/* Help link */}
      {helpUrl && (
        <a
          href={helpUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: colors?.muted || C.muted,
            fontSize: 8,
            fontFamily: colors?.fnt || C.fnt,
            textDecoration: "none",
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <span>ℹ️</span>
          <span>{helpText || "Comment obtenir une clé ?"}</span>
          <span>↗</span>
        </a>
      )}
    </div>
  );
}

// ── MAIN SETTINGS SCREEN ──────────────────────────────────────────
export function SettingsScreen({ 
  apiKey, 
  setApiKey, 
  claudeKey,
  setClaudeKey,
  kimiKey,
  setKimiKey,
  aiProvider,
  setAiProvider,
  onRefresh, 
  apiLive, 
  isMock, 
  gpsPos,
  colors,
}) {
  // Local states
  const [draftJc, setDraftJc] = useState(apiKey || "");
  const [draftClaude, setDraftClaude] = useState(claudeKey || "");
  const [draftKimi, setDraftKimi] = useState(kimiKey || "");
  const [saved, setSaved] = useState({ jc: false, claude: false, kimi: false });
  
  // Feature toggles
  const [lnAddr, setLnAddr] = useState("");
  const [lnOn, setLnOn] = useState(false);
  const [lnSaved, setLnSaved] = useState(false);
  const [ads, setAds] = useState(true);
  const [hapticEnabled, setHapticEnabled] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Save handlers
  const saveJc = () => {
    setApiKey(draftJc.trim());
    setSaved(s => ({ ...s, jc: true }));
    setTimeout(() => {
      setSaved(s => ({ ...s, jc: false }));
      onRefresh();
    }, 1500);
  };

  const saveClaude = () => {
    setClaudeKey(draftClaude.trim());
    setSaved(s => ({ ...s, claude: true }));
    setTimeout(() => setSaved(s => ({ ...s, claude: false })), 1500);
  };

  const saveKimi = () => {
    setKimiKey(draftKimi.trim());
    setSaved(s => ({ ...s, kimi: true }));
    setTimeout(() => setSaved(s => ({ ...s, kimi: false })), 1500);
  };

  // Check if keys are valid (simple length check)
  const isJcValid = apiKey && apiKey.length > 20;
  const isClaudeValid = claudeKey && claudeKey.startsWith("sk-");
  const isKimiValid = kimiKey && kimiKey.length > 10;

  const themeColors = colors || C;

  return (
    <div style={{
      flex: 1,
      overflowY: "auto",
      background: themeColors.bg,
      minHeight: 0,
      paddingBottom: 20,
    }}>
      {/* HEADER */}
      <div style={{
        padding: "16px 14px",
        borderBottom: `1px solid ${themeColors.border}`,
        marginBottom: 8,
      }}>
        <h1 style={{
          margin: 0,
          fontSize: 20,
          fontFamily: themeColors.fnt,
          fontWeight: 700,
          color: themeColors.text,
          letterSpacing: 2,
        }}>
          PARAMÈTRES
        </h1>
        <p style={{
          margin: "4px 0 0",
          fontSize: 10,
          fontFamily: themeColors.fnt,
          color: themeColors.muted,
        }}>
          Configuration des API et préférences
        </p>
      </div>

      {/* GPS STATUS */}
      <div style={{ padding: "0 14px 14px" }}>
        <div style={{
          background: "rgba(255,255,255,0.02)",
          border: `1px solid ${gpsPos ? themeColors.good + "40" : themeColors.border}`,
          borderRadius: 12,
          padding: 14,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}>
          <div style={{
            width: 40,
            height: 40,
            borderRadius: "50%",
            background: gpsPos ? themeColors.good + "20" : themeColors.border,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 18,
          }}>
            {gpsPos ? "📍" : "❓"}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{
              color: themeColors.text,
              fontSize: 12,
              fontFamily: themeColors.fnt,
              fontWeight: 700,
            }}>
              {gpsPos ? "GPS ACTIF" : "GPS INACTIF"}
            </div>
            <div style={{
              color: gpsPos ? themeColors.good : themeColors.muted,
              fontSize: 9,
              fontFamily: themeColors.fnt,
              marginTop: 2,
            }}>
              {gpsPos 
                ? `${gpsPos.lat.toFixed(5)}, ${gpsPos.lng.toFixed(5)} ±${gpsPos.acc}m`
                : "En attente de l'autorisation…"
              }
            </div>
          </div>
        </div>
      </div>

      {/* SECTION: CLÉS API */}
      <div style={{ padding: "0 14px 14px" }}>
        <div style={{
          color: themeColors.muted,
          fontSize: 8,
          fontFamily: themeColors.fnt,
          letterSpacing: 2,
          marginBottom: 12,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}>
          <span>🔑</span>
          <span>CLÉS API</span>
        </div>

        {/* JCDecaux */}
        <ApiKeyInput
          label="JCDecaux"
          sub={apiLive ? "Données temps réel" : "Données simulées"}
          value={draftJc}
          onChange={setDraftJc}
          onSave={saveJc}
          isValid={isJcValid}
          isSaving={saved.jc}
          placeholder="Clé API JCDecaux…"
          colors={themeColors}
          icon="🚲"
          helpUrl="https://developer.jcdecaux.com/"
          helpText="developer.jcdecaux.com (gratuit)"
        />

        {/* AI Provider Selection */}
        <div style={{
          background: "rgba(255,255,255,0.02)",
          border: `1px solid ${themeColors.border}`,
          borderRadius: 12,
          padding: 14,
          marginBottom: 12,
        }}>
          <div style={{
            color: themeColors.text,
            fontSize: 11,
            fontFamily: themeColors.fnt,
            fontWeight: 700,
            marginBottom: 10,
          }}>
            🤖 FOURNISSEUR AI
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {[
              { id: 'claude', label: 'Claude', icon: '◉', valid: isClaudeValid },
              { id: 'kimi', label: 'Kimi', icon: '◈', valid: isKimiValid },
              { id: 'none', label: 'Désactivé', icon: '○', valid: true },
            ].map((provider) => (
              <button
                key={provider.id}
                onPointerDown={() => setAiProvider(provider.id)}
                style={{
                  flex: 1,
                  padding: "10px",
                  background: aiProvider === provider.id ? themeColors.accentBg : "transparent",
                  border: `1px solid ${aiProvider === provider.id ? themeColors.accent : themeColors.border}`,
                  borderRadius: 8,
                  color: aiProvider === provider.id ? themeColors.accent : themeColors.text,
                  fontSize: 10,
                  fontFamily: themeColors.fnt,
                  fontWeight: aiProvider === provider.id ? 700 : 500,
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <span>{provider.icon}</span>
                <span>{provider.label}</span>
                {provider.valid && provider.id !== 'none' && (
                  <span style={{ fontSize: 7, color: themeColors.good }}>✓</span>
                )}
              </button>
            ))}
          </div>

          {/* Claude Key */}
          {aiProvider === 'claude' && (
            <ApiKeyInput
              label=""
              sub={isClaudeValid ? "Claude prêt" : "Clé requise (sk-...)"}
              value={draftClaude}
              onChange={setDraftClaude}
              onSave={saveClaude}
              isValid={isClaudeValid}
              isSaving={saved.claude}
              placeholder="sk-ant-..."
              colors={themeColors}
              icon="🧠"
              helpUrl="https://console.anthropic.com/"
              helpText="console.anthropic.com"
            />
          )}

          {/* Kimi Key */}
          {aiProvider === 'kimi' && (
            <ApiKeyInput
              label=""
              sub={isKimiValid ? "Kimi prêt" : "Clé requise"}
              value={draftKimi}
              onChange={setDraftKimi}
              onSave={saveKimi}
              isValid={isKimiValid}
              isSaving={saved.kimi}
              placeholder="Clé API Kimi..."
              colors={themeColors}
              icon="🌙"
              helpUrl="https://platform.moonshot.cn/"
              helpText="platform.moonshot.cn"
            />
          )}
        </div>
      </div>

      {/* SECTION: PRÉFÉRENCES */}
      <div style={{ padding: "0 14px" }}>
        <div style={{
          color: themeColors.muted,
          fontSize: 8,
          fontFamily: themeColors.fnt,
          letterSpacing: 2,
          marginBottom: 12,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}>
          <span>⚙️</span>
          <span>PRÉFÉRENCES</span>
        </div>

        <div style={{
          background: "rgba(255,255,255,0.02)",
          border: `1px solid ${themeColors.border}`,
          borderRadius: 12,
          padding: "0 14px",
          marginBottom: 14,
        }}>
          <Toggle
            label="Vibrations"
            sub="Feedback haptic sur les interactions"
            val={hapticEnabled}
            set={setHapticEnabled}
            colors={themeColors}
          />
          <Toggle
            label="Auto-refresh"
            sub="Mettre à jour les données toutes les 60s"
            val={autoRefresh}
            set={setAutoRefresh}
            colors={themeColors}
          />
          <Toggle
            label="Publicités AR"
            sub="Overlays sponsors dans la vue caméra"
            val={ads}
            set={setAds}
            colors={themeColors}
          />
        </div>
      </div>

      {/* SECTION: SATS REWARDS */}
      <div style={{ padding: "0 14px" }}>
        <div style={{
          color: themeColors.muted,
          fontSize: 8,
          fontFamily: themeColors.fnt,
          letterSpacing: 2,
          marginBottom: 12,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}>
          <span>⚡</span>
          <span>SATS REWARDS</span>
        </div>

        <div style={{
          background: "rgba(255,255,255,0.02)",
          border: `1px solid ${themeColors.border}`,
          borderRadius: 12,
          padding: "0 14px",
          marginBottom: 14,
        }}>
          <Toggle
            label="Activer"
            sub="Recevoir des sats après chaque trajet"
            val={lnOn}
            set={setLnOn}
            colors={themeColors}
          />
          {lnOn && (
            <div style={{ paddingBottom: 14 }}>
              <div style={{
                color: themeColors.muted,
                fontSize: 8,
                fontFamily: themeColors.fnt,
                letterSpacing: 2,
                margin: "10px 0 6px",
              }}>
                LIGHTNING ADDRESS
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  value={lnAddr}
                  onChange={(e) => setLnAddr(e.target.value)}
                  placeholder="toi@getalby.com"
                  style={{
                    flex: 1,
                    background: "rgba(0,0,0,0.4)",
                    border: `1px solid ${themeColors.border}`,
                    borderRadius: 6,
                    padding: "10px 12px",
                    color: "#FCD34D",
                    fontSize: 11,
                    fontFamily: themeColors.fnt,
                    outline: "none",
                  }}
                />
                <button
                  onPointerDown={() => { setLnSaved(true); setTimeout(() => setLnSaved(false), 2000); }}
                  style={{
                    background: lnSaved ? "rgba(46,204,143,0.15)" : themeColors.accentBg,
                    border: `1px solid ${lnSaved ? themeColors.good : themeColors.accent}`,
                    color: lnSaved ? themeColors.good : themeColors.accent,
                    borderRadius: 6,
                    padding: "10px 16px",
                    fontSize: 10,
                    fontFamily: themeColors.fnt,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  {lnSaved ? "✓ OK" : "SAVE"}
                </button>
              </div>
              <div style={{
                color: themeColors.muted,
                fontSize: 8,
                fontFamily: themeColors.fnt,
                marginTop: 8,
                lineHeight: 1.8,
              }}>
                Compatible: Alby · WoS · Phoenix · Blink · Zeus
              </div>
            </div>
          )}
        </div>
      </div>

      {/* FOOTER */}
      <div style={{
        padding: "20px 14px",
        textAlign: "center",
      }}>
        <div style={{
          color: themeColors.muted,
          fontSize: 9,
          fontFamily: themeColors.fnt,
        }}>
          VelohNav v2.0.0
        </div>
        <div style={{
          color: themeColors.muted,
          fontSize: 8,
          fontFamily: themeColors.fnt,
          marginTop: 4,
          opacity: 0.7,
        }}>
          AR Bike Sharing for Luxembourg
        </div>
      </div>
    </div>
  );
}
