// Евристична СИНТЕТИЧНА модель. Це не транспортна симуляція і не калібрована на реальних даних.
// Ідея: BPR-функція затримки + логіт-розподіл витісненого потоку по об'їздах.
import { Edge, Graph, LatLng, Path, alternativePaths, freeFlowSec, haversine, shortestPath } from "./graph";

export type TimeOfDay = "night" | "morning" | "day" | "evening" | "weekend";
export const TIME_LABEL: Record<TimeOfDay, string> = {
  night: "Ніч", morning: "Ранковий пік", day: "День", evening: "Вечірній пік", weekend: "Вихідні",
};
export const TIME_MULT: Record<TimeOfDay, number> = { night: 0.2, morning: 1.0, day: 0.65, evening: 1.1, weekend: 0.5 };

export interface Params {
  demand: number; // авто/год на перекритій ділянці у "піковому" режимі (до множника часу доби)
  capPerLane: number; // авто/год на смугу
  time: TimeOfDay;
  bgLoad: number; // фонове завантаження решти мережі, частка від пропускної здатності
  closurePct: number; // 50..100: яка частка пропускної здатності ділянки закрита
}

export interface SimInput { graph: Graph; closed: string[]; params: Params }

export interface AltResult {
  index: number; path: Path; share: number; color: string;
  extraKm: number; extraMin: number; maxVc: number;
}
export interface CriticalNode { nodeId: string; pos: LatLng; label: string; vc: number; hasSignal: boolean }
export interface SignalRec { pos: LatLng; label: string; text: string }
export interface PoliceRec { pos: LatLng; label: string; reason: string }

export interface DivergencePoint { pos: LatLng; label: string; share: number }

export interface SimResult {
  synthetic: true;
  mode: "od" | "local"; // od: перемаршрутизація умовних поїздок здалеку; local: лише обхід між кінцями ділянки
  odCount: number;
  divergence: DivergencePoint[];
  error?: string;
  closureEnds?: [string, string];
  flow: number; closedCap: number; displaced: number;
  alternatives: AltResult[];
  hotEdges: Edge[];
  overloaded: number; totalDelayVehH: number; avgExtraMin: number;
  critical: CriticalNode[]; signals: SignalRec[]; police: PoliceRec[];
}

export interface SimulationEngine { name: string; run(input: SimInput): SimResult }

export const ALT_COLORS = ["#0f766e", "#2563eb", "#9333ea"];

const bpr = (t0: number, vc: number) => t0 * (1 + 0.15 * Math.pow(vc, 4));
const classFactor = (hw: string) => (hw === "residential" ? 0.6 : hw === "tertiary" || hw === "unclassified" ? 0.8 : 1);
const edgeCap = (e: Edge, p: Params) => Math.max(200, e.lanes * p.capPerLane * classFactor(e.highway));
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1000) / 1000;
}

/** Кінці зв'язної ділянки: вузли, що зустрічаються в обраних ребрах рівно один раз. */
export function closureEndpoints(edges: Edge[]): string[] {
  const c = new Map<string, number>();
  for (const e of edges) for (const n of [e.from, e.to]) c.set(n, (c.get(n) ?? 0) + 1);
  return [...c].filter(([, n]) => n === 1).map(([n]) => n);
}

/** Для односторонньої ділянки: [вхід, вихід] за напрямком руху. */
function orderEnds(edges: Edge[], [a, b]: string[]): [string, string] {
  const inc = (n: string) => edges.find((e) => e.from === n || e.to === n)!;
  const ea = inc(a), eb = inc(b);
  if (ea.oneway) return ea.from === a ? [a, b] : [b, a];
  if (eb.oneway) return eb.from === b ? [b, a] : [a, b];
  return [a, b];
}

/** Прибирає маркери, що лежать ближче за minM метрів до вже залишених. */
function thin<T extends { pos: LatLng }>(items: T[], minM: number): T[] {
  const kept: T[] = [];
  for (const it of items) if (kept.every((k) => haversine(k.pos, it.pos) >= minM)) kept.push(it);
  return kept;
}

export function nodeLabel(g: Graph, nodeId: string): string {
  const names = [...new Set((g.adj.get(nodeId) ?? []).map((e) => e.name))].slice(0, 2);
  return names.length > 1 ? `${names[0]} / ${names[1]}` : names[0] ?? "перехрестя";
}

const empty = (error: string): SimResult => ({
  synthetic: true, mode: "local", odCount: 0, divergence: [], error, flow: 0, closedCap: 0, displaced: 0, alternatives: [], hotEdges: [],
  overloaded: 0, totalDelayVehH: 0, avgExtraMin: 0, critical: [], signals: [], police: [],
});

