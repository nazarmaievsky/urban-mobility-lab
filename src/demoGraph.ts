// Синтетична демо-мережа (НЕ реальні вулиці): дозволяє перевірити інтерфейс і модель без Overpass.
import { CompactOsm, LatLng } from "./graph";

const ROWS = 8, COLS = 10;
const DLAT = 0.0014, DLON = 0.0022;

const rnd = (i: number, j: number, k: number) => {
  const x = Math.sin(i * 127.1 + j * 311.7 + k * 74.7) * 43758.5453;
  return x - Math.floor(x);
};

export function demoOsm(center: LatLng): CompactOsm {
  const nodes: CompactOsm["nodes"] = [];
  const id = (i: number, j: number) => `d${i}_${j}`;
  for (let i = 0; i < ROWS; i++) {
    for (let j = 0; j < COLS; j++) {
      const lat = center[0] + (i - (ROWS - 1) / 2) * DLAT + (rnd(i, j, 1) - 0.5) * 0.0004;
      const lon = center[1] + (j - (COLS - 1) / 2) * DLON + (rnd(i, j, 2) - 0.5) * 0.0006;
      const signal = i === 3 && j % 3 === 0 ? 1 : 0; // світлофори на головній вулиці
      nodes.push([id(i, j), lat, lon, signal]);
    }
  }
  const ways: CompactOsm["ways"] = [];
  for (let i = 0; i < ROWS; i++) {
    ways.push({
      id: `row${i}`, nodes: Array.from({ length: COLS }, (_, j) => id(i, j)),
      hw: i === 3 ? "primary" : i % 3 === 0 ? "secondary" : "residential",
      name: i === 3 ? "Демо-проспект" : `Демо-вулиця Р${i + 1}`, lanes: 0, oneway: 0,
    });
  }
  for (let j = 0; j < COLS; j++) {
    ways.push({
      id: `col${j}`, nodes: Array.from({ length: ROWS }, (_, i) => id(i, j)),
      hw: j % 3 === 0 ? "secondary" : j % 3 === 1 ? "tertiary" : "residential",
      name: `Демо-вулиця К${j + 1}`, lanes: 0, oneway: 0,
    });
  }
  return { nodes, ways };
}
