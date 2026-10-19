// Дорожній граф з OSM + пошук найкоротшого шляху з урахуванням перекритих ділянок.
export type LatLng = [number, number];

export interface Edge {
  id: string;
  from: string;
  to: string;
  coords: LatLng[];
  length: number; // м
  highway: string;
  name: string;
  lanes: number; // смуг в одному напрямку (оцінка)
  speedKmh: number; // умовна швидкість вільного потоку
  oneway: boolean; // true: рух лише від from до to
}

export interface Graph {
  nodes: Map<string, LatLng>;
  signals: Set<string>; // вузли з highway=traffic_signals в OSM
  edges: Edge[];
  edgeById: Map<string, Edge>;
  adj: Map<string, Edge[]>; // усі інцидентні ребра (без урахування напрямку)
  out: Map<string, Edge[]>; // ребра, якими можна виїхати з вузла
}

// Компактний формат (його ж кешуємо в localStorage)
export interface CompactOsm {
  nodes: [string, number, number, 0 | 1][]; // id, lat, lon, signal
  ways: { id: string; nodes: string[]; hw: string; name: string; lanes: number; oneway: 0 | 1 | -1 }[]; // -1: односторонній проти напрямку вузлів
}

const SPEED: Record<string, number> = { trunk: 60, primary: 50, secondary: 50, tertiary: 40, unclassified: 40, residential: 30 };
const LANES: Record<string, number> = { trunk: 2, primary: 2, secondary: 1, tertiary: 1, unclassified: 1, residential: 1 };

export function haversine(a: LatLng, b: LatLng): number {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function buildGraph(osm: CompactOsm): Graph {
  const nodes = new Map<string, LatLng>();
  const signals = new Set<string>();
  for (const [id, lat, lon, sig] of osm.nodes) {
    nodes.set(id, [lat, lon]);
    if (sig) signals.add(id);
  }
  // Вузол, що належить кільком дорогам, — перехрестя: по ньому ріжемо дороги на сегменти.
  const uses = new Map<string, number>();
  for (const w of osm.ways) for (const n of w.nodes) uses.set(n, (uses.get(n) ?? 0) + 1);

  const edges: Edge[] = [];
  for (const w of osm.ways) {
    const wn = w.oneway === -1 ? [...w.nodes].reverse() : w.nodes;
    let start = 0;
    let k = 0;
    for (let i = 1; i < wn.length; i++) {
      const isCut = i === wn.length - 1 || (uses.get(wn[i]) ?? 0) > 1;
      if (!isCut) continue;
      const ids = wn.slice(start, i + 1);
      const coords = ids.map((n) => nodes.get(n)).filter((c): c is LatLng => !!c);
      const from = ids[0], to = ids[ids.length - 1];
      if (coords.length === ids.length && from !== to) {
        let length = 0;
        for (let j = 1; j < coords.length; j++) length += haversine(coords[j - 1], coords[j]);
        const lanes = w.lanes > 0 ? (w.oneway !== 0 ? w.lanes : Math.max(1, Math.ceil(w.lanes / 2))) : LANES[w.hw] ?? 1;
        edges.push({
          id: `${w.id}_${k}`, from, to, coords, length, highway: w.hw,
          name: w.name || w.hw, lanes, speedKmh: SPEED[w.hw] ?? 30, oneway: w.oneway !== 0,
        });
      }
      k++;
      start = i;
    }
  }
  const edgeById = new Map(edges.map((e) => [e.id, e]));
  const adj = new Map<string, Edge[]>();
  const out = new Map<string, Edge[]>();
  const add = (m: Map<string, Edge[]>, n: string, e: Edge) => {
    if (!m.has(n)) m.set(n, []);
    m.get(n)!.push(e);
  };
  for (const e of edges) {
    add(adj, e.from, e); add(adj, e.to, e);
    add(out, e.from, e);
    if (!e.oneway) add(out, e.to, e);
  }
  return { nodes, signals, edges, edgeById, adj, out };
}

export const otherEnd = (e: Edge, n: string) => (e.from === n ? e.to : e.from);
export const freeFlowSec = (e: Edge) => e.length / (e.speedKmh / 3.6);

// ---- мінімальна бінарна купа ----
class Heap {
  a: [number, string][] = [];
  get size() { return this.a.length; }
  push(x: [number, string]) {
    const a = this.a; a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop(): [number, string] | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0], last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

export interface Path { nodes: string[]; edges: Edge[]; length: number; timeSec: number }

export function shortestPath(
  g: Graph, src: string, dst: string, blocked: Set<string>, penalty: Map<string, number>
): Path | null {
  const dist = new Map<string, number>([[src, 0]]);
  const prev = new Map<string, { n: string; e: Edge }>();
  const h = new Heap();
  h.push([0, src]);
  while (h.size) {
    const [d, u] = h.pop()!;
    if (d > (dist.get(u) ?? Infinity)) continue;
    if (u === dst) break;
    for (const e of g.out.get(u) ?? []) {
      if (blocked.has(e.id)) continue;
      const v = otherEnd(e, u);
      const nd = d + freeFlowSec(e) * (penalty.get(e.id) ?? 1);
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, { n: u, e }); h.push([nd, v]); }
    }
  }
  if (!dist.has(dst)) return null;
  const nodes = [dst], edges: Edge[] = [];
  for (let cur = dst; cur !== src; ) {
    const p = prev.get(cur)!;
    edges.unshift(p.e); nodes.unshift(p.n); cur = p.n;
  }
  return {
    nodes, edges,
    length: edges.reduce((s, e) => s + e.length, 0),
    timeSec: edges.reduce((s, e) => s + freeFlowSec(e), 0),
  };
}

// До k різних об'їздів: після кожного знайденого штрафуємо його ребра.
export function alternativePaths(g: Graph, a: string, b: string, blocked: Set<string>, k = 3): Path[] {
  const penalty = new Map<string, number>();
  const found: Path[] = [];
  const seen = new Set<string>();
  for (let attempt = 0; attempt < k * 4 && found.length < k; attempt++) {
    const p = shortestPath(g, a, b, blocked, penalty);
    if (!p) break;
    const sig = p.edges.map((e) => e.id).join("|");
    if (!seen.has(sig)) { seen.add(sig); found.push(p); }
    for (const e of p.edges) penalty.set(e.id, (penalty.get(e.id) ?? 1) * 2.5);
  }
  return found;
}
