// Евристична СИНТЕТИЧНА модель. Це не транспортна симуляція і не калібрована на реальних даних.
// Ідея: BPR-функція затримки + логіт-розподіл витісненого потоку по об'їздах.
import { Edge, Graph, LatLng, Path, alternativePaths, freeFlowSec, otherEnd } from "./graph";

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

export interface SimResult {
  synthetic: true;
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

export function nodeLabel(g: Graph, nodeId: string): string {
  const names = [...new Set((g.adj.get(nodeId) ?? []).map((e) => e.name))].slice(0, 2);
  return names.length > 1 ? `${names[0]} / ${names[1]}` : names[0] ?? "перехрестя";
}

const empty = (error: string): SimResult => ({
  synthetic: true, error, flow: 0, closedCap: 0, displaced: 0, alternatives: [], hotEdges: [],
  overloaded: 0, totalDelayVehH: 0, avgExtraMin: 0, critical: [], signals: [], police: [],
});

export const HeuristicEngine: SimulationEngine = {
  name: "Heuristic BPR (synthetic)",
  run({ graph: g, closed, params: p }) {
    const closedEdges = closed.map((id) => g.edgeById.get(id)!).filter(Boolean);
    if (!closedEdges.length) return empty("Обери ділянку для перекриття на карті.");
    const ends = closureEndpoints(closedEdges);
    if (ends.length !== 2) return empty("Ділянка має бути суцільною (без розривів і розгалужень). Очисти вибір і познач її заново.");

    const mult = TIME_MULT[p.time];
    const flow = p.demand * mult;
    const closedCap = Math.min(...closedEdges.map((e) => edgeCap(e, p)));
    const remaining = p.closurePct >= 100 ? 0 : closedCap * (1 - p.closurePct / 100);
    const displaced = Math.max(0, flow - remaining);
    const closedTimeSec = closedEdges.reduce((s, e) => s + freeFlowSec(e), 0);

    // Об'їзд завжди шукаємо повз ділянку. При частковому перекритті частина потоку лишається на ній.
    const paths = alternativePaths(g, ends[0], ends[1], new Set(closed), 3);
    if (!paths.length) return { ...empty("Об'їзд у межах завантаженої мережі не знайдено. Спробуй іншу ділянку."), closureEnds: [ends[0], ends[1]], flow, closedCap, displaced };

    // Логіт: швидші об'їзди отримують більшу частку витісненого потоку.
    const t0 = paths[0].timeSec;
    const w = paths.map((pt) => Math.exp(-4 * (pt.timeSec / t0 - 1)));
    const wSum = w.reduce((a, b) => a + b, 0);
    const shares = w.map((x) => x / wSum);

    const load = new Map<string, { e: Edge; bg: number; add: number; cap: number }>();
    paths.forEach((pt, i) => {
      for (const e of pt.edges) {
        let r = load.get(e.id);
        if (!r) {
          const cap = edgeCap(e, p);
          const bg = Math.min(1.1 * cap, cap * p.bgLoad * mult * (0.7 + 0.6 * hash01(e.id)));
          r = { e, bg, add: 0, cap };
          load.set(e.id, r);
        }
        r.add += displaced * shares[i];
      }
    });
    const vcTot = (id: string) => { const r = load.get(id)!; return (r.bg + r.add) / r.cap; };

    let totalDelaySec = 0, overloaded = 0;
    const hotEdges: Edge[] = [];
    for (const r of load.values()) {
      const t0e = freeFlowSec(r.e);
      totalDelaySec += (r.bg + r.add) * bpr(t0e, (r.bg + r.add) / r.cap) - r.bg * bpr(t0e, r.bg / r.cap);
      if (r.add > 0 && (r.bg + r.add) / r.cap > 0.9) { overloaded++; hotEdges.push(r.e); }
    }

    const alternatives: AltResult[] = paths.map((pt, i) => {
      const congSec = pt.edges.reduce((s, e) => s + bpr(freeFlowSec(e), vcTot(e.id)), 0);
      return {
        index: i, path: pt, share: shares[i], color: ALT_COLORS[i % ALT_COLORS.length],
        extraKm: (pt.length - closedEdges.reduce((s, e) => s + e.length, 0)) / 1000,
        extraMin: (congSec - closedTimeSec) / 60,
        maxVc: Math.max(...pt.edges.map((e) => vcTot(e.id))),
      };
    });
    const avgExtraMin = alternatives.reduce((s, a) => s + a.share * a.extraMin, 0);

    // Вузли на об'їздах з найвищим v/c на інцидентних ребрах.
    const nodeVc = new Map<string, number>();
    for (const r of load.values()) {
      const vc = (r.bg + r.add) / r.cap;
      for (const n of [r.e.from, r.e.to]) nodeVc.set(n, Math.max(nodeVc.get(n) ?? 0, vc));
    }
    const critical: CriticalNode[] = [...nodeVc]
      .filter(([, vc]) => vc >= 0.75)
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([nodeId, vc]) => ({ nodeId, pos: g.nodes.get(nodeId)!, label: nodeLabel(g, nodeId), vc, hasSignal: g.signals.has(nodeId) }));

    const signals: SignalRec[] = critical.map((c) => {
      const delta = clamp(Math.round((c.vc - 0.75) * 40), 4, 20);
      return {
        pos: c.pos, label: c.label,
        text: c.hasSignal
          ? `Світлофор (є в OSM): +${delta} с зеленого для напрямку об'їзду, −${delta} с для поперечного. Базовий цикл 90 с — припущення.`
          : `Світлофора в OSM немає. Перевір, чи потрібне тимчасове регулювання або пріоритет для напрямку об'їзду.`,
      };
    });

    const police: PoliceRec[] = critical
      .filter((c) => c.vc >= 0.95 || ((g.adj.get(c.nodeId)?.length ?? 0) >= 4 && c.vc >= 0.85))
      .map((c) => ({ pos: c.pos, label: c.label, reason: `v/c ≈ ${c.vc.toFixed(2)}: розглянути ручне регулювання в піковий час.` }));
    if (displaced > 0) {
      police.unshift({ pos: g.nodes.get(ends[0])!, label: nodeLabel(g, ends[0]), reason: "Початок об'їзду: контроль дотримання перекриття і навігація водіїв." });
    }

    return { synthetic: true, closureEnds: [ends[0], ends[1]], flow, closedCap, displaced, alternatives, hotEdges,
      overloaded, totalDelayVehH: totalDelaySec / 3600, avgExtraMin, critical, signals, police };
  },
};
