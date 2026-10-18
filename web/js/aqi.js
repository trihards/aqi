// US EPA AQI categories. Colors are a slightly muted take on the EPA hues;
// category is always also given as text, never by color alone.
export const CATS = [
  { lo: 0,   hi: 50,  key: 'good',      label: 'Good',                           short: 'Good',      hex: '#3f9f4a' },
  { lo: 51,  hi: 100, key: 'moderate',  label: 'Moderate',                       short: 'Moderate',  hex: '#d9b526' },
  { lo: 101, hi: 150, key: 'usg',       label: 'Unhealthy for Sensitive Groups', short: 'USG',       hex: '#e7832b' },
  { lo: 151, hi: 200, key: 'unhealthy', label: 'Unhealthy',                      short: 'Unhealthy', hex: '#d2412f' },
  { lo: 201, hi: 300, key: 'very',      label: 'Very Unhealthy',                 short: 'Very Unh.', hex: '#8c4a99' },
  { lo: 301, hi: 500, key: 'hazardous', label: 'Hazardous',                      short: 'Hazardous', hex: '#7b2036' },
];

export function category(aqi) {
  if (aqi == null || !Number.isFinite(aqi)) return null;
  const v = Math.round(aqi);
  return CATS.find(c => v <= c.hi) || CATS[CATS.length - 1];
}

export const catHex = aqi => category(aqi)?.hex ?? '#8a8d90';

// Open-Meteo variable names. Concentrations are all µg/m³ in that API.
export const POLLUTANTS = [
  { key: 'pm2_5',            aqiKey: 'us_aqi_pm2_5',            label: 'PM2.5', name: 'Fine particles' },
  { key: 'ozone',            aqiKey: 'us_aqi_ozone',            label: 'O₃',    name: 'Ozone' },
  { key: 'pm10',             aqiKey: 'us_aqi_pm10',             label: 'PM10',  name: 'Coarse particles' },
  { key: 'nitrogen_dioxide', aqiKey: 'us_aqi_nitrogen_dioxide', label: 'NO₂',   name: 'Nitrogen dioxide' },
  { key: 'carbon_monoxide',  aqiKey: 'us_aqi_carbon_monoxide',  label: 'CO',    name: 'Carbon monoxide' },
  { key: 'sulphur_dioxide',  aqiKey: 'us_aqi_sulphur_dioxide',  label: 'SO₂',   name: 'Sulfur dioxide' },
];

// Position on the calibrated meter: each category gets an equal-width segment,
// the way EPA draws its scale. Returns 0..1.
export function scalePos(aqi) {
  if (aqi == null) return null;
  const v = Math.max(0, Math.min(500, aqi));
  const i = CATS.findIndex(c => v <= c.hi);
  const c = CATS[i];
  const lo = i === 0 ? 0 : CATS[i - 1].hi;
  return (i + (v - lo) / (c.hi - lo)) / CATS.length;
}
