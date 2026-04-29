"""
Trier Digital Twin — Flask Backend
Handles all external API calls, DB queries, and caching.
Run: python server.py
"""

import os, json, time, requests
from datetime import datetime, timedelta
from flask import Flask, jsonify, render_template, request
from flask_cors import CORS
from flask_caching import Cache
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from apscheduler.schedulers.background import BackgroundScheduler
from sqlalchemy import create_engine, text
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
CORS(app, origins=["http://localhost:5000", "http://127.0.0.1:5000"])

# ── Rate Limiter ─────────────────────────────────────────────────────────────
limiter = Limiter(
    app=app,
    key_func=get_remote_address,
    default_limits=["100 per minute"],
    storage_uri="memory://",
)

# ── Cache (simple in-memory; swap to Redis for production) ──────────────────
app.config["CACHE_TYPE"] = "SimpleCache"
app.config["CACHE_DEFAULT_TIMEOUT"] = 300  # 5 min
cache = Cache(app)

# ── DB ───────────────────────────────────────────────────────────────────────
DB_URL = os.getenv("DATABASE_URL", "postgresql://trieruser:yourpassword@localhost/trier_twin")
engine = create_engine(DB_URL, pool_pre_ping=True)

# ── API Keys (from .env) ─────────────────────────────────────────────────────
OWM_KEY      = os.getenv("OWM_KEY", "")
TOMTOM_KEY   = os.getenv("TOMTOM_KEY", "")
CESIUM_TOKEN = os.getenv("CESIUM_TOKEN", "")
ADMIN_SECRET = os.getenv("ADMIN_SECRET", "change-me-in-production")

TRIER = {"lat": 49.7596, "lon": 6.6441}


# ══════════════════════════════════════════════════════════════════════════════
# MAIN PAGE
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/")
def index():
    return render_template("index.html", cesium_token=CESIUM_TOKEN)


# ══════════════════════════════════════════════════════════════════════════════
# GEOJSON LAYERS
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/api/layers/<layer_name>")
@cache.cached(timeout=3600)  # 1 hour — static data
def get_layer(layer_name):
    allowed = ["fort_trier", "historic_trier", "housing_trier", "roads_trier"]
    if layer_name not in allowed:
        return jsonify({"error": {"code": "LAYER_NOT_FOUND", "message": f"Layer '{layer_name}' is not available"}}), 404
    path = os.path.join("static", f"{layer_name}.geojson")
    if not os.path.exists(path):
        return jsonify({"error": {"code": "FILE_NOT_FOUND", "message": f"GeoJSON file for '{layer_name}' does not exist"}}), 404
    with open(path, "r", encoding="utf-8") as f:
        return app.response_class(f.read(), mimetype="application/json")


