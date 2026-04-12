import { useState, useEffect, useCallback } from 'react';

/**
 * Hook pour récupérer la météo en temps réel
 * Utilise Open-Meteo API (gratuit, pas de clé requise)
 */

const WEATHER_CODES = {
  0: { label: 'Clair', icon: '☀️', color: '#FDB813' },
  1: { label: 'Partiellement nuageux', icon: '⛅', color: '#FDB813' },
  2: { label: 'Nuageux', icon: '☁️', color: '#A0A0A0' },
  3: { label: 'Couvert', icon: '☁️', color: '#808080' },
  45: { label: 'Brouillard', icon: '🌫️', color: '#C0C0C0' },
  48: { label: 'Brouillard givrant', icon: '🌫️', color: '#E0E0E0' },
  51: { label: 'Bruine légère', icon: '🌦️', color: '#60A5FA' },
  53: { label: 'Bruine modérée', icon: '🌦️', color: '#3B82F6' },
  55: { label: 'Bruine dense', icon: '🌧️', color: '#2563EB' },
  61: { label: 'Pluie légère', icon: '🌧️', color: '#60A5FA' },
  63: { label: 'Pluie modérée', icon: '🌧️', color: '#3B82F6' },
  65: { label: 'Pluie forte', icon: '🌧️', color: '#1D4ED8' },
  71: { label: 'Neige légère', icon: '🌨️', color: '#E0E7FF' },
  73: { label: 'Neige modérée', icon: '🌨️', color: '#C7D2FE' },
  75: { label: 'Neige forte', icon: '❄️', color: '#A5B4FC' },
  95: { label: 'Orage', icon: '⛈️', color: '#7C3AED' },
  96: { label: 'Orage avec grêle', icon: '⛈️', color: '#6D28D9' },
};

export function useWeather() {
  const [weather, setWeather] = useState(null);
  const [forecast, setForecast] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchWeather = useCallback(async (lat, lng) => {
    if (!lat || !lng) return;
    
    setLoading(true);
    setError(null);
    
    try {
      // Open-Meteo API - gratuit sans clé
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,precipitation&hourly=weather_code,precipitation_probability&timezone=Europe/Luxembourg&forecast_days=2`;
      
      const res = await fetch(url);
      if (!res.ok) throw new Error('Weather API error');
      
      const data = await res.json();
      
      // Parser current weather
      const current = {
        temp: Math.round(data.current.temperature_2m),
        humidity: data.current.relative_humidity_2m,
        windSpeed: data.current.wind_speed_10m,
        precipitation: data.current.precipitation,
        code: data.current.weather_code,
        ...WEATHER_CODES[data.current.weather_code],
      };
      
      // Parser forecast (prochaines 24h)
      const hourlyForecast = data.hourly.time
        .slice(0, 24)
        .map((time, i) => ({
          time: new Date(time),
          code: data.hourly.weather_code[i],
          precipProb: data.hourly.precipitation_probability[i],
          ...WEATHER_CODES[data.hourly.weather_code[i]],
        }));
      
      setWeather(current);
      setForecast(hourlyForecast);
      
      return { current, forecast: hourlyForecast };
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  // Vérifier s'il va pleuvoir dans l'heure
  const willRainSoon = useCallback(() => {
    if (!forecast.length) return false;
    const nextHour = forecast.slice(0, 2);
    return nextHour.some(f => f.precipProb > 50 || [51,53,55,61,63,65,95,96].includes(f.code));
  }, [forecast]);

  // Recommandation pour le vélo
  const getBikeAdvice = useCallback(() => {
    if (!weather) return null;
    
    const { code, windSpeed, temp } = weather;
    
    // Pluie imminente
    if (willRainSoon()) {
      return {
        type: 'warning',
        icon: '⏰',
        title: 'Pluie dans 1h',
        message: 'Vite, récupère un vélo maintenant !',
        urgency: 'high',
      };
    }
    
    // Pluie actuelle
    if ([61,63,65,95,96].includes(code)) {
      return {
        type: 'danger',
        icon: '🌧️',
        title: 'Pluie forte',
        message: 'Attention routes glissantes, freine tôt.',
        urgency: 'high',
      };
    }
    
    // Vent fort
    if (windSpeed > 30) {
      return {
        type: 'warning',
        icon: '💨',
        title: 'Vent fort',
        message: 'Évite les grands axes dégagés.',
        urgency: 'medium',
      };
    }
    
    // Chaleur extrême
    if (temp > 30) {
      return {
        type: 'info',
        icon: '🌡️',
        title: 'Canicule',
        message: 'Hydrate-toi et prends des pauses.',
        urgency: 'low',
      };
    }
    
    // Froid
    if (temp < 0) {
      return {
        type: 'warning',
        icon: '🥶',
        title: 'Gel',
        message: 'Attention aux plaques de verglas !',
        urgency: 'high',
      };
    }
    
    // Conditions idéales
    if ([0, 1].includes(code) && temp > 15 && temp < 25 && windSpeed < 20) {
      return {
        type: 'success',
        icon: '🌟',
        title: 'Conditions parfaites',
        message: 'Profite bien de ta balade !',
        urgency: 'low',
      };
    }
    
    return null;
  }, [weather, willRainSoon]);

  return {
    weather,
    forecast,
    loading,
    error,
    fetchWeather,
    willRainSoon,
    getBikeAdvice,
    refresh: fetchWeather,
  };
}
