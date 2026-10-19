import { useEffect, useRef } from "react";
import L from "leaflet";
import { Graph } from "./graph";
import { MAP_CENTER } from "./roadNetwork";
import { SimResult } from "./simulation";

interface Props {
  graph: Graph | null;
  selected: Set<string>;
  onToggle: (edgeId: string) => void;
  result: SimResult | null;
}

const baseStyle = (hw: string): L.PathOptions => ({
  color: "#7b8794", opacity: 0.85,
  weight: hw === "primary" || hw === "trunk" ? 5 : hw === "secondary" ? 4 : 3,
});
const selStyle: L.PathOptions = { color: "#c2342b", opacity: 1, weight: 8 };

const pin = (emoji: string) => L.divIcon({ className: "pin", html: emoji, iconSize: [26, 26], iconAnchor: [13, 13] });

export default function MapView({ graph, selected, onToggle, result }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const lines = useRef(new Map<string, L.Polyline>());
  const netLayer = useRef<L.LayerGroup | null>(null);
  const overlay = useRef<L.LayerGroup | null>(null);
  const toggleRef = useRef(onToggle);
  toggleRef.current = onToggle;

  useEffect(() => {
    if (!host.current || map.current) return;
    const m = L.map(host.current, { renderer: L.canvas({ padding: 0.5, tolerance: 7 }) }).setView(MAP_CENTER, 15);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors",
    }).addTo(m);
    netLayer.current = L.layerGroup().addTo(m);
    overlay.current = L.layerGroup().addTo(m);
    map.current = m;
    return () => { m.remove(); map.current = null; };
  }, []);

  // Мережа доріг
  useEffect(() => {
    const layer = netLayer.current;
    if (!layer || !graph) return;
    layer.clearLayers();
    lines.current.clear();
    for (const e of graph.edges) {
      const pl = L.polyline(e.coords, baseStyle(e.highway));
      pl.bindTooltip(`${e.name} · ${e.highway}`, { sticky: true });
      pl.on("click", () => toggleRef.current(e.id));
      pl.addTo(layer);
      lines.current.set(e.id, pl);
    }
  }, [graph]);

  // Підсвітка вибраних ділянок
  useEffect(() => {
    if (!graph) return;
    for (const [id, pl] of lines.current) {
      const e = graph.edgeById.get(id)!;
      pl.setStyle(selected.has(id) ? selStyle : baseStyle(e.highway));
      if (selected.has(id)) pl.bringToFront();
    }
  }, [selected, graph]);

  // Результат симуляції
  useEffect(() => {
    const layer = overlay.current, m = map.current;
    if (!layer || !m) return;
    layer.clearLayers();
    if (!result || result.error) return;
    const bounds = L.latLngBounds([]);
    for (const a of result.alternatives) {
      for (const e of a.path.edges) {
        L.polyline(e.coords, { color: a.color, weight: 6, opacity: 0.85, interactive: false }).addTo(layer);
        e.coords.forEach((c) => bounds.extend(c));
      }
    }
    for (const e of result.hotEdges) {
      L.polyline(e.coords, { color: "#c2342b", weight: 3, dashArray: "6 6", interactive: false }).addTo(layer);
    }
    for (const c of result.critical) {
      L.circleMarker(c.pos, { radius: 9, color: "#b45309", weight: 3, fillColor: "#f59e0b", fillOpacity: 0.9 })
        .bindTooltip(`${c.label}<br/>v/c ≈ ${c.vc.toFixed(2)}`).addTo(layer);
    }
    for (const s of result.signals) L.marker(s.pos, { icon: pin("🚦"), interactive: false }).addTo(layer);
    for (const p of result.police) {
      L.marker(p.pos, { icon: pin("👮") }).bindTooltip(`${p.label}<br/>${p.reason}`).addTo(layer);
    }
    if (bounds.isValid()) m.fitBounds(bounds, { padding: [60, 60] });
  }, [result]);

  return <div ref={host} className="map" />;
}
