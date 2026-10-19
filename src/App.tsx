import { useCallback, useEffect, useMemo, useState } from "react";
import MapView from "./MapView";
import { Graph, buildGraph } from "./graph";
import { demoOsm } from "./demoGraph";
import { MAP_CENTER, loadGraph, osrmBaselineMinutes } from "./roadNetwork";
import {
  HeuristicEngine, Params, SimResult, TIME_LABEL, TimeOfDay, closureEndpoints,
} from "./simulation";

const engine = HeuristicEngine; // пізніше: SumoEngine з тим самим інтерфейсом

const DEFAULTS: Params = { demand: 1200, capPerLane: 1200, time: "morning", bgLoad: 0.45, closurePct: 100 };

export default function App() {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [status, setStatus] = useState("Завантажую вулиці Львова з OpenStreetMap…");
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useState<Params>(DEFAULTS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<SimResult | null>(null);
  const [osrmMin, setOsrmMin] = useState<number | null>(null);
  const [isDemo, setIsDemo] = useState(false);

  const load = useCallback(async (force: boolean) => {
    setError(null); setGraph(null); setResult(null); setSelected(new Set()); setIsDemo(false);
    setStatus("Завантажую вулиці Львова з OpenStreetMap…");
    try {
      const { graph, fromCache } = await loadGraph(force);
      setGraph(graph);
      setStatus(`${graph.edges.length} сегментів доріг, ${graph.signals.size} світлофорів в OSM${fromCache ? " (з кешу)" : ""}`);
    } catch (e) {
      setError(String(e));
    }
  }, []);
  useEffect(() => { load(false); }, [load]);

  const showDemo = () => {
    const g = buildGraph(demoOsm(MAP_CENTER));
    setError(null); setResult(null); setSelected(new Set()); setIsDemo(true); setGraph(g);
    setStatus(`Демо-мережа: синтетична геометрія (не реальні вулиці), ${g.edges.length} сегментів`);
  };

  const toggle = useCallback((id: string) => {
    setResult(null);
    setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }, []);

  const closedEdges = useMemo(
    () => (graph ? [...selected].map((id) => graph.edgeById.get(id)!).filter(Boolean) : []),
    [graph, selected]
  );
  const ends = closureEndpoints(closedEdges);
  const valid = closedEdges.length > 0 && ends.length === 2;
  const lengthM = closedEdges.reduce((s, e) => s + e.length, 0);
  const names = [...new Set(closedEdges.map((e) => e.name))].join(", ");

  // Додати сусідній сегмент тієї ж вулиці з обох кінців ділянки (по 3 кроки).
  const extend = () => {
    if (!graph || !valid) return;
    const next = new Set(selected);
    for (let step = 0; step < 3; step++) {
      const cur = [...next].map((id) => graph.edgeById.get(id)!);
      for (const n of closureEndpoints(cur)) {
        const name = cur.find((e) => e.from === n || e.to === n)?.name;
        const cand = (graph.adj.get(n) ?? []).filter((e) => !next.has(e.id) && e.name === name);
        if (cand.length === 1) next.add(cand[0].id);
      }
    }
    setResult(null); setSelected(next);
  };

  const run = () => {
    if (!graph) return;
    const r = engine.run({ graph, closed: [...selected], params });
    setResult(r);
    setOsrmMin(null);
    if (!isDemo && !r.error && r.closureEnds) {
      osrmBaselineMinutes(graph.nodes.get(r.closureEnds[0])!, graph.nodes.get(r.closureEnds[1])!).then(setOsrmMin);
    }
  };

  const set = <K extends keyof Params>(k: K, v: Params[K]) => { setParams((p) => ({ ...p, [k]: v })); setResult(null); };

  return (
    <div className="app">
      <aside className="panel">
        <header>
          <h1>Urban Mobility Scenario Lab</h1>
          <p className="sub">Прототип: реальні вулиці OSM, синтетична модель трафіку</p>
        </header>

        <section>
          <h2>1. Ділянка перекриття</h2>
          {error ? (
            <p className="err">{error}</p>
          ) : (
            <p className="muted">{status}</p>
          )}
          <div className="row">
            {error && <button onClick={() => load(true)}>Спробувати ще раз</button>}
            <button onClick={showDemo}>Демо-мережа (без інтернету)</button>
          </div>
          {closedEdges.length === 0 ? (
            <p>Клікни на вулицю на карті. Повторний клік знімає сегмент.</p>
          ) : (
            <p><b>{names}</b>, {Math.round(lengthM)} м, сегментів: {closedEdges.length}
              {!valid && <span className="err"> Ділянка має бути суцільною.</span>}</p>
          )}
          <div className="row">
            <button onClick={extend} disabled={!valid}>Розширити вздовж вулиці</button>
            <button onClick={() => { setSelected(new Set()); setResult(null); }} disabled={!selected.size}>Очистити</button>
          </div>
        </section>

        <section>
          <h2>2. Трафік</h2>
          <Slider label="Попит на ділянці" unit="авто/год" min={100} max={3000} step={50} value={params.demand} onChange={(v) => set("demand", v)} />
          <Slider label="Пропускна здатність смуги" unit="авто/год" min={600} max={1800} step={50} value={params.capPerLane} onChange={(v) => set("capPerLane", v)} />
          <Slider label="Закрита частка ділянки" unit="%" min={50} max={100} step={10} value={params.closurePct} onChange={(v) => set("closurePct", v)} />
          <Slider label="Фонове завантаження мережі" unit="%" min={10} max={80} step={5} value={Math.round(params.bgLoad * 100)} onChange={(v) => set("bgLoad", v / 100)} />
          <label className="field">
            <span>Час доби</span>
            <select value={params.time} onChange={(e) => set("time", e.target.value as TimeOfDay)}>
              {Object.entries(TIME_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <button className="primary" onClick={run} disabled={!valid || !graph}>Запустити симуляцію</button>
        </section>

        {result && <Results result={result} osrmMin={osrmMin} />}
      </aside>
      <MapView graph={graph} selected={selected} onToggle={toggle} result={result} />
    </div>
  );
}

function Slider(p: { label: string; unit: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  return (
    <label className="field">
      <span>{p.label}: <b>{p.value} {p.unit}</b></span>
      <input type="range" min={p.min} max={p.max} step={p.step} value={p.value} onChange={(e) => p.onChange(Number(e.target.value))} />
    </label>
  );
}

function Results({ result: r, osrmMin }: { result: SimResult; osrmMin: number | null }) {
  if (r.error) return <section><p className="err">{r.error}</p></section>;
  return (
    <section>
      <div className="badge">Синтетична оцінка: не прогноз і не результат реальної симуляції</div>
      <h2>Результат</h2>
      <dl className="kpis">
        <div><dt>Потік на ділянці</dt><dd>{Math.round(r.flow)} авто/год</dd></div>
        <div><dt>Витіснено на об'їзди</dt><dd>{Math.round(r.displaced)} авто/год</dd></div>
        <div><dt>Додатковий час на об'їзді</dt><dd>~{r.avgExtraMin.toFixed(1)} хв</dd></div>
        <div><dt>Сумарна затримка</dt><dd>~{r.totalDelayVehH.toFixed(1)} авто·год/год</dd></div>
        <div><dt>Перевантажені сегменти</dt><dd>{r.overloaded}</dd></div>
      </dl>

      <p className="muted">
        {r.mode === "od"
          ? `Об'їзди розраховано для ${r.odCount} умовних поїздок «звідки-куди» з околиць ділянки: водії розходяться зі звичного маршруту там, де об'їзд починається, а не лише біля самого перекриття.`
          : "Умовних поїздок через ділянку замало, тому показано лише локальний обхід між кінцями ділянки."}
      </p>
      {r.divergence.length > 0 && (<>
        <h3>Де об'їзд має починатися 🔀</h3>
        <ul>{r.divergence.map((d, i) => <li key={i}><b>{d.label}</b>: ~{Math.round(d.share * 100)}% об'їжджаючих</li>)}</ul>
      </>)}
      <h3>Варіанти об'їзду</h3>
      <table>
        <thead><tr><th></th><th>Частка</th><th>+км</th><th>+хв</th><th>макс v/c</th></tr></thead>
        <tbody>
          {r.alternatives.map((a) => (
            <tr key={a.index}>
              <td><span className="dot" style={{ background: a.color }} />Об'їзд {a.index + 1}</td>
              <td>{Math.round(a.share * 100)}%</td><td>{a.extraKm.toFixed(2)}</td>
              <td>{a.extraMin.toFixed(1)}</td><td className={a.maxVc > 0.9 ? "bad" : ""}>{a.maxVc.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {osrmMin !== null && <p className="muted">Для порівняння: звичайний навігатор (OSRM, без урахування перекриття) веде між тими самими точками за {osrmMin.toFixed(1)} хв.</p>}

      <h3>Світлофори</h3>
      {r.signals.length === 0 ? <p className="muted">Критичних перехресть на об'їздах не виявлено.</p> :
        <ul>{r.signals.map((s, i) => <li key={i}><b>{s.label}</b><br />{s.text}</li>)}</ul>}

      <h3>Де розглянути ручне регулювання</h3>
      {r.police.length === 0 ? <p className="muted">Таких точок немає.</p> :
        <ul>{r.police.map((p, i) => <li key={i}><b>{p.label}</b><br />{p.reason}</li>)}</ul>}
      <p className="muted">Це підказка для планування, а не автоматичний виклик патруля.</p>
    </section>
  );
}
