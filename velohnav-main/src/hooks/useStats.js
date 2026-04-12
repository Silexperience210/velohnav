import { useState, useEffect, useCallback, useMemo } from 'react';

/**
 * Hook pour les statistiques utilisateur et badges
 * Stockage persistant dans localStorage
 */

const STORAGE_KEY = 'velohnav_stats_v1';

const BADGES = [
  {
    id: 'first_ride',
    name: 'Premier Pas',
    description: 'Effectue ton premier trajet',
    icon: '🚲',
    condition: (stats) => stats.totalRides >= 1,
  },
  {
    id: 'regular',
    name: 'Habitué',
    description: '10 trajets effectués',
    icon: '📅',
    condition: (stats) => stats.totalRides >= 10,
  },
  {
    id: 'centurion',
    name: 'Centurion',
    description: '100 trajets effectués',
    icon: '💯',
    condition: (stats) => stats.totalRides >= 100,
  },
  {
    id: 'marathon_week',
    name: 'Marathon Hebdo',
    description: '50km en une semaine',
    icon: '🏃',
    condition: (stats) => stats.weeklyDistance >= 50000,
  },
  {
    id: 'eco_warrior',
    name: 'Eco-Warrior',
    description: 'Évite 100kg de CO₂',
    icon: '🌍',
    condition: (stats) => stats.totalCO2Saved >= 100,
  },
  {
    id: 'streak_7',
    name: 'Semaine Parfaite',
    description: '7 jours de suite à vélo',
    icon: '🔥',
    condition: (stats) => stats.maxStreak >= 7,
  },
  {
    id: 'streak_30',
    name: 'Mois d\'Enfer',
    description: '30 jours de suite à vélo',
    icon: '🐉',
    condition: (stats) => stats.maxStreak >= 30,
  },
  {
    id: 'night_rider',
    name: 'Night Rider',
    description: '10 trajets de nuit',
    icon: '🌙',
    condition: (stats) => stats.nightRides >= 10,
  },
  {
    id: 'rain_warrior',
    name: 'Guerrier de la Pluie',
    description: '5 trajets sous la pluie',
    icon: '🌧️',
    condition: (stats) => stats.rainRides >= 5,
  },
  {
    id: 'speed_demon',
    name: 'Démon de Vitesse',
    description: 'Dépasse 30km/h de moyenne',
    icon: '⚡',
    condition: (stats) => stats.maxSpeed >= 30,
  },
  {
    id: 'explorer',
    name: 'Explorateur',
    description: 'Utilise 10 stations différentes',
    icon: '🧭',
    condition: (stats) => stats.uniqueStations.size >= 10,
  },
  {
    id: 'saver',
    name: 'Économe',
    description: 'Économise 100€ sur tes trajets',
    icon: '💰',
    condition: (stats) => stats.totalMoneySaved >= 100,
  },
];

// CO2 estimé: 120g/km en voiture vs 0 vélo = 0.12kg/km économisé
// Coût: 2€/trajet en bus/voiture estimé
const CO2_PER_KM = 0.12;
const MONEY_PER_RIDE = 2;
const CALORIES_PER_KM = 25;

function getWeekStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d.getTime();
}

function isNightTime(date = new Date()) {
  const hour = date.getHours();
  return hour < 6 || hour > 22;
}

