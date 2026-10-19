import { buildGraph, CompactOsm, Graph, LatLng } from "./graph";

export const MAP_CENTER: LatLng = [49.8419, 24.0315]; // Львів, центр
const BBOX = "49.832,24.010,49.850,24.045"; // south,west,north,east
const CACHE_KEY = "uml-lviv-osm-v1";
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const QUERY = `[out:json][timeout:40];
way["highway"~"^(trunk|primary|secondary|tertiary|unclassified|residential)$"](${BBOX});
(._;>;);
out body;`;

async function fetchOverpass(): Promise<CompactOsm> {
  let lastErr: unknown;
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, { method: "POST", body: new URLSearchParams({ data: QUERY }) });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      const json = await res.json();
      const compact: CompactOsm = { nodes: [], ways: [] };
      for (const el of json.elements) {
        if (el.type === "node") {
          compact.nodes.push([String(el.id), el.lat, el.lon, el.tags?.highway === "traffic_signals" ? 1 : 0]);
        } else if (el.type === "way" && el.tags?.highway) {
          compact.ways.push({
            id: String(el.id),
            nodes: el.nodes.map(String),
            hw: el.tags.highway,
            name: el.tags.name || el.tags.ref || "",
            lanes: parseInt(el.tags.lanes, 10) || 0,
            oneway: el.tags.oneway === "yes",
          });
        }
      }
      return compact;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Не вдалося завантажити дані з Overpass API: ${String(lastErr)}`);
}

export async function loadGraph(force = false): Promise<{ graph: Graph; fromCache: boolean }> {
  if (!force) {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) return { graph: buildGraph(JSON.parse(raw) as CompactOsm), fromCache: true };
    } catch { /* кеш недоступний або пошкоджений — завантажуємо заново */ }
  }
  const compact = await fetchOverpass();
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(compact)); } catch { /* квота — не критично */ }
  return { graph: buildGraph(compact), fromCache: false };
}

// OSRM не знає про наші перекриття: це маршрут, який запропонував би звичайний навігатор.
export async function osrmBaselineMinutes(a: LatLng, b: LatLng): Promise<number | null> {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${a[1]},${a[0]};${b[1]},${b[0]}?overview=false`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const j = await res.json();
    const s = j.routes?.[0]?.duration;
    return typeof s === "number" ? s / 60 : null;
  } catch {
    return null;
  }
}
