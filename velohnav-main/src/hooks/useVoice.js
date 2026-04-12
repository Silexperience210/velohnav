import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Hook pour les commandes vocales
 * Utilise Web Speech API
 */

const COMMANDS = {
  fr: {
    'prochaine station': 'next_station',
    'station suivante': 'next_station',
    'station la plus proche': 'nearest_station',
    'près de moi': 'nearest_station',
    'combien de temps': 'eta',
    'temps de trajet': 'eta',
    'distance': 'distance',
    'combien de vélos': 'bikes',
    'vélos disponibles': 'bikes',
    'arrête': 'stop',
    'quitter': 'exit',
    'naviguer': 'navigate',
    'go': 'navigate',
  }
};

const RESPONSES = {
  fr: {
    next_station: (station) => `Prochaine station: ${station?.name || 'inconnue'}, à ${Math.round(station?.dist || 0)} mètres. ${station?.bikes || 0} vélos disponibles.`,
    nearest_station: (station) => `Station la plus proche: ${station?.name || 'inconnue'}, à ${Math.round(station?.dist || 0)} mètres.`,
    eta: (minutes) => `Temps estimé: ${minutes} minutes à vélo.`,
    distance: (dist) => `Distance: ${dist < 1000 ? Math.round(dist) + ' mètres' : (dist / 1000).toFixed(1) + ' kilomètres'}.`,
    bikes: (count) => `${count} vélos disponibles sur cette station.`,
    stop: 'Navigation arrêtée.',
    navigate: 'Démarrage de la navigation.',
    error: 'Désolé, je n\'ai pas compris.',
    no_station: 'Aucune station sélectionnée.',
    help: 'Commandes disponibles: prochaine station, combien de temps, vélos disponibles, naviguer, arrête.',
  }
};

export function useVoice({ lang = 'fr-FR' } = {}) {
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [lastCommand, setLastCommand] = useState(null);
  const [transcript, setTranscript] = useState('');
  const [supported, setSupported] = useState(true);
  
  const recognitionRef = useRef(null);
  const synthRef = useRef(null);

  // Initialiser Speech Recognition
  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    
    if (!SpeechRecognition) {
      setSupported(false);
      return;
    }

    recognitionRef.current = new SpeechRecognition();
    recognitionRef.current.continuous = true;
    recognitionRef.current.interimResults = true;
    recognitionRef.current.lang = lang;

    recognitionRef.current.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map(result => result[0])
        .map(result => result.transcript)
        .join('');
      
      setTranscript(transcript.toLowerCase());

      // Commande finale
      if (event.results[event.results.length - 1].isFinal) {
        processCommand(transcript.toLowerCase());
      }
    };

    recognitionRef.current.onerror = (event) => {
      console.error('Speech recognition error:', event.error);
      setIsListening(false);
    };

    recognitionRef.current.onend = () => {
      if (isListening) {
        recognitionRef.current.start(); // Redémarrer si on veut toujours écouter
      }
    };

    // Initialiser Speech Synthesis
    synthRef.current = window.speechSynthesis;

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
      if (synthRef.current) {
        synthRef.current.cancel();
      }
    };
  }, [lang, isListening]);

  // Traiter la commande
  const processCommand = useCallback((text) => {
    const commands = COMMANDS.fr;
    let matchedCommand = null;
    
    for (const [phrase, command] of Object.entries(commands)) {
      if (text.includes(phrase)) {
        matchedCommand = command;
        break;
      }
    }

    if (matchedCommand) {
      setLastCommand({ command: matchedCommand, text, timestamp: Date.now() });
    } else if (text.includes('aide') || text.includes('help')) {
      setLastCommand({ command: 'help', text, timestamp: Date.now() });
    }
  }, []);

  // Démarrer l'écoute
  const startListening = useCallback(() => {
    if (!recognitionRef.current || !supported) return;
    
    try {
      recognitionRef.current.start();
      setIsListening(true);
    } catch (e) {
      console.error('Failed to start recognition:', e);
    }
  }, [supported]);

  // Arrêter l'écoute
  const stopListening = useCallback(() => {
    if (!recognitionRef.current) return;
    
    recognitionRef.current.stop();
    setIsListening(false);
    setTranscript('');
  }, []);

  // Parler une réponse
  const speak = useCallback((text) => {
    if (!synthRef.current || !supported) return;

    // Annuler toute parole en cours
    synthRef.current.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.rate = 1.1;
    utterance.pitch = 1;

    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);

    synthRef.current.speak(utterance);
  }, [lang]);

  // Parler une réponse basée sur une commande
  const speakResponse = useCallback((commandType, data) => {
    const responses = RESPONSES.fr;
    let text;

    switch (commandType) {
      case 'next_station':
      case 'nearest_station':
        text = responses[commandType](data);
        break;
      case 'eta':
        text = responses.eta(data);
        break;
      case 'distance':
        text = responses.distance(data);
        break;
      case 'bikes':
        text = responses.bikes(data);
        break;
      case 'stop':
        text = responses.stop;
        break;
      case 'navigate':
        text = responses.navigate;
        break;
      case 'help':
        text = responses.help;
        break;
      default:
        text = responses.error;
    }

    speak(text);
    return text;
  }, [speak]);

  // Toggle écoute
  const toggleListening = useCallback(() => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }, [isListening, startListening, stopListening]);

  return {
    isListening,
    isSpeaking,
    transcript,
    lastCommand,
    supported,
    startListening,
    stopListening,
    toggleListening,
    speak,
    speakResponse,
  };
}
