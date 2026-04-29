// ══════════════════════════════════════════════════════════════════════════
// Trier Digital Twin — app.js
// All API calls go to Flask (/api/...) — never directly to external services
// ══════════════════════════════════════════════════════════════════════════

"use strict";

const API = window.API_BASE || "";
const TRIER = { lat: 49.7596, lon: 6.6441 };

// ── Cesium viewer setup ────────────────────────────────────────────────────
Cesium.Ion.defaultAccessToken = window.CESIUM_TOKEN;

// Create viewer without terrain first (terrain added async for Cesium 1.114+)
const viewer = new Cesium.Viewer("cesiumContainer", {
  terrain: Cesium.Terrain.fromWorldTerrain(),
  animation: false,
  baseLayerPicker: false,
  fullscreenButton: false,
  vrButton: false,
  geocoder: false,
  homeButton: false,
  infoBox: false,
  sceneModePicker: false,
  selectionIndicator: false,
  timeline: false,
  navigationHelpButton: false,
  orderIndependentTranslucency: false,
});

viewer.scene.globe.enableLighting = true;
viewer.scene.globe.atmosphereHueShift = 0.0;
viewer.scene.globe.atmosphereSaturationShift = -0.1;
viewer.scene.globe.atmosphereBrightnessShift = -0.1;
viewer.scene.backgroundColor = Cesium.Color.fromCssColorString("#070608");
viewer.scene.globe.baseColor   = Cesium.Color.fromCssColorString("#1a1510");


// ── Layer state ────────────────────────────────────────────────────────────
const layerSources  = {};   // name → Cesium DataSource
const layerVisible  = { fort: true, historic: true, housing: true, roads: true, buildings: true };
let   buildingPrimitive = null;


// ══════════════════════════════════════════════════════════════════════════
// LAYER LOADING — fetch from Flask, display in Cesium
// ══════════════════════════════════════════════════════════════════════════

const LAYER_STYLES = {
  fort:     { stroke: Cesium.Color.fromCssColorString("#c0504a"), fill: Cesium.Color.fromCssColorString("#c0504a").withAlpha(0.15), strokeWidth: 2 },
  historic: { stroke: Cesium.Color.fromCssColorString("#d4b483"), fill: Cesium.Color.fromCssColorString("#d4b483").withAlpha(0.15), strokeWidth: 2 },
  housing:  { stroke: Cesium.Color.fromCssColorString("#4a7fb5"), fill: Cesium.Color.fromCssColorString("#4a7fb5").withAlpha(0.1),  strokeWidth: 1 },
  roads:    { stroke: Cesium.Color.fromCssColorString("#5a9e6f"), fill: Cesium.Color.fromCssColorString("#5a9e6f").withAlpha(0.2),  strokeWidth: 1.5 },
};

const LAYER_FILES = {
  fort:     "fort_trier",
  historic: "historic_trier",
  housing:  "housing_trier",
  roads:    "roads_trier",
};

async function loadGeoJsonLayer(name) {
  if (layerSources[name]) return;
  try {
    const file = LAYER_FILES[name];
    const dataSource = await Cesium.GeoJsonDataSource.load(
      `${API}/api/layers/${file}`,
      LAYER_STYLES[name] || {}
    );
    viewer.dataSources.add(dataSource);
    layerSources[name] = dataSource;
    showToast(`✓ ${name} layer loaded`);
    updateFeatureCount();
  } catch (e) {
    console.error(`[layer] Failed to load ${name}:`, e);
    showToast(`⚠ ${name} layer failed`);
  }
}

function toggleLayer(name) {
  layerVisible[name] = !layerVisible[name];
  const tog = document.getElementById(`tog-${name}`);
  if (tog) tog.classList.toggle("on", layerVisible[name]);

  if (name === "buildings") {
    if (buildingPrimitive) buildingPrimitive.show = layerVisible[name];
    return;
  }
  if (layerSources[name]) {
    layerSources[name].show = layerVisible[name];
  }
}

