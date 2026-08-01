'use client';

import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { PortfolioHolding } from '@/lib/types';

interface Props {
  holdings: PortfolioHolding[];
  cashEur: number;
}

const COLORS = [
  '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316',
];

const CustomTooltip = ({ active, payload }: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; payload: { pct: number } }>;
}) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-2 shadow-xl">
        <p className="text-white font-medium">{payload[0].name}</p>
        <p className="text-gray-300 text-sm">{payload[0].value.toFixed(2)}€</p>
        <p className="text-gray-400 text-xs">{payload[0].payload.pct.toFixed(1)}%</p>
      </div>
    );
  }
  return null;
};

export default function HoldingsPieChart({ holdings, cashEur }: Props) {
  const total = holdings.reduce((acc, h) => acc + h.current_value_eur, 0) + cashEur;

  const data = [
    ...(cashEur > 0
      ? [{ name: 'EUR Cash', value: cashEur, pct: (cashEur / total) * 100 }]
      : []),
    ...holdings.map(h => ({
      name: h.symbol,
      value: h.current_value_eur,
      pct: (h.current_value_eur / total) * 100,
    })),
  ];

  if (data.length === 0 || total === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-500">
        Aucune donnée
      </div>
    );
  }

  return (
    <div className="w-full h-52">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={50}
            outerRadius={80}
            paddingAngle={2}
            dataKey="value"
          >
            {data.map((_, index) => (
              <Cell key={index} fill={COLORS[index % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip content={<CustomTooltip />} />
          <Legend
            formatter={(value: string) => (
              <span className="text-gray-300 text-xs">{value}</span>
            )}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
