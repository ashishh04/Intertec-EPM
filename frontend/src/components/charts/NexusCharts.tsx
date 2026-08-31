import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { TASK_STATUS_META, TONE_VAR } from '@/lib/domain';
import type { BurndownPoint, DeliveryTrendPoint, StatusDistribution } from '@/types';

/**
 * Shared chart configuration.
 *
 * Colours resolve from the same CSS custom properties as the rest of the UI, so
 * charts follow the active theme without a separate palette.
 */
const AXIS = {
  stroke: 'hsl(var(--border))',
  tick: { fill: 'hsl(var(--muted-foreground))', fontSize: 11 },
  tickLine: false,
  axisLine: false,
} as const;

const GRID = {
  stroke: 'hsl(var(--border))',
  strokeDasharray: '3 3',
  vertical: false,
} as const;

const TOOLTIP_STYLE = {
  contentStyle: {
    background: 'hsl(var(--popover))',
    border: '1px solid hsl(var(--border))',
    borderRadius: '0.5rem',
    boxShadow: '0 12px 32px -8px rgba(16,24,40,0.18)',
    fontSize: 11,
    color: 'hsl(var(--popover-foreground))',
  },
  labelStyle: { color: 'hsl(var(--foreground))', fontWeight: 600, marginBottom: 2 },
  itemStyle: { color: 'hsl(var(--muted-foreground))' },
  cursor: { fill: 'hsl(var(--muted))', opacity: 0.6 },
} as const;

/* -------------------------------------------------------------------------- */
/* Sprint burndown                                                             */
/* -------------------------------------------------------------------------- */

export function BurndownChart({ data }: { data: BurndownPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
        <CartesianGrid {...GRID} />
        <XAxis dataKey="label" {...AXIS} interval="preserveStartEnd" />
        <YAxis {...AXIS} width={44} />
        <Tooltip {...TOOLTIP_STYLE} cursor={{ stroke: 'hsl(var(--border))' }} />
        <Legend
          verticalAlign="top"
          height={28}
          iconType="plainline"
          wrapperStyle={{ fontSize: 11, color: 'hsl(var(--muted-foreground))' }}
        />
        <Line
          type="monotone"
          dataKey="ideal"
          name="Ideal"
          stroke="hsl(var(--muted-foreground))"
          strokeDasharray="4 4"
          strokeWidth={1.5}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="remaining"
          name="Remaining"
          stroke={TONE_VAR.primary}
          strokeWidth={2}
          dot={{ r: 2.5, strokeWidth: 0, fill: TONE_VAR.primary }}
          activeDot={{ r: 4 }}
          connectNulls
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

/* -------------------------------------------------------------------------- */
/* Delivery trends                                                             */
/* -------------------------------------------------------------------------- */

export function DeliveryTrendChart({ data }: { data: DeliveryTrendPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
        <defs>
          <linearGradient id="nexus-completed" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={TONE_VAR.primary} stopOpacity={0.28} />
            <stop offset="100%" stopColor={TONE_VAR.primary} stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id="nexus-created" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={TONE_VAR.accent} stopOpacity={0.22} />
            <stop offset="100%" stopColor={TONE_VAR.accent} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid {...GRID} />
        <XAxis dataKey="period" {...AXIS} />
        <YAxis {...AXIS} width={44} />
        <Tooltip {...TOOLTIP_STYLE} cursor={{ stroke: 'hsl(var(--border))' }} />
        <Legend
          verticalAlign="top"
          height={28}
          iconType="circle"
          wrapperStyle={{ fontSize: 11, color: 'hsl(var(--muted-foreground))' }}
        />
        <Area
          type="monotone"
          dataKey="completed"
          name="Completed"
          stroke={TONE_VAR.primary}
          strokeWidth={2}
          fill="url(#nexus-completed)"
        />
        <Area
          type="monotone"
          dataKey="created"
          name="Created"
          stroke={TONE_VAR.accent}
          strokeWidth={2}
          fill="url(#nexus-created)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/* -------------------------------------------------------------------------- */
/* Velocity                                                                    */
/* -------------------------------------------------------------------------- */

export function VelocityChart({ data }: { data: DeliveryTrendPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
        <CartesianGrid {...GRID} />
        <XAxis dataKey="period" {...AXIS} />
        <YAxis {...AXIS} width={44} />
        <Tooltip {...TOOLTIP_STYLE} />
        <Bar dataKey="velocity" name="Story points" radius={[4, 4, 0, 0]} maxBarSize={34}>
          {data.map((entry, index) => (
            <Cell
              key={entry.period}
              fill={index === data.length - 1 ? TONE_VAR.primary : 'hsl(var(--primary) / 0.35)'}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/* -------------------------------------------------------------------------- */
/* Status distribution                                                         */
/* -------------------------------------------------------------------------- */

export function StatusDistributionChart({ data }: { data: StatusDistribution[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Tooltip {...TOOLTIP_STYLE} cursor={false} />
        <Legend
          verticalAlign="middle"
          align="right"
          layout="vertical"
          iconType="circle"
          wrapperStyle={{ fontSize: 11, color: 'hsl(var(--muted-foreground))', lineHeight: '20px' }}
        />
        <Pie
          data={data}
          dataKey="count"
          nameKey="label"
          innerRadius="58%"
          outerRadius="82%"
          paddingAngle={2}
          stroke="hsl(var(--surface))"
          strokeWidth={2}
        >
          {data.map((entry) => (
            <Cell key={entry.status} fill={TONE_VAR[TASK_STATUS_META[entry.status].tone]} />
          ))}
        </Pie>
      </PieChart>
    </ResponsiveContainer>
  );
}

/* -------------------------------------------------------------------------- */
/* Generic horizontal comparison                                               */
/* -------------------------------------------------------------------------- */

export function HorizontalBarChart({
  data,
  valueKey = 'value',
  labelKey = 'label',
  tone = 'primary',
}: {
  data: Record<string, string | number>[];
  valueKey?: string;
  labelKey?: string;
  tone?: keyof typeof TONE_VAR;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
        <CartesianGrid {...GRID} horizontal={false} vertical />
        <XAxis type="number" {...AXIS} />
        <YAxis type="category" dataKey={labelKey} {...AXIS} width={120} />
        <Tooltip {...TOOLTIP_STYLE} />
        <Bar dataKey={valueKey} fill={TONE_VAR[tone]} radius={[0, 4, 4, 0]} maxBarSize={18} />
      </BarChart>
    </ResponsiveContainer>
  );
}