function updateFeatureCount() {
  let count = 0;
  Object.values(layerSources).forEach(ds => { count += ds.entities.values.length; });
  document.getElementById("featureCount").textContent = `Features: ${count.toLocaleString("de-DE")}`;
}

// Load 3D buildings from Flask
async function loadBuildings() {
  try {
    const res  = await fetch(`${API}/api/buildings`);
    const data = await res.json();
    setPill("pill-buildings", "ok");

    if (data.type === "FeatureCollection") {
      // GeoJSON buildings → Cesium extrusion
      const ds = await Cesium.GeoJsonDataSource.load(data, {
        stroke: Cesium.Color.fromCssColorString("#b87333").withAlpha(0.6),
        fill:   Cesium.Color.fromCssColorString("#b87333").withAlpha(0.25),
        strokeWidth: 1,
        clampToGround: false,
      });
      // Give buildings height based on properties
      ds.entities.values.forEach(entity => {
        const h = entity.properties?.height_m?.getValue() || 
                  entity.properties?.["building:levels"]?.getValue() * 3 || 8;
        if (entity.polygon) {
          entity.polygon.extrudedHeight = h;
          entity.polygon.height = 0;
          entity.polygon.material = Cesium.Color.fromCssColorString("#b87333").withAlpha(0.4);
          entity.polygon.outline = true;
          entity.polygon.outlineColor = Cesium.Color.fromCssColorString("#d4b483").withAlpha(0.6);
        }
      });
      viewer.dataSources.add(ds);
      layerSources["buildings"] = ds;
      showToast(`✓ ${ds.entities.values.length} buildings loaded`);
      updateFeatureCount();
    } else {
      // OSM raw format — parse nodes and ways
      showToast("⚠ Buildings: using OSM fallback");
    }
  } catch (e) {
    console.error("[buildings] Error:", e);
    setPill("pill-buildings", "err");
  }
}


// ══════════════════════════════════════════════════════════════════════════
// ERA SLIDER
// ══════════════════════════════════════════════════════════════════════════

const ERA_MAP = [
  [100,  "Early Roman Imperial (c. 100 AD)"],
  [200,  "High Roman Period (c. 200 AD)"],
  [300,  "Late Roman / Capital Era (c. 300 AD)"],
  [400,  "Late Antiquity (c. 400 AD)"],
  [800,  "Carolingian Period (c. 800 AD)"],
  [1200, "Medieval (c. 1200 AD)"],
  [1500, "Early Modern (c. 1500 AD)"],
  [1800, "Prussian Era (c. 1800 AD)"],
  [1945, "Post-WWII (1945)"],
  [2000, "Contemporary (2000)"],
  [2024, "Present Day (2024)"],
];

function updateEraSlider(v) {
  const val = parseInt(v);
  let label = ERA_MAP[ERA_MAP.length - 1][1];
  for (const [y, l] of ERA_MAP) { if (val <= y) { label = l; break; } }
  document.getElementById("eraLabel").textContent = label;
  document.getElementById("eraBottomLabel").textContent = `Period: ${label}`;

  // Adjust atmosphere for era feel (Cesium 1.114+ uses skyAtmosphere)
  const t = Math.min(1, (val - 100) / 1924);
  if (viewer.scene.skyAtmosphere) {
    viewer.scene.skyAtmosphere.hueShift = 0.0;
    viewer.scene.skyAtmosphere.saturationShift = -0.1 + t * 0.1;
  }

  // Filter historic sites visibility by era
  filterHistoricByEra(val);
}

function setEra(era) {
  document.getElementById("btn-roman").classList.toggle("active", era === "roman");
  document.getElementById("btn-modern").classList.toggle("active", era === "modern");
  const sl = document.getElementById("eraSlider");
  sl.value = era === "roman" ? 300 : 2024;
  updateEraSlider(sl.value);
}