# ══════════════════════════════════════════════════════════════════════════════
# BUILDINGS — from DB (PostGIS) or fallback to OSM Overpass
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/api/buildings")
@cache.cached(timeout=3600)
def get_buildings():
    try:
        with engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT id, name, era, building_type, height_m, year_built,
                       description, ST_AsGeoJSON(geom)::json AS geometry
                FROM buildings
                WHERE geom IS NOT NULL
                LIMIT 500
            """)).fetchall()
        features = []
        for r in rows:
            features.append({
                "type": "Feature",
                "geometry": r.geometry,
                "properties": {
                    "id": r.id, "name": r.name, "era": r.era,
                    "building_type": r.building_type, "height_m": r.height_m,
                    "year_built": r.year_built, "description": r.description
                }
            })
        return jsonify({"type": "FeatureCollection", "features": features})
    except Exception as e:
        print(f"[buildings] DB error: {e}, falling back to OSM")
        return _fetch_osm_buildings()


def _fetch_osm_buildings():
    """Fetch buildings from OSM Overpass API as fallback."""
    query = f"""
    [out:json][timeout:25];
    (
      way["building"](49.74,6.62,49.78,6.67);
      relation["building"](49.74,6.62,49.78,6.67);
    );
    out body; >; out skel qt;
    """
    try:
        r = requests.post("https://overpass-api.de/api/interpreter",
                          data={"data": query}, timeout=30)
        return jsonify(r.json())
    except Exception as e:
        return jsonify({"error": {"code": "OSM_UNAVAILABLE", "message": f"Overpass API error: {str(e)}"}}), 503


# ══════════════════════════════════════════════════════════════════════════════
# WEATHER — cached, refreshed by scheduler
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/api/weather")
def get_weather():
    cached = cache.get("weather_data")
    if cached:
        return jsonify(cached)
    data = _fetch_weather()
    cache.set("weather_data", data, timeout=300)
    return jsonify(data)


def _fetch_weather():
    """Fetch current + forecast from OWM, fallback to Open-Meteo."""
    result = {"source": "owm", "current": {}, "forecast": [], "fetched_at": datetime.utcnow().isoformat()}
    try:
        cur = requests.get(
            f"https://api.openweathermap.org/data/2.5/weather"
            f"?lat={TRIER['lat']}&lon={TRIER['lon']}&appid={OWM_KEY}&units=metric",
            timeout=8
        ).json()
        if cur.get("cod") != 200:
            raise ValueError(cur.get("message", "OWM error"))

        result["current"] = {
            "temp": round(cur["main"]["temp"], 1),
            "feels_like": round(cur["main"]["feels_like"], 1),
            "humidity": cur["main"]["humidity"],
            "wind_speed": round(cur["wind"]["speed"] * 3.6, 1),
            "wind_deg": cur["wind"].get("deg", 0),
            "visibility": cur.get("visibility", 10000),
            "description": cur["weather"][0]["description"],
            "icon": cur["weather"][0]["icon"],
            "pressure": cur["main"]["pressure"],
        }

        fc = requests.get(
            f"https://api.openweathermap.org/data/2.5/forecast"
            f"?lat={TRIER['lat']}&lon={TRIER['lon']}&appid={OWM_KEY}&units=metric",
            timeout=8
        ).json()
        # Pick one entry per day (closest to noon)
        days = {}
        for item in fc.get("list", []):
            dt = datetime.fromtimestamp(item["dt"])
            key = dt.strftime("%Y-%m-%d")
            if key not in days or abs(dt.hour - 12) < abs(datetime.fromtimestamp(days[key]["dt"]).hour - 12):
                days[key] = item
        result["forecast"] = [
            {
                "date": k,
                "temp_max": round(v["main"]["temp_max"], 1),
                "temp_min": round(v["main"]["temp_min"], 1),
                "icon": v["weather"][0]["icon"],
                "description": v["weather"][0]["description"],
            }
            for k, v in list(days.items())[:5]
        ]
    except Exception as e:
        print(f"[weather] OWM failed: {e}, using Open-Meteo")
        result["source"] = "open-meteo"
        try:
            m = requests.get(
                f"https://api.open-meteo.com/v1/forecast"
                f"?latitude={TRIER['lat']}&longitude={TRIER['lon']}"
                f"&current=temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation,weather_code"
                f"&daily=temperature_2m_max,temperature_2m_min,weather_code"
                f"&timezone=Europe/Berlin&forecast_days=5",
                timeout=8
            ).json()
            c = m["current"]
            result["current"] = {
                "temp": c["temperature_2m"],
                "feels_like": c["temperature_2m"],
                "humidity": c["relative_humidity_2m"],
                "wind_speed": c["wind_speed_10m"],
                "wind_deg": 0,
                "visibility": 10000,
                "description": f"WMO code {c['weather_code']}",
                "icon": "03d",
                "pressure": 1013,
            }
            d = m["daily"]
            result["forecast"] = [
                {
                    "date": d["time"][i],
                    "temp_max": d["temperature_2m_max"][i],
                    "temp_min": d["temperature_2m_min"][i],
                    "icon": "03d",
                    "description": "",
                }
                for i in range(min(5, len(d["time"])))
            ]
        except Exception as e2:
            print(f"[weather] Open-Meteo also failed: {e2}")
    return result


# ══════════════════════════════════════════════════════════════════════════════
# TRAFFIC — TomTom, cached per minute
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/api/traffic")
def get_traffic():
    cached = cache.get("traffic_data")
    if cached:
        return jsonify(cached)
    data = _fetch_traffic()
    cache.set("traffic_data", data, timeout=60)
    return jsonify(data)


def _fetch_traffic():
    result = {"source": "simulated", "congestion": 0.3, "status": "Moderate",
               "roads": [], "incidents": [], "fetched_at": datetime.utcnow().isoformat()}
    try:
        r = requests.get(
            f"https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json"
            f"?point={TRIER['lat']},{TRIER['lon']}&key={TOMTOM_KEY}",
            timeout=6
        ).json()
        flow = r.get("flowSegmentData", {})
        if not flow:
            raise ValueError("No flow data")
        free = flow.get("freeFlowSpeed", 50)
        current = flow.get("currentSpeed", 40)
        cong = max(0, min(1, 1 - current / free))
        status = "Free Flow" if cong < 0.2 else "Moderate" if cong < 0.5 else "Heavy" if cong < 0.75 else "Congested"
        result = {"source": "tomtom", "congestion": round(cong, 3), "status": status,
                   "free_flow_speed": free, "current_speed": current,
                   "roads": [], "incidents": [], "fetched_at": datetime.utcnow().isoformat()}

        # Incidents
        inc = requests.get(
            f"https://api.tomtom.com/traffic/services/5/incidentDetails"
            f"?bbox=6.60,49.74,6.70,49.78&fields={{incidents{{type,geometry,properties}}}}&key={TOMTOM_KEY}",
            timeout=6
        ).json()
        for i in inc.get("incidents", [])[:5]:
            props = i.get("properties", {})
            result["incidents"].append({
                "description": props.get("events", [{}])[0].get("description", "Traffic incident"),
                "delay": props.get("delay", 0),
                "magnitude": props.get("magnitudeOfDelay", 0),
            })
    except Exception as e:
        print(f"[traffic] TomTom failed: {e}, using simulation")
        h = datetime.now().hour
        load = 0.7 if (7 <= h < 9 or 16 <= h < 19) else 0.5 if 12 <= h < 13 else 0.1 if (h >= 22 or h < 6) else 0.25
        result["congestion"] = round(load, 3)
        result["status"] = "Free Flow" if load < 0.2 else "Moderate" if load < 0.5 else "Heavy"
    return result


# ══════════════════════════════════════════════════════════════════════════════
# HISTORIC BUILDINGS — rich detail from DB
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/api/historic")
@cache.cached(timeout=3600)
def get_historic():
    try:
        with engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT id, name, era_start, era_end, site_type, description,
                       significance, restoration_year, unesco,
                       ST_AsGeoJSON(geom)::json AS geometry
                FROM historic_sites
                ORDER BY era_start
            """)).fetchall()
        return jsonify([dict(r._mapping) for r in rows])
    except Exception as e:
        print(f"[historic] DB error: {e}")
        # Return hardcoded seed data if DB not yet populated
        return jsonify(_historic_seed())


