import { t } from '@/lib/i18n';
import type { EpmProgram } from '@/types';

/** A program's projects by health, as one stacked bar with its counts. */
export function ProgramHealthBar({ health }: { health: EpmProgram['health'] }) {
  const total = health.healthy + health.warning + health.critical + health.unassessed;
  const parts = [
    { key: 'healthy', count: health.healthy, className: 'bg-success', label: t('Healthy') },
    { key: 'warning', count: health.warning, className: 'bg-warning', label: t('Warning') },
    { key: 'critical', count: health.critical, className: 'bg-danger', label: t('Critical') },
    { key: 'unassessed', count: health.unassessed, className: 'bg-muted-foreground/30', label: t('Not assessed') },
  ];
  if (total === 0) return <p className="text-2xs text-muted-foreground">{t('No projects you can see.')}</p>;
  return (
    <div className="space-y-1">
      <div className="flex h-2 overflow-hidden rounded-full bg-muted" role="img" aria-label={parts.filter((part) => part.count > 0).map((part) => `${part.label}: ${part.count}`).join(', ')}>
        {parts.map((part) => (part.count > 0 ? <span key={part.key} className={part.className} style={{ width: `${(part.count / total) * 100}%` }} /> : null))}
      </div>
      <p className="flex flex-wrap gap-x-3 text-2xs text-muted-foreground">
        {parts
          .filter((part) => part.count > 0)
          .map((part) => (
            <span key={part.key} className="inline-flex items-center gap-1">
              <span className={`h-1.5 w-1.5 rounded-full ${part.className}`} aria-hidden />
              {part.label} {part.count}
            </span>
          ))}
      </p>
    </div>
  );
}