function filterHistoricByEra(year) {
  if (!layerSources["historic"]) return;
  layerSources["historic"].entities.values.forEach(e => {
    const start = e.properties?.era_start?.getValue() || 0;
    const end   = e.properties?.era_end?.getValue()   || 2100;
    e.show = year >= start && year <= end + 200;
  });
}


// ══════════════════════════════════════════════════════════════════════════
// BASEMAP
// ══════════════════════════════════════════════════════════════════════════

function setBasemap(type) {
  viewer.imageryLayers.removeAll();
  if (type === "terrain") {
    viewer.imageryLayers.add(new Cesium.ImageryLayer(new Cesium.IonImageryProvider({ assetId: 3812 })));
  } else if (type === "dark") {
    const layer = new Cesium.ImageryLayer(new Cesium.IonImageryProvider({ assetId: 2 }));
    layer.brightness = 0.3;
    layer.contrast   = 1.2;
    layer.saturation = 0;
    viewer.imageryLayers.add(layer);
  } else {
    viewer.imageryLayers.add(new Cesium.ImageryLayer(new Cesium.IonImageryProvider({ assetId: 2 })));
  }
  showToast(`Basemap: ${type}`);
}


// ══════════════════════════════════════════════════════════════════════════
// FLY TO
// ══════════════════════════════════════════════════════════════════════════

function flyTo(lon, lat, alt, name) {
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, alt),
    orientation: { heading: Cesium.Math.toRadians(0), pitch: Cesium.Math.toRadians(-45), roll: 0 },
    duration: 2,
  });
  showToast(`→ ${name}`);
}


// ══════════════════════════════════════════════════════════════════════════
// FEATURE CLICK INSPECTOR
// ══════════════════════════════════════════════════════════════════════════