def _historic_seed():
    return [
        {"id":1,"name":"Porta Nigra","era_start":160,"era_end":200,"site_type":"Roman Gate",
         "description":"Largest surviving Roman city gate north of the Alps, built ~170 AD.",
         "significance":"UNESCO World Heritage Site","restoration_year":1986,"unesco":True,
         "geometry":{"type":"Point","coordinates":[6.6432,49.7576]}},
        {"id":2,"name":"Amphitheatre","era_start":100,"era_end":200,"site_type":"Roman Amphitheatre",
         "description":"Roman amphitheatre built in 2nd century AD, capacity ~18,000 spectators.",
         "significance":"UNESCO World Heritage Site","restoration_year":1972,"unesco":True,
         "geometry":{"type":"Point","coordinates":[6.6518,49.7500]}},
        {"id":3,"name":"Trier Cathedral","era_start":340,"era_end":1196,"site_type":"Cathedral",
         "description":"Oldest cathedral in Germany, built on Roman imperial palace foundations.",
         "significance":"UNESCO World Heritage Site","restoration_year":2000,"unesco":True,
         "geometry":{"type":"Point","coordinates":[6.6451,49.7561]}},
        {"id":4,"name":"Basilica of Constantine","era_start":306,"era_end":320,"site_type":"Roman Basilica",
         "description":"Throne hall of Emperor Constantine, largest surviving single room from antiquity.",
         "significance":"UNESCO World Heritage Site","restoration_year":1960,"unesco":True,
         "geometry":{"type":"Point","coordinates":[6.6456,49.7546]}},
        {"id":5,"name":"Imperial Baths","era_start":293,"era_end":316,"site_type":"Roman Baths",
         "description":"Kaiserthermen — among the largest Roman baths in the empire.",
         "significance":"UNESCO World Heritage Site","restoration_year":1990,"unesco":True,
         "geometry":{"type":"Point","coordinates":[6.6484,49.7500]}},
        {"id":6,"name":"Barbara Baths","era_start":150,"era_end":200,"site_type":"Roman Baths",
         "description":"Second-largest Roman baths in Trier, once full thermal complex.",
         "significance":"Local heritage","restoration_year":None,"unesco":False,
         "geometry":{"type":"Point","coordinates":[6.6441,49.7524]}},
    ]


