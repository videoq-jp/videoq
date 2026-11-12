import { useTranslation } from 'react-i18next';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts';
import { DashboardChartTitle } from './DashboardPanel';

interface FeedbackDonutChartProps {
  data: { good: number; bad: number; none: number };
}

const FEEDBACK_ITEMS = [
  { key: 'good' as const, color: 'var(--color-success-1)' },
  { key: 'bad' as const, color: 'var(--color-error-1)' },
  { key: 'none' as const, color: 'var(--color-solid-gray-300)' },
];

export function FeedbackDonutChart({ data }: FeedbackDonutChartProps) {
  const { t } = useTranslation();

  const chartData = FEEDBACK_ITEMS
    .filter(({ key }) => data[key] > 0)
    .map(({ key, color }) => ({
      name: t(`dashboard.feedback.${key}`),
      value: data[key],
      color,
    }));

  if (chartData.length === 0) return null;

  return (
    <div>
      <DashboardChartTitle>{t('dashboard.feedback.title')}</DashboardChartTitle>
      <ResponsiveContainer width="100%" height={220}>
        <PieChart>
          <Pie
            data={chartData}
            cx="50%"
            cy="50%"
            innerRadius={50}
            outerRadius={80}
            paddingAngle={2}
            dataKey="value"
          >
            {chartData.map((entry, index) => (
              <Cell key={index} fill={entry.color} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{ backgroundColor: 'var(--color-white)', borderColor: 'var(--color-solid-gray-300)', color: 'var(--color-solid-gray-800)' }}
            itemStyle={{ color: 'var(--color-solid-gray-800)' }}
          />
          <Legend formatter={(value) => <span className="text-solid-gray-800">{value}</span>} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