viewer.screenSpaceEventHandler.setInputAction(evt => {
  const picked = viewer.scene.pick(evt.position);
  if (!Cesium.defined(picked) || !picked.id?.properties) {
    document.getElementById("infoPopup").style.display = "none";
    return;
  }
  const props = picked.id.properties;
  const title = (
    props.name        ||
    props.Road_Name   ||
    props.site_type   ||
    props.building    ||
    props.historic    ||
    { getValue: () => "Feature" }
  ).getValue();

  let rows = "";
  props.propertyNames.forEach(k => {
    try {
      const v = props[k].getValue();
      if (v != null && v !== "") rows += `<tr><td>${k}</td><td>${v}</td></tr>`;
    } catch (_) {}
  });

  document.getElementById("popupTitle").textContent = title;
  document.getElementById("popupTable").innerHTML = rows || "<tr><td colspan=2>No properties</td></tr>";

  // If it's a historic site, show description prominently
  const desc = props.description?.getValue();
  const popupHistoric = document.getElementById("popupHistoric");
  if (desc) {
    popupHistoric.textContent = desc;
    popupHistoric.style.display = "block";
  } else {
    popupHistoric.style.display = "none";
  }

  document.getElementById("infoPopup").style.display = "block";
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

// Camera coordinate display
viewer.scene.postRender.addEventListener(() => {
  const pos = viewer.camera.positionCartographic;
  if (pos) {
    document.getElementById("coordDisplay").textContent =
      `Lat: ${Cesium.Math.toDegrees(pos.latitude).toFixed(4)} · Lon: ${Cesium.Math.toDegrees(pos.longitude).toFixed(4)}`;
    document.getElementById("altDisplay").textContent = `Alt: ${Math.round(pos.height)}m`;
  }
});


// ══════════════════════════════════════════════════════════════════════════
// WEATHER — from Flask
// ══════════════════════════════════════════════════════════════════════════

const OWM_ICONS = {
  "01d":"☀️","01n":"🌙","02d":"⛅","02n":"⛅","03d":"☁️","03n":"☁️",
  "04d":"☁️","04n":"☁️","09d":"🌧️","09n":"🌧️","10d":"🌦️","10n":"🌦️",
  "11d":"⛈️","11n":"⛈️","13d":"❄️","13n":"❄️","50d":"🌫️","50n":"🌫️",
};
const WIND_DIRS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
const degToDir = deg => WIND_DIRS[Math.round(deg / 22.5) % 16];

async function fetchWeather() {
  try {
    const res  = await fetch(`${API}/api/weather`);
    const data = await res.json();
    const c    = data.current;

    const icon = OWM_ICONS[c.icon] || "🌡️";
    document.getElementById("w-main-card").innerHTML = `
      <div style="font-size:2rem">${icon}</div>
      <div class="weather-desc">${c.description}</div>
      <div class="wval" style="font-size:1.6rem;margin-top:4px">${c.temp}°C</div>
    `;
    document.getElementById("w-temp").textContent     = `${c.temp}°C`;
    document.getElementById("w-feels").textContent    = `Feels ${c.feels_like}°C`;
    document.getElementById("w-humidity").textContent = `${c.humidity}%`;
    document.getElementById("w-wind").textContent     = `${c.wind_speed}`;
    document.getElementById("w-dir").textContent      = degToDir(c.wind_deg);
    document.getElementById("w-pressure").textContent = c.pressure;
    document.getElementById("w-vis").textContent      = `${(c.visibility / 1000).toFixed(1)}`;
    document.getElementById("w-updated").textContent  =
      `${data.source === "owm" ? "OpenWeatherMap" : "Open-Meteo"} · ${new Date().toLocaleTimeString("de-DE")}`;

    setPill("pill-weather", "ok");

    // Forecast strip
    const strip = document.getElementById("forecastStrip");
    strip.innerHTML = (data.forecast || []).map(f => {
      const d = new Date(f.date);
      const label = d.toLocaleDateString("de-DE", { weekday: "short" });
      return `<div class="fc-day">
        <div class="fc-label">${label}</div>
        <div class="fc-icon">${OWM_ICONS[f.icon] || "🌡️"}</div>
        <div class="fc-temp">${f.temp_max}°</div>
        <div class="fc-low">${f.temp_min}°</div>
      </div>`;
    }).join("");

  } catch (e) {
    console.error("[weather]", e);
    setPill("pill-weather", "err");
  }
}


// ══════════════════════════════════════════════════════════════════════════
// TRAFFIC — from Flask
// ══════════════════════════════════════════════════════════════════════════

async function fetchTraffic() {
  try {
    const res  = await fetch(`${API}/api/traffic`);
    const data = await res.json();

    const pct = Math.min(93, Math.max(5, Math.round(data.congestion * 100)));
    document.getElementById("trafficNeedle").style.left = `${pct}%`;

    const col = data.congestion < 0.2 ? "#5a9e6f" : data.congestion < 0.5 ? "#c8a020" : "#c0504a";
    const el = document.getElementById("traffic-status");
    el.textContent  = data.status;
    el.style.color  = col;

    // Per-road breakdown (simulated as proportions)
    [["t-main", 0.9], ["t-centre", 1.1], ["t-auto", 0.7]].forEach(([id, factor]) => {
      const v = data.congestion * factor;
      const s = v < 0.2 ? "Free" : v < 0.5 ? "Moderate" : "Heavy";
      const c = v < 0.2 ? "#5a9e6f" : v < 0.5 ? "#c8a020" : "#c0504a";
      const elr = document.getElementById(id);
      elr.textContent = s; elr.style.color = c;
    });

    // Incidents
    const catColors = { 0: "#5a9e6f", 1: "#c8a020", 2: "#c8a020", 3: "#c0504a", 4: "#c0504a" };
    const incidentList = document.getElementById("incidentList");
    if (data.incidents && data.incidents.length > 0) {
      incidentList.innerHTML = data.incidents.map(i => `
        <div class="incident-item">
          <div class="inc-dot" style="background:${catColors[i.magnitude] || "#c8a020"}"></div>
          <div class="inc-text">${i.description}
            <div class="inc-type">${i.delay > 0 ? `+${Math.round(i.delay / 60)}min` : "Low impact"}</div>
          </div>
        </div>`).join("");
    } else {
      incidentList.innerHTML = `<div class="incident-item">
        <div class="inc-dot" style="background:var(--muted)"></div>
        <div class="inc-text inc-type">${data.source === "simulated" ? "Simulated — TomTom offline" : "No active incidents"}</div>
      </div>`;
    }
    setPill("pill-traffic", "ok");
  } catch (e) {
    console.error("[traffic]", e);
    setPill("pill-traffic", "err");
  }
}


// ══════════════════════════════════════════════════════════════════════════
// HISTORIC SITES — sidebar list
// ══════════════════════════════════════════════════════════════════════════

async function fetchHistoric() {
  try {
    const res   = await fetch(`${API}/api/historic`);
    const sites = await res.json();
    const list  = document.getElementById("historicList");
    list.innerHTML = sites.map(s => `
      <div class="historic-item" onclick="flyTo(${s.geometry.coordinates[0]},${s.geometry.coordinates[1]},400,'${s.name}')">
        <div class="hist-name">${s.name}</div>
        <div class="hist-meta">${s.site_type} · ${s.era_start} AD${s.unesco ? " · 🏛 UNESCO" : ""}</div>
        <div class="hist-desc">${(s.description || "").slice(0, 100)}…</div>
      </div>
    `).join("");
  } catch (e) {
    console.error("[historic]", e);
    document.getElementById("historicList").innerHTML = "<div class='inc-type'>Failed to load</div>";
  }
}


// ══════════════════════════════════════════════════════════════════════════
// CHARTS — from Flask /api/analytics, /api/energy
// ══════════════════════════════════════════════════════════════════════════

const CHART_DEFAULTS = {
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: "rgba(10,9,12,0.9)", titleColor: "#d4b483",
      bodyColor: "#c8b99a", borderColor: "rgba(212,180,131,0.2)", borderWidth: 1,
    },
  },
  scales: {
    x: { grid: { color: "rgba(212,180,131,0.06)" }, ticks: { color: "#5a4f3f", font: { size: 9 } } },
    y: { grid: { color: "rgba(212,180,131,0.06)" }, ticks: { color: "#5a4f3f", font: { size: 9 } } },
  },
  responsive: true,
  maintainAspectRatio: false,
};