# ══════════════════════════════════════════════════════════════════════════════
# RENTAL PRICES — from DB
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/api/rental")
@cache.cached(timeout=3600)
def get_rental():
    try:
        with engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT district, avg_rent_sqm, avg_sale_price_sqm, year,
                       pct_change_yoy, vacancy_rate
                FROM rental_prices
                WHERE year = (SELECT MAX(year) FROM rental_prices)
                ORDER BY district
            """)).fetchall()
            if not rows:
                raise ValueError("No data")
            return jsonify([dict(r._mapping) for r in rows])
    except Exception as e:
        print(f"[rental] DB error: {e}")
        return jsonify(_rental_seed())


def _rental_seed():
    return [
        {"district":"Innenstadt","avg_rent_sqm":12.8,"avg_sale_price_sqm":3850,"year":2024,"pct_change_yoy":4.2,"vacancy_rate":1.8},
        {"district":"Trier-West","avg_rent_sqm":10.2,"avg_sale_price_sqm":2950,"year":2024,"pct_change_yoy":3.1,"vacancy_rate":2.4},
        {"district":"Trier-Nord","avg_rent_sqm":9.8,"avg_sale_price_sqm":2720,"year":2024,"pct_change_yoy":2.8,"vacancy_rate":3.1},
        {"district":"Olewig","avg_rent_sqm":11.4,"avg_sale_price_sqm":3200,"year":2024,"pct_change_yoy":3.6,"vacancy_rate":1.5},
        {"district":"Pallien","avg_rent_sqm":9.1,"avg_sale_price_sqm":2580,"year":2024,"pct_change_yoy":1.9,"vacancy_rate":3.8},
        {"district":"Trier-Süd","avg_rent_sqm":10.6,"avg_sale_price_sqm":3050,"year":2024,"pct_change_yoy":3.4,"vacancy_rate":2.2},
    ]


# ══════════════════════════════════════════════════════════════════════════════
# ENERGY PRICES — from DB
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/api/energy")
@cache.cached(timeout=3600)
def get_energy():
    try:
        with engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT year, electricity_cents_kwh, gas_cents_kwh,
                       solar_installations, avg_household_kwh_year
                FROM energy_data
                ORDER BY year
            """)).fetchall()
            if not rows:
                raise ValueError("No data")
            return jsonify([dict(r._mapping) for r in rows])
    except Exception as e:
        print(f"[energy] DB error: {e}")
        return jsonify(_energy_seed())


