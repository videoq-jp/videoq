import { useTranslation } from 'react-i18next';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { DashboardChartTitle } from './DashboardPanel';

interface QuestionTimeSeriesChartProps {
  data: { date: string; count: number }[];
}

export function QuestionTimeSeriesChart({ data }: QuestionTimeSeriesChartProps) {
  const { t } = useTranslation();

  const chartData = data.map((item) => ({
    date: item.date.slice(5), // MM-DD
    count: item.count,
  }));

  return (
    <div>
      <DashboardChartTitle>{t('dashboard.timeSeries.title')}</DashboardChartTitle>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={chartData} margin={{ left: 0, right: 20, top: 5, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-solid-gray-200)" />
          <XAxis dataKey="date" tick={{ fontSize: 14, fill: 'var(--color-solid-gray-700)' }} />
          <YAxis
            allowDecimals={false}
            tick={{ fontSize: 14, fill: 'var(--color-solid-gray-700)' }}
          />
          <Tooltip
            contentStyle={{ backgroundColor: 'var(--color-white)', borderColor: 'var(--color-solid-gray-300)', color: 'var(--color-solid-gray-800)' }}
            formatter={(value) => [value, t('dashboard.timeSeries.count')]}
          />
          <Line
            type="monotone"
            dataKey="count"
            stroke="var(--color-blue-900)"
            strokeWidth={2}
            dot={{ r: 3 }}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