let tourismChart, realEstateChart, populationChart, energyChart;

async function fetchAnalytics() {
  try {
    const [analytics, energy] = await Promise.all([
      fetch(`${API}/api/analytics`).then(r => r.json()),
      fetch(`${API}/api/energy`).then(r => r.json()),
    ]);

    // Tourism chart
    const tourismLabels = analytics.tourism_visitors_m.map(d => d.year);
    const tourismData   = analytics.tourism_visitors_m.map(d => d.visitors);
    if (tourismChart) tourismChart.destroy();
    tourismChart = new Chart(document.getElementById("tourismChart"), {
      type: "bar",
      data: {
        labels: tourismLabels,
        datasets: [{ data: tourismData, backgroundColor: "rgba(212,180,131,0.3)", borderColor: "rgba(212,180,131,0.8)", borderWidth: 1, borderRadius: 2 }],
      },
      options: { ...CHART_DEFAULTS, scales: { ...CHART_DEFAULTS.scales, y: { ...CHART_DEFAULTS.scales.y, ticks: { ...CHART_DEFAULTS.scales.y.ticks, callback: v => `${v}M` } } } },
    });

    // Real estate chart
    const reLabels = analytics.real_estate_sqm.map(d => d.year);
    const reData   = analytics.real_estate_sqm.map(d => d.price);
    if (realEstateChart) realEstateChart.destroy();
    realEstateChart = new Chart(document.getElementById("realEstateChart"), {
      type: "line",
      data: {
        labels: reLabels,
        datasets: [{ data: reData, borderColor: "rgba(212,180,131,0.9)", backgroundColor: "rgba(212,180,131,0.08)", fill: true, tension: 0.4, pointRadius: 3, pointBackgroundColor: "#d4b483" }],
      },
      options: { ...CHART_DEFAULTS, scales: { ...CHART_DEFAULTS.scales, y: { ...CHART_DEFAULTS.scales.y, ticks: { ...CHART_DEFAULTS.scales.y.ticks, callback: v => `€${v.toLocaleString()}` } } } },
    });

    // Population chart
    const popLabels = analytics.population_history.map(d => d.year);
    const popData   = analytics.population_history.map(d => d.pop);
    if (populationChart) populationChart.destroy();
    populationChart = new Chart(document.getElementById("populationChart"), {
      type: "line",
      data: {
        labels: popLabels,
        datasets: [{ data: popData, borderColor: "rgba(180,115,51,0.9)", backgroundColor: "rgba(180,115,51,0.08)", fill: true, tension: 0.3, pointRadius: 2, pointBackgroundColor: "#b87333" }],
      },
      options: { ...CHART_DEFAULTS, scales: { ...CHART_DEFAULTS.scales, y: { ...CHART_DEFAULTS.scales.y, ticks: { ...CHART_DEFAULTS.scales.y.ticks, callback: v => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v } } } },
    });

    // Energy chart
    const enLabels = energy.map(d => d.year);
    const enElec   = energy.map(d => d.electricity_cents_kwh);
    const enGas    = energy.map(d => d.gas_cents_kwh);
    if (energyChart) energyChart.destroy();
    energyChart = new Chart(document.getElementById("energyChart"), {
      type: "line",
      data: {
        labels: enLabels,
        datasets: [
          { data: enElec, borderColor: "#d4b483", backgroundColor: "rgba(212,180,131,0.08)", fill: false, tension: 0.4, pointRadius: 3, pointBackgroundColor: "#d4b483", label: "Electricity" },
          { data: enGas,  borderColor: "#4a7fb5", backgroundColor: "rgba(74,127,181,0.08)",  fill: false, tension: 0.4, pointRadius: 3, pointBackgroundColor: "#4a7fb5", label: "Gas" },
        ],
      },
      options: {
        ...CHART_DEFAULTS,
        plugins: { ...CHART_DEFAULTS.plugins, legend: { display: true, labels: { color: "#5a4f3f", font: { size: 9 } } } },
        scales: { ...CHART_DEFAULTS.scales, y: { ...CHART_DEFAULTS.scales.y, ticks: { ...CHART_DEFAULTS.scales.y.ticks, callback: v => `${v}ct` } } },
      },
    });

  } catch (e) {
    console.error("[analytics]", e);
  }
}


