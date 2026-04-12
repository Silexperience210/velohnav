import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Hook pour les alertes géolocalisées (Geofencing)
 * Alerte l'utilisateur quand il entre dans une zone ou quand une condition est remplie
 */

const STORAGE_KEY = 'velohnav_alerts_v1';

export function useGeofencing() {
  const [alerts, setAlerts] = useState([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [lastNotification, setLastNotification] = useState(null);
  
  // Ref pour tracker les alertes déjà déclenchées (éviter spam)
  const triggeredRef = useRef(new Set());
  
  // Charger les alertes sauvegardées
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      setAlerts(JSON.parse(stored));
    }
    setIsLoaded(true);
  }, []);

  // Sauvegarder les alertes
  useEffect(() => {
    if (isLoaded) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(alerts));
    }
  }, [alerts, isLoaded]);

  // Ajouter une alerte
  const addAlert = useCallback((alertData) => {
    const newAlert = {
      id: Date.now().toString(),
      createdAt: Date.now(),
      active: true,
      triggered: false,
      ...alertData,
    };
    
    setAlerts(prev => [...prev, newAlert]);
    return newAlert.id;
  }, []);

  // Supprimer une alerte
  const removeAlert = useCallback((alertId) => {
    setAlerts(prev => prev.filter(a => a.id !== alertId));
    triggeredRef.current.delete(alertId);
  }, []);

  // Activer/désactiver une alerte
  const toggleAlert = useCallback((alertId) => {
    setAlerts(prev => prev.map(a => 
      a.id === alertId ? { ...a, active: !a.active, triggered: false } : a
    ));
    triggeredRef.current.delete(alertId);
  }, []);

  // Vérifier les alertes contre la position actuelle
  const checkAlerts = useCallback((userPos, stations, weather) => {
    if (!userPos || !stations.length) return [];

    const triggered = [];
    const now = Date.now();

    alerts.forEach(alert => {
      if (!alert.active || triggeredRef.current.has(alert.id)) return;

      let shouldTrigger = false;
      let message = '';

      switch (alert.type) {
        case 'station_available':
          // Alerte quand une station spécifique a des vélos
          const station = stations.find(s => s.id === alert.stationId);
          if (station && station.bikes >= alert.minBikes) {
            shouldTrigger = true;
            message = `🚲 ${station.name}: ${station.bikes} vélos disponibles !`;
          }
          break;

        case 'nearby_available':
          // Alerte quand on passe à côté d'une station avec vélos
          const nearby = stations.filter(s => s.dist < alert.radius && s.bikes > 0);
          if (nearby.length > 0) {
            shouldTrigger = true;
            const closest = nearby.sort((a, b) => a.dist - b.dist)[0];
            message = `📍 ${closest.name} à ${Math.round(closest.dist)}m: ${closest.bikes} vélos`;
          }
          break;

        case 'proximity':
          // Alerte quand on approche d'une destination
          if (alert.targetLat && alert.targetLng) {
            const dist = calculateDistance(
              userPos.lat, userPos.lng,
              alert.targetLat, alert.targetLng
            );
            if (dist < alert.radius) {
              shouldTrigger = true;
              message = `🎯 Tu approches de ${alert.targetName || 'ta destination'} !`;
            }
          }
          break;

        case 'weather':
          // Alerte météo
          if (weather && alert.weatherCondition) {
            const condition = checkWeatherCondition(weather, alert.weatherCondition);
            if (condition) {
              shouldTrigger = true;
              message = `⛅ Alerte météo: ${condition}`;
            }
          }
          break;

        case 'low_battery':
          // Alerte batterie (si on avait accès à l'API Battery)
          break;
      }

      if (shouldTrigger) {
        // Cooldown pour éviter spam (5 min par défaut)
        const cooldown = alert.cooldown || 5 * 60 * 1000;
        if (!alert.lastTriggered || (now - alert.lastTriggered > cooldown)) {
          triggered.push({ ...alert, message });
          triggeredRef.current.add(alert.id);
          
          // Mettre à jour l'alerte
          setAlerts(prev => prev.map(a => 
            a.id === alert.id 
              ? { ...a, triggered: true, lastTriggered: now }
              : a
          ));

          setLastNotification({
            id: alert.id,
            message,
            timestamp: now,
          });

          // Auto-reset après cooldown pour les alertes récurrentes
          if (alert.recurring) {
            setTimeout(() => {
              triggeredRef.current.delete(alert.id);
              setAlerts(prev => prev.map(a => 
                a.id === alert.id ? { ...a, triggered: false } : a
              ));
            }, cooldown);
          }
        }
      }
    });

    return triggered;
  }, [alerts]);

  // Créer des alertes prédéfinies
  const createQuickAlert = useCallback((type, data) => {
    const templates = {
      station_available: {
        type: 'station_available',
        title: 'Station disponible',
        minBikes: 1,
        cooldown: 60000, // 1 min
        recurring: true,
      },
      nearby_bike: {
        type: 'nearby_available',
        title: 'Vélo à proximité',
        radius: 100, // 100m
        cooldown: 30000, // 30s
        recurring: true,
      },
      rain_coming: {
        type: 'weather',
        title: 'Pluie imminente',
        weatherCondition: 'rain',
        cooldown: 600000, // 10 min
        recurring: false,
      },
    };

    const template = templates[type];
    if (!template) return null;

    return addAlert({ ...template, ...data });
  }, [addAlert]);

  // Effacer toutes les notifications
  const clearNotifications = useCallback(() => {
    setLastNotification(null);
  }, []);

  return {
    alerts,
    lastNotification,
    isLoaded,
    addAlert,
    removeAlert,
    toggleAlert,
    checkAlerts,
    createQuickAlert,
    clearNotifications,
  };
}

// Calculer distance entre deux points (Haversine)
function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371e3; // Rayon terre en mètres
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

// Vérifier condition météo
function checkWeatherCondition(weather, condition) {
  switch (condition) {
    case 'rain':
      return weather.precipitation > 0 || [51, 53, 55, 61, 63, 65, 95, 96].includes(weather.code);
    case 'clear':
      return [0, 1].includes(weather.code);
    case 'wind':
      return weather.windSpeed > 30;
    case 'cold':
      return weather.temp < 5;
    default:
      return false;
  }
}