export function useStats() {
  const [stats, setStats] = useState(null);
  const [isLoaded, setIsLoaded] = useState(false);

  // Charger depuis localStorage
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      // Restaurer le Set
      parsed.uniqueStations = new Set(parsed.uniqueStations || []);
      setStats(parsed);
    } else {
      setStats({
        totalRides: 0,
        totalDistance: 0,
        totalDuration: 0,
        totalCO2Saved: 0,
        totalMoneySaved: 0,
        totalCalories: 0,
        currentStreak: 0,
        maxStreak: 0,
        lastRideDate: null,
        weeklyDistance: 0,
        weekStart: getWeekStart(),
        nightRides: 0,
        rainRides: 0,
        maxSpeed: 0,
        uniqueStations: new Set(),
        badges: [],
        rideHistory: [],
      });
    }
    setIsLoaded(true);
  }, []);

  // Sauvegarder dans localStorage
  useEffect(() => {
    if (stats && isLoaded) {
      const toStore = {
        ...stats,
        uniqueStations: Array.from(stats.uniqueStations),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
    }
  }, [stats, isLoaded]);

  // Vérifier les badges débloqués
  const unlockedBadges = useMemo(() => {
    if (!stats) return [];
    return BADGES.filter(badge => {
      const alreadyHas = stats.badges.includes(badge.id);
      const shouldHave = badge.condition(stats);
      return shouldHave && !alreadyHas;
    });
  }, [stats]);

  // Ajouter un trajet
  const addRide = useCallback((rideData) => {
    setStats(prev => {
      if (!prev) return prev;

      const now = Date.now();
      const today = new Date().setHours(0, 0, 0, 0);
      const lastRide = prev.lastRideDate;
      
      // Calcul du streak
      let newStreak = prev.currentStreak;
      if (lastRide) {
        const lastRideDay = new Date(lastRide).setHours(0, 0, 0, 0);
        const dayDiff = (today - lastRideDay) / (1000 * 60 * 60 * 24);
        
        if (dayDiff === 0) {
          // Même jour, streak inchangé
        } else if (dayDiff === 1) {
          // Jour suivant, streak +
          newStreak++;
        } else {
          // Streak cassé
          newStreak = 1;
        }
      } else {
        newStreak = 1;
      }

      // Reset weekly distance si nouvelle semaine
      let weeklyDistance = prev.weeklyDistance;
      if (now > prev.weekStart + 7 * 24 * 60 * 60 * 1000) {
        weeklyDistance = 0;
      }

      const newUniqueStations = new Set(prev.uniqueStations);
      if (rideData.stationId) {
        newUniqueStations.add(rideData.stationId);
      }

      const newStats = {
        ...prev,
        totalRides: prev.totalRides + 1,
        totalDistance: prev.totalDistance + (rideData.distance || 0),
        totalDuration: prev.totalDuration + (rideData.duration || 0),
        totalCO2Saved: prev.totalCO2Saved + ((rideData.distance || 0) / 1000) * CO2_PER_KM,
        totalMoneySaved: prev.totalMoneySaved + MONEY_PER_RIDE,
        totalCalories: prev.totalCalories + ((rideData.distance || 0) / 1000) * CALORIES_PER_KM,
        currentStreak: newStreak,
        maxStreak: Math.max(prev.maxStreak, newStreak),
        lastRideDate: now,
        weeklyDistance: weeklyDistance + (rideData.distance || 0),
        weekStart: prev.weekStart,
        nightRides: prev.nightRides + (isNightTime() || rideData.isNight ? 1 : 0),
        rainRides: prev.rainRides + (rideData.isRain ? 1 : 0),
        maxSpeed: Math.max(prev.maxSpeed, rideData.maxSpeed || 0),
        uniqueStations: newUniqueStations,
        badges: [...prev.badges, ...unlockedBadges.map(b => b.id)],
        rideHistory: [
          ...prev.rideHistory,
          {
            id: now,
            date: now,
            distance: rideData.distance || 0,
            duration: rideData.duration || 0,
            stationId: rideData.stationId,
            stationName: rideData.stationName,
          },
        ].slice(-100), // Garder seulement les 100 derniers
      };

      return newStats;
    });
  }, [unlockedBadges]);

  // Calculer les stats de la semaine
  const weeklyStats = useMemo(() => {
    if (!stats) return null;
    const weekRides = stats.rideHistory.filter(r => r.date >= stats.weekStart);
    return {
      rides: weekRides.length,
      distance: weekRides.reduce((acc, r) => acc + r.distance, 0),
      duration: weekRides.reduce((acc, r) => acc + r.duration, 0),
    };
  }, [stats]);

  // Formater les nombres
  const formatted = useMemo(() => {
    if (!stats) return null;
    return {
      totalRides: stats.totalRides,
      totalDistanceKm: (stats.totalDistance / 1000).toFixed(1),
      totalCO2SavedKg: stats.totalCO2Saved.toFixed(1),
      totalMoneySaved: Math.round(stats.totalMoneySaved),
      totalCalories: Math.round(stats.totalCalories),
      currentStreak: stats.currentStreak,
      maxStreak: stats.maxStreak,
      uniqueStations: stats.uniqueStations.size,
    };
  }, [stats]);

  // Obtenir tous les badges avec statut
  const allBadges = useMemo(() => {
    if (!stats) return [];
    return BADGES.map(badge => ({
      ...badge,
      unlocked: stats.badges.includes(badge.id),
      progress: badge.condition(stats) ? 100 : calculateProgress(stats, badge),
    }));
  }, [stats]);

  return {
    stats,
    formatted,
    isLoaded,
    addRide,
    unlockedBadges,
    allBadges,
    weeklyStats,
  };
}

// Calculer la progression vers un badge
function calculateProgress(stats, badge) {
  switch (badge.id) {
    case 'first_ride':
      return Math.min(100, (stats.totalRides / 1) * 100);
    case 'regular':
      return Math.min(100, (stats.totalRides / 10) * 100);
    case 'centurion':
      return Math.min(100, (stats.totalRides / 100) * 100);
    case 'marathon_week':
      return Math.min(100, (stats.weeklyDistance / 50000) * 100);
    case 'eco_warrior':
      return Math.min(100, (stats.totalCO2Saved / 100) * 100);
    case 'streak_7':
      return Math.min(100, (stats.maxStreak / 7) * 100);
    case 'streak_30':
      return Math.min(100, (stats.maxStreak / 30) * 100);
    case 'night_rider':
      return Math.min(100, (stats.nightRides / 10) * 100);
    case 'rain_warrior':
      return Math.min(100, (stats.rainRides / 5) * 100);
    case 'speed_demon':
      return stats.maxSpeed > 0 ? Math.min(100, (stats.maxSpeed / 30) * 100) : 0;
    case 'explorer':
      return Math.min(100, (stats.uniqueStations.size / 10) * 100);
    case 'saver':
      return Math.min(100, (stats.totalMoneySaved / 100) * 100);
    default:
      return 0;
  }
}