interface Group { path: Path; share: number; refTimeSec: number; refLen: number; diverge: string }

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Умовні поїздки "звідки-куди" з околиць входу й виходу ділянки. Ті, чий найкоротший шлях іде через
 * перекриття, перемаршрутизуються. Об'їзд починається там, де новий маршрут розходиться зі старим.
 */
function rerouteGroups(g: Graph, closedSet: Set<string>, entry: string, exit: string): { total: number; list: Group[] } {
  const rand = rng(42);
  const around = (center: LatLng) =>
    [...g.nodes].filter(([id, pos]) => g.out.has(id) && (() => { const d = haversine(pos, center); return d > 250 && d < 1800; })()).map(([id]) => id);
  const origins = around(g.nodes.get(entry)!), dests = around(g.nodes.get(exit)!);
  if (!origins.length || !dests.length) return { total: 0, list: [] };
  const noBlock = new Set<string>(), noPen = new Map<string, number>();
  const acc = new Map<string, { edges: Edge[]; n: number; refT: number; refL: number; diverge: string }>();
  let affected = 0;
  for (let k = 0; k < 500 && affected < 80; k++) {
    const o = origins[Math.floor(rand() * origins.length)], d = dests[Math.floor(rand() * dests.length)];
    if (o === d) continue;
    const p0 = shortestPath(g, o, d, noBlock, noPen);
    if (!p0 || !p0.edges.some((e) => closedSet.has(e.id))) continue;
    const p1 = shortestPath(g, o, d, closedSet, noPen);
    if (!p1) continue;
    const oldIds = new Set(p0.edges.map((e) => e.id)), newIds = new Set(p1.edges.map((e) => e.id));
    const newOnly = p1.edges.filter((e) => !oldIds.has(e.id));
    if (!newOnly.length) continue;
    const oldOnly = p0.edges.filter((e) => !newIds.has(e.id));
    const sig = newOnly.map((e) => e.id).join("|");
    const a = acc.get(sig) ?? {
      edges: newOnly, n: 0, diverge: p1.nodes[p1.edges.findIndex((e) => !oldIds.has(e.id))],
      refT: oldOnly.reduce((s, e) => s + freeFlowSec(e), 0), refL: oldOnly.reduce((s, e) => s + e.length, 0),
    };
    a.n++; acc.set(sig, a); affected++;
  }
  const list = [...acc.values()].sort((a, b) => b.n - a.n).map((a) => ({
    path: { nodes: [], edges: a.edges, length: a.edges.reduce((s, e) => s + e.length, 0), timeSec: a.edges.reduce((s, e) => s + freeFlowSec(e), 0) },
    share: a.n / affected, refTimeSec: a.refT, refLen: a.refL, diverge: a.diverge,
  }));
  return { total: affected, list };
}

