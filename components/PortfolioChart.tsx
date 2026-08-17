'use client';

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
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

interface Props {
  snapshots: Snapshot[];
  initialValue?: number;
}

const CustomTooltip = ({ active, payload, label, initialValue }: {
  active?: boolean;
  payload?: Array<{ value: number; payload: { cash: number; crypto: number } }>;
  label?: string;
  initialValue?: number;
}) => {
  if (active && payload && payload.length) {
    const value = payload[0]?.value ?? 0;
    const init = initialValue ?? 5000;
    const pnl = value - init;
    const pnlPct = (pnl / init) * 100;
    const cash = payload[0]?.payload?.cash ?? 0;
    const crypto = payload[0]?.payload?.crypto ?? 0;

    return (
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-3 shadow-2xl min-w-[180px]">
        <p className="text-gray-400 text-xs mb-2">{label}</p>
        <p className="text-white font-bold text-lg">{value.toFixed(2)}€</p>
        <p className={`text-sm font-semibold mb-2 ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}€ ({pnl >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%)
        </p>
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

export default function PortfolioChart({ snapshots, initialValue = 5000 }: Props) {
  // Filter outliers: remove snapshots where value is less than 20% of initial
  // These are likely data errors or mid-transaction snapshots
  const minValid = initialValue * 0.20;
  const validSnapshots = snapshots.filter(s =>
    parseFloat(String(s.total_value_eur)) > minValid
  );

  const data = validSnapshots.map(s => ({
    date: format(parseISO(s.snapshotted_at), 'dd/MM HH:mm', { locale: fr }),
    value: parseFloat(String(s.total_value_eur)),
    cash: parseFloat(String(s.cash_eur)),
    crypto: parseFloat(String(s.crypto_value_eur)),
  }));

  if (data.length === 0) {
    data.push({
      date: 'Départ',
      value: initialValue,
      cash: initialValue,
      crypto: 0,
    });
  }

  const values = data.map(d => d.value);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const currentValue = values[values.length - 1];
  const isPositive = currentValue >= initialValue;

  // Smart Y-axis range: zoom into the actual value range with padding
  const range = maxValue - minValue;
  const padding = Math.max(range * 0.15, initialValue * 0.01);
  const yMin = Math.max(0, minValue - padding);
  const yMax = maxValue + padding;

  const pnl = currentValue - initialValue;
  const pnlPct = (pnl / initialValue) * 100;

  const strokeColor = isPositive ? '#10b981' : '#ef4444';
  const gradientId = isPositive ? 'gradientGreen' : 'gradientRed';

  // Reduce label density for readability
  const tickInterval = data.length <= 10 ? 0 : data.length <= 30 ? 4 : Math.floor(data.length / 8);

  return (
    <div className="space-y-3">
      {/* Mini stats bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
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
            ({isPositive ? '+' : ''}{pnlPct.toFixed(2)}%)
          </span>
        </div>
        <div className="text-right">
          <div className="text-white font-bold text-lg">{currentValue.toFixed(2)}€</div>
          <div className="text-gray-500 text-xs">Valeur actuelle</div>
        </div>
      </div>

      {/* Chart */}
      <div className="w-full h-72">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 10, right: 5, left: 5, bottom: 5 }}>
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
              domain={[yMin, yMax]}
              tick={{ fill: '#4b5563', fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={v => `${v.toFixed(0)}€`}
              width={58}
            />

            <Tooltip
              content={
                <CustomTooltip initialValue={initialValue} />
              }
            />

            {/* Initial investment reference line */}
            <ReferenceLine
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

            {/* Current value reference line */}
            {Math.abs(currentValue - initialValue) > initialValue * 0.005 && (
              <ReferenceLine
                y={currentValue}
                stroke={strokeColor}
                strokeDasharray="3 3"
                strokeOpacity={0.4}
              />
            )}

            <Area
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