def _energy_seed():
    return [
        {"year":2019,"electricity_cents_kwh":28.5,"gas_cents_kwh":6.2,"solar_installations":1820,"avg_household_kwh_year":3580},
        {"year":2020,"electricity_cents_kwh":29.1,"gas_cents_kwh":5.8,"solar_installations":2010,"avg_household_kwh_year":3520},
        {"year":2021,"electricity_cents_kwh":29.8,"gas_cents_kwh":6.5,"solar_installations":2340,"avg_household_kwh_year":3490},
        {"year":2022,"electricity_cents_kwh":35.4,"gas_cents_kwh":12.8,"solar_installations":2890,"avg_household_kwh_year":3350},
        {"year":2023,"electricity_cents_kwh":38.2,"gas_cents_kwh":11.2,"solar_installations":3450,"avg_household_kwh_year":3280},
        {"year":2024,"electricity_cents_kwh":36.8,"gas_cents_kwh":9.6,"solar_installations":4100,"avg_household_kwh_year":3210},
    ]


# ══════════════════════════════════════════════════════════════════════════════
# DEMOGRAPHICS — from DB
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/api/demographics")
@cache.cached(timeout=3600)
def get_demographics():
    try:
        with engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT year, total_population, avg_age, foreign_pct,
                       students_pct, unemployment_pct, district
                FROM demographics
                ORDER BY year, district
            """)).fetchall()
            if not rows:
                raise ValueError("No data")
            return jsonify([dict(r._mapping) for r in rows])
    except Exception as e:
        print(f"[demographics] DB error: {e}")
        return jsonify(_demographics_seed())


def _demographics_seed():
    return [
        {"year":2019,"total_population":115040,"avg_age":41.2,"foreign_pct":14.8,"students_pct":12.1,"unemployment_pct":5.4,"district":"Gesamt"},
        {"year":2020,"total_population":115780,"avg_age":41.5,"foreign_pct":15.2,"students_pct":12.4,"unemployment_pct":6.1,"district":"Gesamt"},
        {"year":2021,"total_population":116200,"avg_age":41.8,"foreign_pct":15.8,"students_pct":12.6,"unemployment_pct":5.8,"district":"Gesamt"},
        {"year":2022,"total_population":117100,"avg_age":42.0,"foreign_pct":16.4,"students_pct":12.8,"unemployment_pct":5.2,"district":"Gesamt"},
        {"year":2023,"total_population":118100,"avg_age":42.3,"foreign_pct":17.1,"students_pct":13.0,"unemployment_pct":5.0,"district":"Gesamt"},
        {"year":2024,"total_population":118900,"avg_age":42.6,"foreign_pct":17.8,"students_pct":13.2,"unemployment_pct":4.8,"district":"Gesamt"},
    ]


# ══════════════════════════════════════════════════════════════════════════════
# ANALYTICS — combined summary for dashboard
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/api/analytics")
@cache.cached(timeout=300)
def get_analytics():
    return jsonify({
        "tourism_visitors_m": [
            {"year": y, "visitors": v}
            for y, v in [(2018,2.8),(2019,3.1),(2020,0.9),(2021,1.4),(2022,2.2),(2023,3.0),(2024,3.2)]
        ],
        "population_history": [
            {"year": y, "pop": p}
            for y, p in [(100,50000),(300,80000),(600,5000),(900,4000),(1200,8000),
                         (1500,12000),(1800,39000),(1900,50000),(1950,89000),(2000,99000),(2024,118900)]
        ],
        "real_estate_sqm": [
            {"year": y, "price": p}
            for y, p in [(2019,2410),(2020,2680),(2021,2950),(2022,3080),(2023,3180),(2024,3240)]
        ],
        "generated_at": datetime.utcnow().isoformat()
    })


# ══════════════════════════════════════════════════════════════════════════════
# BACKGROUND SCHEDULER — refresh cache periodically
# ══════════════════════════════════════════════════════════════════════════════

def refresh_weather():
    with app.app_context():
        data = _fetch_weather()
        cache.set("weather_data", data, timeout=300)
        print(f"[scheduler] Weather refreshed at {datetime.utcnow().isoformat()}")


def refresh_traffic():
    with app.app_context():
        data = _fetch_traffic()
        cache.set("traffic_data", data, timeout=60)
        print(f"[scheduler] Traffic refreshed at {datetime.utcnow().isoformat()}")


scheduler = BackgroundScheduler()
scheduler.add_job(refresh_weather, "interval", minutes=5)
scheduler.add_job(refresh_traffic, "interval", minutes=1)
scheduler.start()


# ══════════════════════════════════════════════════════════════════════════════
# DB SCHEMA INIT — run once to create tables
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/admin/init-db", methods=["POST"])
def init_db():
    """
    Initialize database tables. Requires X-Admin-Secret header.
    Remove this endpoint in production after initial setup.
    """
    # Validate admin secret
    provided_secret = request.headers.get("X-Admin-Secret", "")
    if not provided_secret or provided_secret != ADMIN_SECRET:
        return jsonify({
            "error": {
                "code": "UNAUTHORIZED",
                "message": "Missing or invalid X-Admin-Secret header"
            }
        }), 401
    schema = """
    CREATE TABLE IF NOT EXISTS buildings (
        id SERIAL PRIMARY KEY,
        name TEXT,
        era TEXT,
        building_type TEXT,
        height_m FLOAT,
        year_built INT,
        description TEXT,
        geom GEOMETRY(Polygon, 4326)
    );
    CREATE TABLE IF NOT EXISTS historic_sites (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        era_start INT,
        era_end INT,
        site_type TEXT,
        description TEXT,
        significance TEXT,
        restoration_year INT,
        unesco BOOLEAN DEFAULT FALSE,
        geom GEOMETRY(Point, 4326)
    );
    CREATE TABLE IF NOT EXISTS rental_prices (
        id SERIAL PRIMARY KEY,
        district TEXT,
        avg_rent_sqm FLOAT,
        avg_sale_price_sqm FLOAT,
        year INT,
        pct_change_yoy FLOAT,
        vacancy_rate FLOAT
    );
    CREATE TABLE IF NOT EXISTS energy_data (
        id SERIAL PRIMARY KEY,
        year INT UNIQUE,
        electricity_cents_kwh FLOAT,
        gas_cents_kwh FLOAT,
        solar_installations INT,
        avg_household_kwh_year FLOAT
    );
    CREATE TABLE IF NOT EXISTS demographics (
        id SERIAL PRIMARY KEY,
        year INT,
        total_population INT,
        avg_age FLOAT,
        foreign_pct FLOAT,
        students_pct FLOAT,
        unemployment_pct FLOAT,
        district TEXT
    );
    CREATE TABLE IF NOT EXISTS weather_cache (
        id SERIAL PRIMARY KEY,
        fetched_at TIMESTAMPTZ DEFAULT NOW(),
        data JSONB
    );
    """
    try:
        with engine.connect() as conn:
            for stmt in schema.strip().split(";"):
                s = stmt.strip()
                if s:
                    conn.execute(text(s))
            conn.commit()
        return jsonify({"status": "Tables created successfully"})
    except Exception as e:
        return jsonify({"error": {"code": "DB_SCHEMA_ERROR", "message": f"Failed to create tables: {str(e)}"}}), 500


# ══════════════════════════════════════════════════════════════════════════════
# HEALTH CHECK
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/api/health")
def health():
    return jsonify({"status": "ok", "time": datetime.utcnow().isoformat()})


if __name__ == "__main__":
    app.run(debug=False, port=5000, use_reloader=False)
