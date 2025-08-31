// full replacement: robust map + clickable markers and working sidebar toggle

// Basemap tile sources
const baseLayers = {
  'osm': new ol.layer.Tile({ source: new ol.source.OSM() }),
  'sat': new ol.layer.Tile({ source: new ol.source.XYZ({ url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}' }) }),
  'dark': new ol.layer.Tile({ source: new ol.source.XYZ({ url: 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png' }) })
};

console.log("[AE2] map.js running");

async function loadJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return res.json();
}

const ICONS = {
  station: 'assets/antenna.png',
  satellite: 'assets/satellite.png'
};

function makeFeatureStyle(feature, hover = false) {
  const props = feature.getProperties() || {};
  const type = props.type || (feature.getGeometry() instanceof ol.geom.LineString ? 'orbit' : (feature.getGeometry() instanceof ol.geom.Point ? (props.name === 'Observer' ? 'observer' : 'unknown') : 'unknown'));
  const hoverMul = hover ? 1.4 : 1.0;

  if (type === 'observer') {
    return new ol.style.Style({
      image: new ol.style.Circle({
        radius: 7 * hoverMul,
        fill: new ol.style.Fill({ color: 'green' }),
        stroke: new ol.style.Stroke({ color: '#fff', width: 1 })
      })
    });
  }

  if (type === 'station') {
    return new ol.style.Style({
      image: new ol.style.Icon({
        src: ICONS.station,
        scale: 0.08 * hoverMul,
        anchor: [0.5, 1],
        crossOrigin: 'anonymous'
      })
    });
  }

  if (type === 'satellite') {
    return new ol.style.Style({
      image: new ol.style.Icon({
        src: ICONS.satellite,
        scale: 0.06 * hoverMul,
        anchor: [0.5, 0.5],
        crossOrigin: 'anonymous'
      })
    });
  }

  if (type === 'orbit') {
    // Orbit: stroke plus a satellite icon at the first track coordinate (if available)
    const raw = props.raw || {};
    const track = Array.isArray(raw.track) ? raw.track : (Array.isArray(props.track) ? props.track : []);
    const coords = track.length && Array.isArray(track[0]) && typeof track[0][0] === 'number' && typeof track[0][1] === 'number'
      ? ol.proj.fromLonLat([track[0][1], track[0][0]])
      : null;

    const styles = [
      new ol.style.Style({
        stroke: new ol.style.Stroke({
          color: hover ? '#ffa500' : 'orange',
          width: hover ? 4 : 2,
          lineDash: null
        })
      })
    ];

    if (coords) {
      styles.push(new ol.style.Style({
        geometry: new ol.geom.Point(coords),
        image: new ol.style.Icon({
          src: ICONS.satellite,
          scale: 0.06 * hoverMul,
          anchor: [0.5, 0.5],
          crossOrigin: 'anonymous'
        })
      }));
    }

    return styles;
  }

  // fallback: small circle
  return new ol.style.Style({
    image: new ol.style.Circle({
      radius: 6 * hoverMul,
      fill: new ol.style.Fill({ color: 'gray' }),
      stroke: new ol.style.Stroke({ color: '#fff', width: 1 })
    })
  });
}

function createMarker(lon, lat, color, label, props = {}) {
  // validate coords
  if (typeof lon !== 'number' || typeof lat !== 'number') return null;
  const feature = new ol.Feature({
    geometry: new ol.geom.Point(ol.proj.fromLonLat([lon, lat])),
    name: label
  });
  feature.setProperties(Object.assign({}, props, { name: label }));
  feature.setStyle(new ol.style.Style({
    image: new ol.style.Circle({
      radius: 6,
      fill: new ol.style.Fill({ color }),
      stroke: new ol.style.Stroke({ color: '#fff', width: 1 })
    })
  }));
  return feature;
}



function createLine(track, color = 'orange', props = {}) {
  // track: array of [lat, lon] pairs (robust to invalid entries)
  const coords = [];
  for (const pt of (track || [])) {
    if (!Array.isArray(pt)) continue;
    const lat = pt[0], lon = pt[1];
    if (typeof lat === 'number' && typeof lon === 'number') {
      coords.push(ol.proj.fromLonLat([lon, lat]));
    }
  }
  if (!coords.length) return null;
  const feature = new ol.Feature({ geometry: new ol.geom.LineString(coords) });
  feature.setProperties(props);
  feature.setStyle(new ol.style.Style({ stroke: new ol.style.Stroke({ color, width: 2 }) }));
  return feature;
}

function addLayerFromFeatures(features) {
  const valid = features.filter(f => f !== null);
  const source = new ol.source.Vector({ features: valid });
  const layer = new ol.layer.Vector({ source });
  map.addLayer(layer);
  return layer;
}

const observerLocation = [107.6, -6.9];
let currentBaseLayer = baseLayers['osm'];
const map = new ol.Map({
  target: 'map',
  layers: [currentBaseLayer],
  view: new ol.View({ center: ol.proj.fromLonLat(observerLocation), zoom: 4 })
});

const observerFeature = createMarker(observerLocation[0], observerLocation[1], 'green', 'Observer', { type: 'observer', description: 'Observer location' });
if (observerFeature) addLayerFromFeatures([observerFeature]);

let stationLayer, satelliteLayer, orbitLayer;


async function initMapLayers() {
  try {
    const satnogs = await loadJSON('data/satnogs_results.json').catch(() => ({ stations: [] }));
    const sats = await loadJSON('data/tle_visible.json').catch(() => []);
    const orbits = await loadJSON('data/tle_orbits.json').catch(() => []);

    // ground stations
    const stationFeatures = (satnogs.stations || []).map(s => {
      const lon = Number(s.lon ?? s.lng), lat = Number(s.lat);
      return createMarker(lon, lat, 'blue', s.name || s.callsign || 'Station', {
        type: 'station',
        id: s.id ?? s.station_id ?? null,
        country: s.country ?? s.cc ?? null,
        elevation_m: s.elevation_m ?? s.elevation ?? null,
        raw: s
      });
    }).filter(Boolean);

    // visible satellites (tle_visible.json fields vary)
    const satFeatures = (sats || []).map(s => {
      // many of your sample entries only have longitude_deg — try to read good fields and skip invalid points
      const lon = Number(s.longitude_deg ?? s.lon ?? s.lng ?? s.longitude);
      const lat = Number(s.latitude_deg ?? s.lat ?? s.latitude);
      return createMarker(lon, lat, 'red', s.name || s.satname || 'Satellite', {
        type: 'satellite',
        id: s.id ?? s.sat_id ?? s.norad_cat_id ?? null,
        altitude_km: s.altitude_km ?? s.height_km ?? s.elevation_km ?? null,
        tle_line1: s.tle_line1 ?? s.tle1 ?? null,
        tle_line2: s.tle_line2 ?? s.tle2 ?? null,
        raw: s
      });
    }).filter(Boolean);

    // orbit lines
    const orbitFeatures = (orbits || []).map(o => createLine(o.track || o.path || [], 'orange', {
      type: 'orbit',
      name: o.name || o.id || 'Orbit',
      period_min: o.period_min ?? o.period ?? null,
      raw: o
    })).filter(Boolean);

    orbitLayer = addLayerFromFeatures(orbitFeatures);
    stationLayer = addLayerFromFeatures(stationFeatures);
    satelliteLayer = addLayerFromFeatures(satFeatures);

    // Fit view to features if any
    const allFeatures = [...stationFeatures, ...satFeatures];
    if (allFeatures.length) {
      const extent = ol.extent.createEmpty();
      allFeatures.forEach(f => ol.extent.extend(extent, f.getGeometry().getExtent()));
      map.getView().fit(extent, { padding: [50,50,50,50], maxZoom: 8 });
    }

    // toggles (guard for missing DOM)
    const ts = document.getElementById('toggle-stations');
    const tv = document.getElementById('toggle-satellites');
    const to = document.getElementById('toggle-orbits');
    if (ts && stationLayer) ts.addEventListener('change', e => stationLayer.setVisible(e.target.checked));
    if (tv && satelliteLayer) tv.addEventListener('change', e => satelliteLayer.setVisible(e.target.checked));
    if (to && orbitLayer) to.addEventListener('change', e => orbitLayer.setVisible(e.target.checked));

    console.log("[✱] Layers loaded:", stationFeatures.length, "stations;", satFeatures.length, "sats;", orbitFeatures.length, "orbits");
  } catch (err) {
    console.error("[ERROR] initMapLayers:", err);
  }
}

initMapLayers();

// live satellites updater (keeps separate layer)
let liveSatLayer, liveSatFeatures = [];
async function animateLiveSatellites() {
  try {
    const data = await loadJSON('data/tle_live.json');
    if (!data) return;
    if (!liveSatLayer) {
      liveSatFeatures = data.map(s => {
        const lon = Number(s.longitude ?? s.lon ?? s.lng);
        const lat = Number(s.latitude ?? s.lat);
        return createMarker(lon, lat, 'red', s.name || 'LiveSat', { type: 'satellite', raw: s, id: s.id ?? s.name });
      }).filter(Boolean);
      liveSatLayer = addLayerFromFeatures(liveSatFeatures);
    } else {
      data.forEach((sat, i) => {
        if (!liveSatFeatures[i]) return;
        const lon = Number(sat.longitude ?? sat.lon ?? sat.lng);
        const lat = Number(sat.latitude ?? sat.lat);
        if (typeof lon === 'number' && typeof lat === 'number') {
          liveSatFeatures[i].getGeometry().setCoordinates(ol.proj.fromLonLat([lon, lat]));
        }
        liveSatFeatures[i].setProperties(Object.assign({}, liveSatFeatures[i].getProperties(), { raw: sat }));
      });
    }
  } catch (err) {
    console.warn("[LIVE SATS] fetch failed:", err);
  }
}
setInterval(animateLiveSatellites, 5000);
animateLiveSatellites();

// basemap switcher
const basemapSelect = document.getElementById('basemap-switcher');
if (basemapSelect) {
  basemapSelect.addEventListener('change', (e) => {
    map.removeLayer(currentBaseLayer);
    currentBaseLayer = baseLayers[e.target.value] || baseLayers['osm'];
    map.getLayers().insertAt(0, currentBaseLayer);
  });
}


// -------------------------
// NDVI (keeps your existing code but defensive)
async function triggerNDVIGeneration() {
  console.log("[NDVI] Refreshing...");
  try {
    const redBand = "C:/Satcom Analyzer/frontend/public_map/assets/B04.tiff";
    const nirBand = "C:/Satcom Analyzer/frontend/public_map/assets/B08.tiff";
    const url = `http://localhost:5000/generate-ndvi?red_path=${encodeURIComponent(redBand)}&nir_path=${encodeURIComponent(nirBand)}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    if (window.ndviLayer) map.removeLayer(window.ndviLayer);
    window.ndviLayer = new ol.layer.Image({
      source: new ol.source.ImageStatic({
        url: data.ndvi_url,
        imageExtent: ol.proj.transformExtent([82.48, -23.55, 164.18, 15.39], 'EPSG:4326', map.getView().getProjection())
      }),
      opacity: 0.7
    });
    map.addLayer(window.ndviLayer);
    console.log("[NDVI] Layer added");
  } catch (err) {
    console.error("[NDVI] failed:", err);
  }
}

document.getElementById('refresh-ndvi')?.addEventListener('click', triggerNDVIGeneration);
triggerNDVIGeneration().catch(()=>{});

// -------------------------
// Viewer panels utility
function clearViewerPanels() {
  document.getElementById('satellite-info')?.style.setProperty('display','none');
  document.getElementById('ground-station-info')?.style.setProperty('display','none');
  document.getElementById('orbit-info')?.style.setProperty('display','none');
}

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function formatNum(v, dp=4){ return (typeof v === 'number') ? v.toFixed(dp) : (v===null||v===undefined?'—':String(v)); }

function readLatLon(props = {}) {
  const raw = props.raw || {};
  const latCandidates = [raw.latitude, raw.latitude_deg, raw.lat, raw.lat_deg, props.latitude, props.latitude_deg, props.lat, props.lat_deg];
  const lonCandidates = [raw.longitude, raw.longitude_deg, raw.lon, raw.lon_deg, raw.lng, raw.lng_deg, props.longitude, props.longitude_deg, props.lon, props.lon_deg, props.lng];
  const lat = latCandidates.find(v => typeof v === 'number');
  const lon = lonCandidates.find(v => typeof v === 'number');
  return { lat: lat ?? null, lon: lon ?? null };
}

function smallTableRow(k, v) {
  return `<tr><td style="vertical-align:top; padding:4px 8px; font-weight:600; color:#cfcfcf">${escapeHtml(k)}</td><td style="padding:4px 8px; color:#ddd">${v}</td></tr>`;
}

function showSatelliteInfo(props) {
  const el = document.getElementById('satellite-info');
  if (!el) return;
  el.style.display = 'block';
  const raw = props.raw || {};
  const id = props.id || raw.id || raw.norad_cat_id || raw.sat_id || '—';
  const name = props.name || raw.name || raw.satname || 'Unknown';
  const {lat, lon} = readLatLon(props);
  const altitude = props.altitude_km ?? raw.altitude_km ?? raw.height_km ?? raw.elevation_km ?? raw.distance_km ?? '—';
  const tle1 = props.tle_line1 || raw.tle_line1 || raw.tle1 || raw.line1 || '';
  const tle2 = props.tle_line2 || raw.tle_line2 || raw.tle2 || raw.line2 || '';
  const coordsHtml = (lat !== null && lon !== null) ? `${formatNum(lat,4)}°, ${formatNum(lon,4)}°` : '—';

  el.innerHTML = `
    <h4>Satellite Information</h4>
    <table style="width:100%; border-collapse:collapse;">
      ${smallTableRow('Name', escapeHtml(name))}
      ${smallTableRow('ID / NORAD', escapeHtml(id))}
      ${smallTableRow('Coordinates', coordsHtml)}
      ${smallTableRow('Altitude (km)', (typeof altitude === 'number')?altitude.toFixed(2):escapeHtml(String(altitude)))}
    </table>
    <h5 style="margin:6px 0 4px 0;">TLE / Orbit lines</h5>
    <pre style="white-space:pre-wrap; color:#ddd; background:#111; padding:6px; border-radius:4px; max-height:160px; overflow:auto;">${escapeHtml(tle1 ? tle1 + '\n' + (tle2 || '') : (raw.tle || 'N/A'))}</pre>
    <details style="color:#ddd; margin-top:8px;">
      <summary>Raw data (JSON)</summary>
      <pre style="white-space:pre-wrap; color:#ddd; background:#111; padding:6px; border-radius:4px; max-height:300px; overflow:auto;">${escapeHtml(JSON.stringify(raw, null, 2))}</pre>
    </details>
  `;
}

function showStationInfo(props) {
  const el = document.getElementById('ground-station-info');
  if (!el) return;
  el.style.display = 'block';
  const raw = props.raw || {};
  const name = props.name || raw.name || raw.callsign || 'Ground Station';
  const id = props.id || raw.id || raw.station_id || raw.callsign || '—';
  const country = props.country || raw.country || raw.cc || '—';
  const elevation = props.elevation_m ?? raw.elevation_m ?? raw.elevation ?? '—';
  const {lat, lon} = readLatLon(props);
  const coordsHtml = (lat !== null && lon !== null) ? `${formatNum(lat,4)}°, ${formatNum(lon,4)}° <a style="color:#6fb3ff; margin-left:6px;" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat + ',' + lon)}" target="_blank" rel="noreferrer">view</a>` : '—';

  el.innerHTML = `
    <h4>Ground Station Information</h4>
    <table style="width:100%; border-collapse:collapse; color:#ddd;">
      ${smallTableRow('Name', escapeHtml(name))}
      ${smallTableRow('Station ID', escapeHtml(id))}
      ${smallTableRow('Country', escapeHtml(country))}
      ${smallTableRow('Coordinates', coordsHtml)}
      ${smallTableRow('Elevation (m)', (typeof elevation === 'number')?elevation:escapeHtml(String(elevation)))}
    </table>
    <details style="color:#ddd; margin-top:8px;">
      <summary>Raw data (JSON)</summary>
      <pre style="white-space:pre-wrap; color:#ddd; background:#111; padding:6px; border-radius:4px; max-height:300px; overflow:auto;">${escapeHtml(JSON.stringify(raw, null, 2))}</pre>
    </details>
  `;
}

function showOrbitInfo(props) {
  const el = document.getElementById('orbit-info');
  if (!el) return;
  el.style.display = 'block';
  const raw = props.raw || {};
  const name = props.name || raw.name || 'Orbit';
  const period = props.period_min ?? raw.period_min ?? raw.period ?? '—';
  const track = Array.isArray(raw.track) ? raw.track : (Array.isArray(props.track) ? props.track : []);
  const pts = track.length;
  let bbox = '—';
  if (pts > 0) {
    const lats = track.map(pt => pt[0]).filter(v => typeof v === 'number');
    const lons = track.map(pt => pt[1]).filter(v => typeof v === 'number');
    if (lats.length && lons.length) {
      const minLat = Math.min(...lats), maxLat = Math.max(...lats);
      const minLon = Math.min(...lons), maxLon = Math.max(...lons);
      bbox = `${formatNum(minLat,3)}°, ${formatNum(minLon,3)}° → ${formatNum(maxLat,3)}°, ${formatNum(maxLon,3)}°`;
    }
  }

  el.innerHTML = `
    <h4>Orbit Information</h4>
    <table style="width:100%; border-collapse:collapse; color:#ddd;">
      ${smallTableRow('Name', escapeHtml(name))}
      ${smallTableRow('Approx. Period (min)', (typeof period === 'number')?period:escapeHtml(String(period)))}
      ${smallTableRow('Track Points', pts)}
      ${smallTableRow('Bounding Box', bbox)}
    </table>
    <details style="color:#ddd; margin-top:8px;">
      <summary>Raw data (JSON)</summary>
      <pre style="white-space:pre-wrap; color:#ddd; background:#111; padding:6px; border-radius:4px; max-height:400px; overflow:auto;">${escapeHtml(JSON.stringify(raw, null, 2))}</pre>
    </details>
  `;
}

// hide all on startup
clearViewerPanels();
document.getElementById('satellite-info')?.querySelector('#satellite-details')?.parentElement?.style?.display;
document.getElementById('satellite-info')?.style.setProperty('display','none');

// single-click handler (top feature only)
map.on('singleclick', function(evt) {
  const feature = map.forEachFeatureAtPixel(evt.pixel, f => f);
  if (!feature) { clearViewerPanels(); return; }
  const props = feature.getProperties();
  const type = props.type || (feature.getGeometry() instanceof ol.geom.LineString ? 'orbit' : (feature.getGeometry() instanceof ol.geom.Point ? (props.name === 'Observer' ? 'observer' : 'unknown') : 'unknown'));
  clearViewerPanels();
  if (type === 'satellite') showSatelliteInfo(props);
  else if (type === 'station' || type === 'ground_station') showStationInfo(props);
  else if (type === 'orbit') showOrbitInfo(props);
  else if (type === 'observer') {
    const el = document.getElementById('satellite-info');
    if (!el) return;
    el.style.display = 'block';
    el.innerHTML = `<h4>Observer</h4><p>${escapeHtml(props.description || 'Observer location')}</p><p><b>Coordinates:</b> ${formatNum(observerLocation[1],4)}, ${formatNum(observerLocation[0],4)}</p>`;
  } else {
    const el = document.getElementById('satellite-info');
    if (!el) return;
    el.style.display = 'block';
    el.innerHTML = `<h4>Feature</h4><pre style="white-space:pre-wrap; color:#ddd; background:#111; padding:6px; border-radius:4px;">${escapeHtml(JSON.stringify(props, null, 2))}</pre>`;
  }
});

// Sidebar toggle - guard for existence
const sidebarToggle = document.getElementById('toggle-sidebar');
sidebarToggle?.addEventListener('click', () => {
  const sidebar = document.getElementById('viewer-sidebar');
  if (!sidebar) return;
  sidebar.classList.toggle('collapsed');
  const isCollapsed = sidebar.classList.contains('collapsed');
  sidebarToggle.innerHTML = isCollapsed ? '➤' : '⮜';
  sidebar.style.zIndex = isCollapsed ? '1000' : '2000';
  sidebar.style.transform = isCollapsed ? 'translateX(0%)' : 'translateX(40%)';
  document.getElementById('map').style.width = isCollapsed ? '100%' : 'calc(100% - 300px)';
  document.getElementById('map').style.transition = 'width 0.3s ease';
  document.querySelector('.viewer-sidebar.collapsed')?.style.setProperty('transform', isCollapsed ? 'translateX(0%)' : 'translateX(40%)');
  document.querySelector('.viewer-sidebar.collapsed')?.style.setProperty('z-index', isCollapsed ? '1000' : '2000');
  

});


