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
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';

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

const CustomTooltip = ({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ value: number; name: string; color: string }>;
  label?: string;
}) => {
  if (active && payload && payload.length) {
    const value = payload[0]?.value ?? 0;
    const initial = 5000;
    const pnl = value - initial;
    const pnlPct = (pnl / initial) * 100;

    return (
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-3 shadow-xl">
        <p className="text-gray-400 text-xs mb-1">{label}</p>
        <p className="text-white font-bold text-lg">{value.toFixed(2)}€</p>
        <p className={`text-sm font-medium ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}€ ({pnl >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%)
        </p>
      </div>
    );
  }
  return null;
};

export default function PortfolioChart({ snapshots, initialValue = 5000 }: Props) {
  const data = snapshots.map(s => ({
    date: format(new Date(s.snapshotted_at), 'dd/MM HH:mm', { locale: fr }),
    value: parseFloat(String(s.total_value_eur)),
    cash: parseFloat(String(s.cash_eur)),
    crypto: parseFloat(String(s.crypto_value_eur)),
  }));

  // Add initial point if no data
  if (data.length === 0) {
    data.push({
      date: 'Départ',
      value: initialValue,
      cash: initialValue,
      crypto: 0,
    });
  }

  const minValue = Math.min(...data.map(d => d.value)) * 0.98;
  const maxValue = Math.max(...data.map(d => d.value)) * 1.02;
  const isPositive = data[data.length - 1]?.value >= initialValue;

  return (
    <div className="w-full h-64">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
          <defs>
            <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="5%"
                stopColor={isPositive ? '#10b981' : '#ef4444'}
                stopOpacity={0.3}
              />
              <stop
                offset="95%"
                stopColor={isPositive ? '#10b981' : '#ef4444'}
                stopOpacity={0}
              />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
          <XAxis
            dataKey="date"
            tick={{ fill: '#6b7280', fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: '#1f2937' }}
            interval="preserveStartEnd"
          />
          <YAxis
            domain={[minValue, maxValue]}
            tick={{ fill: '#6b7280', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={v => `${v.toFixed(0)}€`}
            width={60}
          />
          <Tooltip content={<CustomTooltip />} />
          <ReferenceLine
            y={initialValue}
            stroke="#6b7280"
            strokeDasharray="4 4"
            label={{ value: `Initial: ${initialValue}€`, fill: '#6b7280', fontSize: 10 }}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke={isPositive ? '#10b981' : '#ef4444'}
            strokeWidth={2}
            fill="url(#colorValue)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