// ══════════════════════════════════════════════════════════════════════════
// DEMOGRAPHICS TABLE
// ══════════════════════════════════════════════════════════════════════════

async function fetchDemographics() {
  try {
    const data = await fetch(`${API}/api/demographics`).then(r => r.json());
    const latest = data.filter(d => d.year === Math.max(...data.map(x => x.year)));
    const el = document.getElementById("demographicsTable");
    el.innerHTML = latest.map(d => `
      <div class="stat-row"><span class="stat-label">Population</span><span class="stat-val">${d.total_population.toLocaleString("de-DE")}</span></div>
      <div class="stat-row"><span class="stat-label">Avg age</span><span class="stat-val">${d.avg_age} yr</span></div>
      <div class="stat-row"><span class="stat-label">Foreign residents</span><span class="stat-val">${d.foreign_pct}%</span></div>
      <div class="stat-row"><span class="stat-label">Students</span><span class="stat-val">${d.students_pct}%</span></div>
      <div class="stat-row"><span class="stat-label">Unemployment</span><span class="stat-val">${d.unemployment_pct}%</span></div>
    `).join("");
  } catch (e) {
    console.error("[demographics]", e);
  }
}


// ══════════════════════════════════════════════════════════════════════════
// RENTAL TABLE
// ══════════════════════════════════════════════════════════════════════════

