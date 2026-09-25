'use client';

import { useState } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  ReferenceDot,
} from 'recharts';
import { format, parseISO } from 'date-fns';
import { fr } from 'date-fns/locale';
import { TrendingUp, TrendingDown } from 'lucide-react';

interface Snapshot {
  total_value_eur: number;
  cash_eur: number;
  crypto_value_eur: number;
  pnl_eur: number;
  pnl_percent: number;
  snapshotted_at: string;
}

interface TradeMarker {
  executed_at: string;
  action: string;
  symbol: string;
}

interface BenchPoint {
  t: number;
  v: number;
}

interface Props {
  snapshots: Snapshot[];
  initialValue?: number;
  // Valeur live actuelle : ajoutée comme dernier point pour que le graphique
  // affiche toujours la réalité (même sans snapshots, ex: juste après un reset).
  currentValue?: number;
  currentCash?: number;
  currentCrypto?: number;
  // Trades à marquer sur la courbe (points verts/rouges)
  trades?: TradeMarker[];
  // Benchmark BTC normalisé (base 100), superposé en pointillés
  benchmark?: BenchPoint[] | null;
}

interface ChartPoint {
  date: string;
  ts: number;
  value: number;
  cash: number;
  crypto: number;
  btc?: number;
}

const fmtDate = (ts: number) => format(new Date(ts), 'dd/MM HH:mm', { locale: fr });

// Valeur au point le plus proche <= cible (ou null si historique trop court)
function valueAtOrBefore(points: Array<{ ts: number; value: number }>, targetTs: number): number | null {
  let best: { ts: number; value: number } | null = null;
  for (const p of points) {
    if (p.ts <= targetTs) best = p;
    else break;
  }
  return best ? best.value : null;
}

function nearestBench(bench: BenchPoint[], ts: number): number | undefined {
  if (bench.length === 0) return undefined;
  let best = bench[0];
  let bestDist = Math.abs(bench[0].t - ts);
  for (const b of bench) {
    const d = Math.abs(b.t - ts);
    if (d < bestDist) { best = b; bestDist = d; }
  }
  return best.v;
}

