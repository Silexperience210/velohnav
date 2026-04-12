import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Hook pour obtenir l'orientation réelle du téléphone
 * Gère les permissions iOS 13+ et la calibration
 */
export function useDeviceOrientation() {
  const [orientation, setOrientation] = useState({
    alpha: 0,    // 0-360 (rotation autour de Z - boussole)
    beta: 0,     // -180 to 180 (inclinaison avant/arrière)
    gamma: 0,    // -90 to 90 (inclinaison gauche/droite)
    absolute: false,
    calibrated: false
  });
  const [permission, setPermission] = useState('prompt'); // 'prompt' | 'granted' | 'denied'
  const [isSupported, setIsSupported] = useState(true);
  
  // Buffer pour lissage des données (moyenne glissante)
  const bufferRef = useRef([]);
  const BUFFER_SIZE = 5;

  // Lissage des données bruyantes du gyroscope
  const smoothOrientation = useCallback((newData) => {
    bufferRef.current.push(newData);
    if (bufferRef.current.length > BUFFER_SIZE) {
      bufferRef.current.shift();
    }
    
    // Moyenne des angles (attention au wrap-around pour alpha)
    const avg = bufferRef.current.reduce((acc, curr, idx, arr) => {
      if (idx === 0) return { ...curr };
      
      // Gestion spéciale pour alpha (0/360 wrap)
      let alphaDiff = curr.alpha - acc.alpha;
      if (alphaDiff > 180) alphaDiff -= 360;
      if (alphaDiff < -180) alphaDiff += 360;
      
      return {
        alpha: acc.alpha + alphaDiff / (idx + 1),
        beta: acc.beta + (curr.beta - acc.beta) / (idx + 1),
        gamma: acc.gamma + (curr.gamma - acc.gamma) / (idx + 1),
        absolute: curr.absolute
      };
    }, newData);
    
    // Normaliser alpha entre 0-360
    avg.alpha = ((avg.alpha % 360) + 360) % 360;
    
    return avg;
  }, []);

  // Demander permission (iOS 13+ requis)
  const requestPermission = useCallback(async () => {
    if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
      try {
        const response = await DeviceOrientationEvent.requestPermission();
        setPermission(response);
        return response === 'granted';
      } catch (e) {
        console.error('Orientation permission denied:', e);
        setPermission('denied');
        return false;
      }
    } else {
      // Android ou vieux iOS
      setPermission('granted');
      return true;
    }
  }, []);

  useEffect(() => {
    // Vérifier support
    if (!window.DeviceOrientationEvent) {
      setIsSupported(false);
      setPermission('denied');
      return;
    }

    const handleOrientation = (event) => {
      // iOS donne webkitCompassHeading directement (plus précis)
      const heading = event.webkitCompassHeading || event.alpha;
      
      const rawData = {
        alpha: heading !== null ? heading : (event.alpha || 0),
        beta: event.beta || 0,
        gamma: event.gamma || 0,
        absolute: event.absolute || false,
        calibrated: true
      };
      
      setOrientation(smoothOrientation(rawData));
    };

    window.addEventListener('deviceorientation', handleOrientation, true);
    
    // Auto-request sur Android
    if (typeof DeviceOrientationEvent?.requestPermission !== 'function') {
      setPermission('granted');
    }

    return () => {
      window.removeEventListener('deviceorientation', handleOrientation, true);
    };
  }, [smoothOrientation]);

  return {
    ...orientation,
    permission,
    isSupported,
    requestPermission
  };
}

/**
 * Calcule le bearing (azimut) entre deux points GPS
 * Retourne 0-360 degrés (0 = Nord, 90 = Est, 180 = Sud, 270 = Ouest)
 */
export function calculateBearing(lat1, lng1, lat2, lng2) {
  const toRad = deg => deg * Math.PI / 180;
  const toDeg = rad => rad * 180 / Math.PI;
  
  const dLng = toRad(lng2 - lng1);
  const lat1Rad = toRad(lat1);
  const lat2Rad = toRad(lat2);
  
  const y = Math.sin(dLng) * Math.cos(lat2Rad);
  const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) -
            Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLng);
  
  let bearing = toDeg(Math.atan2(y, x));
  bearing = ((bearing % 360) + 360) % 360;
  
  return bearing;
}

/**
 * Détermine si une station est dans le champ de vision
 * @param {number} stationBearing - Bearing vers la station
 * @param {number} deviceHeading - Orientation actuelle du téléphone
 * @param {number} fov - Field of view en degrés (default: 60)
 */
export function isInFOV(stationBearing, deviceHeading, fov = 60) {
  let diff = stationBearing - deviceHeading;
  
  // Normaliser entre -180 et 180
  while (diff > 180) diff -= 360;
  while (diff < -180) diff += 360;
  
  return Math.abs(diff) <= fov / 2;
}

/**
 * Convertit un bearing relatif en position X à l'écran
 * @param {number} bearing - Bearing vers la station
 * @param {number} heading - Orientation du téléphone
 * @param {number} screenWidth - Largeur écran en pixels
 * @param {number} fov - Field of view en degrés
 */
export function bearingToScreenX(bearing, heading, screenWidth, fov = 60) {
  let relativeAngle = bearing - heading;
  
  // Normaliser
  while (relativeAngle > 180) relativeAngle -= 360;
  while (relativeAngle < -180) relativeAngle += 360;
  
  // Mapper [-fov/2, fov/2] vers [0, screenWidth]
  const x = (relativeAngle + fov / 2) / fov * screenWidth;
  
  // Limiter aux bords avec marge
  return Math.max(-50, Math.min(screenWidth + 50, x));
}

/**
 * Calcule la distance verticale (hauteur) selon l'élévation
 * Pour l'instant simplifié - pourrait utiliser altitude si dispo
 */
export function calculateVerticalPosition(distance, beta, screenHeight) {
  // beta: inclinaison téléphone (-90 = vers le ciel, 90 = vers le sol)
  // Centre écran = horizon (beta = 0)
  const horizonY = screenHeight / 2;
  const pixelsPerDegree = screenHeight / 60; // 60 degrés FOV vertical approx
  
  // Compensation de l'inclinaison
  const offset = beta * pixelsPerDegree;
  
  return horizonY + offset;
}