async function fetchRental() {
  try {
    const data = await fetch(`${API}/api/rental`).then(r => r.json());
    const el   = document.getElementById("rentalTable");
    el.innerHTML = `
      <div class="stat-row" style="font-size:0.6rem;color:var(--muted)">
        <span>District</span><span>Rent €/m²</span><span>Sale €/m²</span>
      </div>` +
      data.map(d => `
        <div class="stat-row">
          <span class="stat-label">${d.district}</span>
          <span class="stat-val">${d.avg_rent_sqm}</span>
          <span class="stat-val">${d.avg_sale_price_sqm.toLocaleString()}</span>
        </div>`).join("");
  } catch (e) {
    console.error("[rental]", e);
  }
}


// ══════════════════════════════════════════════════════════════════════════
// PANEL TOGGLES & VIEW MODES
// ══════════════════════════════════════════════════════════════════════════

let leftOpen = true, rightOpen = true;

function toggleLeftPanel() {
  leftOpen = !leftOpen;
  document.getElementById("leftPanel").classList.toggle("collapsed", !leftOpen);
  const btn = document.getElementById("toggleLeft");
  btn.classList.toggle("shifted", !leftOpen);
  btn.textContent = leftOpen ? "◀" : "▶";
  adjustBottomBar();
}

function toggleRightPanel() {
  rightOpen = !rightOpen;
  document.getElementById("rightPanel").classList.toggle("collapsed", !rightOpen);
  const btn = document.getElementById("toggleRight");
  btn.classList.toggle("shifted", !rightOpen);
  btn.textContent = rightOpen ? "▶" : "◀";
  adjustBottomBar();
}

function adjustBottomBar() {
  const bar = document.getElementById("bottomBar");
  bar.style.left  = leftOpen  ? "210px" : "0";
  bar.style.right = rightOpen ? "300px" : "0";
}

function setView(mode, evt) {
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
  evt.target.classList.add("active");
  if (mode === "historic")     { setEra("roman"); showToast("Roman era view"); }
  else if (mode === "analytics") { if (!rightOpen) toggleRightPanel(); showToast("Analytics dashboard"); }
  else if (mode === "buildings") { showToast("Buildings loaded from DB"); }
  else if (mode === "demographics") { if (!rightOpen) toggleRightPanel(); showToast("Demographics"); }
  else { setEra("modern"); showToast("3D Twin view"); }
}


// ══════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════

function setPill(id, state) {
  const el = document.getElementById(id);
  if (el) el.className = `api-pill ${state}`;
}

let toastTimer;
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2500);
}

function updateClock() {
  document.getElementById("clockDisplay").textContent =
    new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) + " CET";
}


// ══════════════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════════════

(async function init() {
  // Initial camera position
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(TRIER.lon, TRIER.lat, 2500),
    orientation: { heading: Cesium.Math.toRadians(0), pitch: Cesium.Math.toRadians(-45), roll: 0 },
    duration: 3,
  });

  updateEraSlider(2024);
  updateClock();

  // Load all GeoJSON layers
  await Promise.allSettled([
    loadGeoJsonLayer("fort"),
    loadGeoJsonLayer("historic"),
    loadGeoJsonLayer("housing"),
    loadGeoJsonLayer("roads"),
    loadBuildings(),
  ]);

  // Load all dashboard data
  await Promise.allSettled([
    fetchWeather(),
    fetchTraffic(),
    fetchHistoric(),
    fetchAnalytics(),
    fetchDemographics(),
    fetchRental(),
  ]);

  setPill("pill-db", "ok");
  document.getElementById("apiStatusText").textContent = "LIVE";

  // Refresh intervals
  setInterval(updateClock,    1000);
  setInterval(fetchWeather,   300000);   // 5 min
  setInterval(fetchTraffic,   60000);    // 1 min
})();