const CustomTooltip = ({ active, payload, label, initialValue }: {
  active?: boolean;
  payload?: Array<{ value: number; payload: { cash: number; crypto: number; btc?: number }; dataKey?: string | number }>;
  label?: string;
  initialValue?: number;
}) => {
  if (active && payload && payload.length) {
    const main = payload.find(p => p.dataKey === 'value') ?? payload[0];
    const value = main?.value ?? 0;
    const init = initialValue ?? 5000;
    const pnl = value - init;
    const pnlPct = (pnl / init) * 100;
    const cash = main?.payload?.cash ?? 0;
    const crypto = main?.payload?.crypto ?? 0;
    const btc = payload.find(p => p.dataKey === 'btc')?.value;

    return (
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-3 shadow-2xl min-w-[180px]">
        <p className="text-gray-400 text-xs mb-2">{label}</p>
        <p className="text-white font-bold text-lg">{value.toFixed(2)}€</p>
        <p className={`text-sm font-semibold mb-2 ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}€ ({pnl >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%)
        </p>
        {btc !== undefined && (
          <p className="text-xs text-orange-400/90 mb-2">BTC (base 100): {btc.toFixed(1)}</p>
        )}
        <div className="border-t border-gray-700/50 pt-2 space-y-1">
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">💵 Cash</span>
            <span className="text-gray-300">{cash.toFixed(0)}€</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">📈 Crypto</span>
            <span className="text-gray-300">{crypto.toFixed(0)}€</span>
          </div>
        </div>
      </div>
    );
  }
  return null;
};

const RANGES = [
  { key: '1d', label: 'Jour', ms: 24 * 3600 * 1000 },
  { key: '7d', label: 'Sem.', ms: 7 * 24 * 3600 * 1000 },
  { key: '30d', label: 'Mois', ms: 30 * 24 * 3600 * 1000 },
  { key: '1y', label: 'Année', ms: 365 * 24 * 3600 * 1000 },
  { key: 'all', label: 'Tout', ms: Infinity },
] as const;

export default function PortfolioChart({ snapshots, initialValue = 5000, currentValue: liveValue, currentCash, currentCrypto, trades = [], benchmark = null }: Props) {
  const [rangeKey, setRangeKey] = useState<string>('all');
  // Filter outliers: remove snapshots where value is less than 20% of initial
  // These are likely data errors or mid-transaction snapshots
  const minValid = initialValue * 0.20;
  const validSnapshots = snapshots.filter(s =>
    parseFloat(String(s.total_value_eur)) > minValid
  );

  const now = Date.now();
  const data: ChartPoint[] = validSnapshots.map(s => {
    const ts = parseISO(s.snapshotted_at).getTime();
    return {
      date: fmtDate(ts),
      ts,
      value: parseFloat(String(s.total_value_eur)),
      cash: parseFloat(String(s.cash_eur)),
      crypto: parseFloat(String(s.crypto_value_eur)),
    };
  });

  if (data.length === 0) {
    data.push({
      date: 'Départ',
      ts: now,
      value: initialValue,
      cash: initialValue,
      crypto: 0,
    });
  }

  // Toujours terminer par la valeur live : le graphique affiche les mêmes
  // montants que les cartes KPI, même si les snapshots sont vides ou en retard
  if (liveValue !== undefined && Number.isFinite(liveValue)) {
    const last = data[data.length - 1];
    if (last.date !== 'Actuel') {
      data.push({
        date: 'Actuel',
        ts: now,
        value: liveValue,
        cash: currentCash ?? last.cash,
        crypto: currentCrypto ?? last.crypto,
      });
    } else {
      last.value = liveValue;
      last.ts = now;
      if (currentCash !== undefined) last.cash = currentCash;
      if (currentCrypto !== undefined) last.crypto = currentCrypto;
    }
  }

  // Benchmark BTC superposé (indice base 100, axe droit masqué)
  const bench = (benchmark ?? []).slice().sort((a, b) => a.t - b.t);
  const showBench = bench.length >= 5;
  if (showBench) {
    for (const d of data) d.btc = nearestBench(bench, d.ts);
  }

  // --- Fenêtre temporelle (zoom Jour/Sem/Mois/Année/Tout) ---
  const rangeMs = RANGES.find(r => r.key === rangeKey)?.ms ?? Infinity;
  const isAll = rangeKey === 'all';
  const start = isAll ? -Infinity : now - (rangeMs as number);
  // Point de référence : dernier point réel au début de période (pour un P&L exact)
  const boundary = !isAll ? [...data].reverse().find(d => d.ts <= start) : undefined;
  let view = isAll ? data : data.filter(d => d.ts >= start);
  if (!isAll && boundary && !view.includes(boundary)) {
    view = [boundary, ...view];
  }
  if (view.length === 0) view = data.slice(-1);

  const values = view.map(d => d.value);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const currentValue = values[values.length - 1];
  // Référence de rentabilité : début de période (ou mise initiale en mode Tout)
  const refValue = isAll ? initialValue : (boundary?.value ?? values[0] ?? initialValue);
  const pnl = currentValue - refValue;
  const pnlPct = refValue > 0 ? (pnl / refValue) * 100 : 0;
  const isPositive = pnl >= 0;
  const rangeLabel = RANGES.find(r => r.key === rangeKey)?.label ?? '';

  // BTC sur la même période (comparaison "toi vs hold BTC")
  let btcRangePct: number | null = null;
  if (showBench) {
    const benchStart = isAll ? bench[0].t : start;
    const refB = valueAtOrBefore(bench.map(b => ({ ts: b.t, value: b.v })), benchStart);
    const lastB = bench[bench.length - 1].v;
    if (refB !== null && refB > 0) btcRangePct = ((lastB - refB) / refB) * 100;
  }

  // Smart Y-axis sur la fenêtre : ancré à la mise initiale seulement en mode Tout
  const lo = isAll ? Math.min(minValue, initialValue) : minValue;
  const hi = isAll ? Math.max(maxValue, initialValue) : maxValue;
  const range = hi - lo;
  const padding = Math.max(range * 0.15, (isAll ? initialValue : currentValue) * 0.005);
  const yMin = Math.max(0, lo - padding);
  const yMax = hi + padding;

  const btcVals = showBench ? view.map(d => d.btc ?? 100) : [];
  const yBtcMin = showBench ? Math.min(...btcVals) : 0;
  const yBtcMax = showBench ? Math.max(...btcVals) : 100;
  const btcPad = Math.max((yBtcMax - yBtcMin) * 0.15, 1);

  const strokeColor = isPositive ? '#10b981' : '#ef4444';
  const gradientId = isPositive ? 'gradientGreen' : 'gradientRed';

  // Reduce label density for readability
  const tickInterval = view.length <= 10 ? 0 : view.length <= 30 ? 4 : Math.floor(view.length / 8);

  // Marqueurs buy/sell : rattachés au point le plus proche dans le temps (25 derniers),
  // limités à la fenêtre visible
  const viewLabels = new Set(view.map(d => d.date));
  const markers = trades.slice(-25).map(t => {
    const ts = new Date(t.executed_at).getTime();
    if (!Number.isFinite(ts)) return null;
    let best = data[0];
    let bestDist = Math.abs(data[0].ts - ts);
    for (const d of data) {
      const dist = Math.abs(d.ts - ts);
      if (dist < bestDist) { best = d; bestDist = dist; }
    }
    if (!viewLabels.has(best.date)) return null;
    const isBuy = t.action === 'BUY';
    return { x: best.date, y: best.value, isBuy, symbol: t.symbol };
  }).filter((m): m is { x: string; y: number; isBuy: boolean; symbol: string } => m !== null);

  return (
    <div className="space-y-3">
      {/* Mini stats bar — chiffres adaptés à la période sélectionnée */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-bold ${
            isPositive ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'
          }`}>
            {isPositive
              ? <TrendingUp className="w-4 h-4" />
              : <TrendingDown className="w-4 h-4" />
            }
            {isPositive ? '+' : ''}{pnl.toFixed(2)}€
          </div>
          <span className={`text-sm font-semibold ${isPositive ? 'text-green-400' : 'text-red-400'}`}>
            ({isPositive ? '+' : ''}{pnlPct.toFixed(2)}%{isAll ? '' : ` · ${rangeLabel}`})
          </span>
          {btcRangePct !== null && (
            <span className="text-xs text-gray-400 bg-gray-800/60 rounded-lg px-2 py-1">
              BTC {btcRangePct >= 0 ? '+' : ''}{btcRangePct.toFixed(1)}%{isAll ? '' : ` · ${rangeLabel}`}
            </span>
          )}
        </div>
        <div className="text-right">
          <div className="text-white font-bold text-lg">{currentValue.toFixed(2)}€</div>
          <div className="text-gray-500 text-xs">Valeur actuelle</div>
        </div>
      </div>

      {/* Sélecteur de période (zoom) */}
      <div className="flex items-center gap-1.5">
        {RANGES.map(r => (
          <button
            key={r.key}
            onClick={() => setRangeKey(r.key)}
            className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
              rangeKey === r.key
                ? 'bg-blue-500/20 text-blue-300'
                : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/60'
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      {/* Légende */}
      <div className="flex items-center gap-4 text-xs text-gray-500">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-4 h-0.5 rounded" style={{ background: strokeColor }} /> Portefeuille
        </span>
        {showBench && (
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-4 border-t-2 border-dashed border-orange-400" /> BTC (base 100)
          </span>
        )}
        {markers.length > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-full bg-green-400" />
            <span className="inline-block w-2 h-2 rounded-full bg-red-400" />
            Trades
          </span>
        )}
      </div>

      {/* Chart */}
      <div className="w-full h-72">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={view} margin={{ top: 10, right: 5, left: 5, bottom: 5 }}>
            <defs>
              <linearGradient id="gradientGreen" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#10b981" stopOpacity={0.25} />
                <stop offset="60%" stopColor="#10b981" stopOpacity={0.05} />
                <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="gradientRed" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#ef4444" stopOpacity={0.25} />
                <stop offset="60%" stopColor="#ef4444" stopOpacity={0.05} />
                <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
              </linearGradient>
            </defs>

            <CartesianGrid
              strokeDasharray="3 3"
              stroke="#1f2937"
              vertical={false}
            />

            <XAxis
              dataKey="date"
              tick={{ fill: '#4b5563', fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: '#1f2937' }}
              interval={tickInterval}
            />

            <YAxis
              yAxisId="left"
              domain={[yMin, yMax]}
              tick={{ fill: '#4b5563', fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={v => `${v.toFixed(0)}€`}
              width={58}
            />
            {showBench && (
              <YAxis yAxisId="right" orientation="right" hide domain={[yBtcMin - btcPad, yBtcMax + btcPad]} />
            )}

            <Tooltip
              content={
                <CustomTooltip initialValue={initialValue} />
              }
            />

            {/* Initial investment reference line (mode Tout uniquement) */}
            {isAll && (
              <ReferenceLine
                yAxisId="left"
                y={initialValue}
                stroke="#374151"
                strokeDasharray="6 3"
                label={{
                  value: `Initial: ${initialValue}€`,
                  fill: '#4b5563',
                  fontSize: 10,
                  position: 'insideTopRight',
                }}
              />
            )}

            {/* Current value reference line */}
            {refValue > 0 && Math.abs(currentValue - refValue) > refValue * 0.005 && (
              <ReferenceLine
                yAxisId="left"
                y={currentValue}
                stroke={strokeColor}
                strokeDasharray="3 3"
                strokeOpacity={0.4}
              />
            )}

            <Area
              yAxisId="left"
              type="monotone"
              dataKey="value"
              stroke={strokeColor}
              strokeWidth={2.5}
              fill={`url(#${gradientId})`}
              dot={false}
              activeDot={{
                r: 5,
                fill: strokeColor,
                stroke: '#111827',
                strokeWidth: 2,
              }}
            />
            {showBench && (
              <Area
                yAxisId="right"
                type="monotone"
                dataKey="btc"
                stroke="#f59e0b"
                strokeWidth={1.5}
                strokeDasharray="5 4"
                fill="none"
                dot={false}
                activeDot={{ r: 3, fill: '#f59e0b', stroke: '#111827', strokeWidth: 2 }}
              />
            )}
            {markers.map((m, i) => (
              <ReferenceDot
                key={`${m.x}-${i}`}
                yAxisId="left"
                x={m.x}
                y={m.y}
                r={4}
                fill={m.isBuy ? '#10b981' : '#ef4444'}
                stroke="#111827"
                strokeWidth={1.5}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Bottom stats */}
      <div className="grid grid-cols-3 gap-2 pt-1">
        <div className="text-center">
          <div className="text-gray-500 text-xs mb-0.5">Plus haut</div>
          <div className="text-white text-sm font-semibold">{maxValue.toFixed(2)}€</div>
        </div>
        <div className="text-center">
          <div className="text-gray-500 text-xs mb-0.5">Mise initiale</div>
          <div className="text-gray-400 text-sm font-semibold">{initialValue.toFixed(0)}€</div>
        </div>
        <div className="text-center">
          <div className="text-gray-500 text-xs mb-0.5">Plus bas</div>
          <div className="text-white text-sm font-semibold">{minValue.toFixed(2)}€</div>
        </div>
      </div>
    </div>
  );
}
