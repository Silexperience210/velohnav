import { useEffect } from 'react';

const C = {
  bg: "#080c0f",
  accent: "#F5820D",
  text: "#E2E6EE",
  muted: "#4A5568",
  good: "#2ECC8F",
};

export function VoiceControlButton({ 
  isListening, 
  isSpeaking, 
  transcript, 
  onToggle,
  supported,
}) {
  if (!supported) return null;

  return (
    <button
      onClick={onToggle}
      style={{
        position: 'fixed',
        bottom: 100,
        right: 14,
        width: 56,
        height: 56,
        borderRadius: '50%',
        background: isListening ? C.bad : isSpeaking ? C.good : C.accent,
        border: 'none',
        boxShadow: isListening 
          ? `0 0 30px ${C.bad}80` 
          : `0 4px 20px rgba(245,130,13,0.4)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        zIndex: 100,
        animation: isListening ? 'pulse 1.5s infinite' : 'none',
        transition: 'all 0.3s ease',
      }}
    >
      <span style={{ fontSize: 24 }}>
        {isListening ? '🎙️' : isSpeaking ? '🔊' : '🎤'}
      </span>

      {/* Animation ondes sonores */}
      {isListening && (
        <>
          <div style={{
            position: 'absolute',
            inset: -4,
            borderRadius: '50%',
            border: `2px solid ${C.bad}`,
            animation: 'ripple 1.5s infinite',
          }} />
          <div style={{
            position: 'absolute',
            inset: -8,
            borderRadius: '50%',
            border: `2px solid ${C.bad}`,
            animation: 'ripple 1.5s infinite 0.5s',
          }} />
        </>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.05); }
        }
        @keyframes ripple {
          0% { transform: scale(1); opacity: 0.5; }
          100% { transform: scale(1.5); opacity: 0; }
        }
      `}</style>
    </button>
  );
}

export function VoiceTranscript({ transcript, isListening }) {
  if (!isListening || !transcript) return null;

  return (
    <div style={{
      position: 'fixed',
      bottom: 170,
      left: 14,
      right: 80,
      padding: '12px 16px',
      background: 'rgba(8,12,15,0.95)',
      border: `1px solid ${C.accent}40`,
      borderRadius: 12,
      zIndex: 100,
      animation: 'fadeUp 0.3s ease-out',
    }}>
      <div style={{ fontSize: 10, color: C.muted, marginBottom: 4 }}>
        J'écoute...
      </div>
      <div style={{ fontSize: 14, color: C.text }}>
        "{transcript}"
      </div>

      <style>{`
        @keyframes fadeUp {
          from { transform: translateY(10px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

// Hook pour gérer les commandes vocales
export function useVoiceCommands({ 
  voice, 
  stations, 
  sel, 
  setSel, 
  setArNavActive,
  gpsPos,
}) {
  useEffect(() => {
    if (!voice.lastCommand) return;

    const { command } = voice.lastCommand;
    const responses = voice.speakResponse;

    switch (command) {
      case 'next_station':
      case 'nearest_station': {
        // Trouver la station la plus proche avec vélos
        const available = stations
          .filter(s => s.bikes > 0)
          .sort((a, b) => a.dist - b.dist)[0];
        
        if (available) {
          setSel(available.id);
          responses(command, available);
        } else {
          responses('error');
        }
        break;
      }

      case 'bikes': {
        const station = stations.find(s => s.id === sel);
        if (station) {
          responses('bikes', station.bikes);
        } else {
          responses('error');
          voice.speak('Aucune station sélectionnée. Dis prochaine station pour en trouver une.');
        }
        break;
      }

      case 'distance': {
        const station = stations.find(s => s.id === sel);
        if (station) {
          responses('distance', station.dist);
        } else {
          responses('error');
        }
        break;
      }

      case 'eta': {
        const station = stations.find(s => s.id === sel);
        if (station) {
          const minutes = Math.round(station.dist / 4.2 / 60);
          responses('eta', minutes);
        } else {
          responses('error');
        }
        break;
      }

      case 'navigate': {
        if (sel) {
          setArNavActive(true);
          responses('navigate');
        } else {
          voice.speak('Sélectionne d\'abord une station. Dis prochaine station.');
        }
        break;
      }

      case 'stop':
      case 'exit': {
        setArNavActive(false);
        responses('stop');
        break;
      }

      case 'help':
        responses('help');
        break;

      default:
        responses('error');
    }
  }, [voice.lastCommand]); // eslint-disable-line
}