export const HeuristicEngine: SimulationEngine = {
  name: "Heuristic BPR (synthetic)",
  run({ graph: g, closed, params: p }) {
    const closedEdges = closed.map((id) => g.edgeById.get(id)!).filter(Boolean);
    if (!closedEdges.length) return empty("Обери ділянку для перекриття на карті.");
    const ends = closureEndpoints(closedEdges);
    if (ends.length !== 2) return empty("Ділянка має бути суцільною (без розривів і розгалужень). Очисти вибір і познач її заново.");

    const [s0, t0n] = orderEnds(closedEdges, ends);
    const mult = TIME_MULT[p.time];
    const flow = p.demand * mult;
    const closedCap = Math.min(...closedEdges.map((e) => edgeCap(e, p)));
    const remaining = p.closurePct >= 100 ? 0 : closedCap * (1 - p.closurePct / 100);
    const displaced = Math.max(0, flow - remaining);
    const closedTimeSec = closedEdges.reduce((s, e) => s + freeFlowSec(e), 0);

    // Основний режим: перемаршрутизація умовних поїздок здалеку. Запасний: локальний обхід між кінцями ділянки.
    const closedLen = closedEdges.reduce((s, e) => s + e.length, 0);
    let { total: odCount, list } = rerouteGroups(g, new Set(closed), s0, t0n);
    let mode: "od" | "local" = "od";
    if (odCount < 5) {
      mode = "local"; odCount = 0;
      const paths = alternativePaths(g, s0, t0n, new Set(closed), 3);
      if (!paths.length) return { ...empty("Об'їзд у межах завантаженої мережі не знайдено. Спробуй іншу ділянку."), closureEnds: [s0, t0n], flow, closedCap, displaced };
      // Логіт: швидші об'їзди отримують більшу частку витісненого потоку.
      const w = paths.map((pt) => Math.exp(-4 * (pt.timeSec / paths[0].timeSec - 1)));
      const wSum = w.reduce((x, y) => x + y, 0);
      list = paths.map((pt, i) => ({ path: pt, share: w[i] / wSum, refTimeSec: closedTimeSec, refLen: closedLen, diverge: s0 }));
    }

    const load = new Map<string, { e: Edge; bg: number; add: number; cap: number }>();
    for (const gr of list) {
      for (const e of gr.path.edges) {
        let r = load.get(e.id);
        if (!r) {
          const cap = edgeCap(e, p);
          const bg = Math.min(1.1 * cap, cap * p.bgLoad * mult * (0.7 + 0.6 * hash01(e.id)));
          r = { e, bg, add: 0, cap };
          load.set(e.id, r);
        }
        r.add += displaced * gr.share;
      }
    }
    const vcTot = (id: string) => { const r = load.get(id)!; return (r.bg + r.add) / r.cap; };

    let totalDelaySec = 0, overloaded = 0;
    const hotEdges: Edge[] = [];
    for (const r of load.values()) {
      const t0e = freeFlowSec(r.e);
      totalDelaySec += (r.bg + r.add) * bpr(t0e, (r.bg + r.add) / r.cap) - r.bg * bpr(t0e, r.bg / r.cap);
      if (r.add > 0 && (r.bg + r.add) / r.cap > 0.9) { overloaded++; hotEdges.push(r.e); }
    }

    const extraMinOf = (gr: Group) =>
      (gr.path.edges.reduce((s, e) => s + bpr(freeFlowSec(e), vcTot(e.id)), 0) - gr.refTimeSec) / 60;
    const alternatives: AltResult[] = list.slice(0, 3).map((gr, i) => ({
      index: i, path: gr.path, share: gr.share, color: ALT_COLORS[i % ALT_COLORS.length],
      extraKm: (gr.path.length - gr.refLen) / 1000,
      extraMin: extraMinOf(gr),
      maxVc: Math.max(...gr.path.edges.map((e) => vcTot(e.id))),
    }));
    const avgExtraMin = list.reduce((s, gr) => s + gr.share * extraMinOf(gr), 0);

    const dv = new Map<string, number>();
    for (const gr of list) dv.set(gr.diverge, (dv.get(gr.diverge) ?? 0) + gr.share);
    const divergence: DivergencePoint[] = [...dv].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([n, share]) => ({ pos: g.nodes.get(n)!, label: nodeLabel(g, n), share }));

    // Вузли на об'їздах з найвищим v/c на інцидентних ребрах.
    const nodeVc = new Map<string, number>();
    for (const r of load.values()) {
      const vc = (r.bg + r.add) / r.cap;
      for (const n of [r.e.from, r.e.to]) nodeVc.set(n, Math.max(nodeVc.get(n) ?? 0, vc));
    }
    const critical: CriticalNode[] = thin(
      [...nodeVc]
        .filter(([, vc]) => vc >= 0.75)
        .sort((a, b) => b[1] - a[1])
        .map(([nodeId, vc]) => ({ nodeId, pos: g.nodes.get(nodeId)!, label: nodeLabel(g, nodeId), vc, hasSignal: g.signals.has(nodeId) })),
      120
    ).slice(0, 5);

    const signals: SignalRec[] = critical.map((c) => {
      const delta = clamp(Math.round((c.vc - 0.75) * 40), 4, 20);
      return {
        pos: c.pos, label: c.label,
        text: c.hasSignal
          ? `Світлофор (є в OSM): +${delta} с зеленого для напрямку об'їзду, −${delta} с для поперечного. Базовий цикл 90 с — припущення.`
          : `Світлофора в OSM немає. Перевір, чи потрібне тимчасове регулювання або пріоритет для напрямку об'їзду.`,
      };
    });

    let police: PoliceRec[] = critical
      .filter((c) => c.vc >= 0.95 || ((g.adj.get(c.nodeId)?.length ?? 0) >= 4 && c.vc >= 0.85))
      .map((c) => ({ pos: c.pos, label: c.label, reason: `v/c ≈ ${c.vc.toFixed(2)}: розглянути ручне регулювання в піковий час.` }));
    if (displaced > 0) {
      for (const d of divergence.slice(0, 2).reverse()) {
        police.unshift({ pos: d.pos, label: d.label, reason: `Точка розгалуження об'їзду (~${Math.round(d.share * 100)}% об'їжджаючих): знаки, табло або регулювальник.` });
      }
    }

    police = thin(police, 200).slice(0, 4);

    return { synthetic: true, mode, odCount, divergence, closureEnds: [s0, t0n], flow, closedCap, displaced, alternatives, hotEdges,
      overloaded, totalDelayVehH: totalDelaySec / 3600, avgExtraMin, critical, signals, police };
  },
};
