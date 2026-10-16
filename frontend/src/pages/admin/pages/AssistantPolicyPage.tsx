import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { ListSkeleton } from '@/components/common/DataTable';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { FieldHint, Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { t } from '@/lib/i18n';
import { formatDateTime, formatNumber } from '@/lib/utils';
import { apiClient } from '@/services/api/client';
import type { AssistantPolicyView, AssistantUsageRow } from '@/types';
import { describeError } from './shared-format';

/**
 * Pragnya's guardrails (Module 13), set by administrators and enforced on the
 * server: whether it answers, which kinds of figures it may look up, a daily
 * limit per person, topics it declines, and the organisation's guidance. None
 * of them can widen what a person sees. And who uses it how much — never what
 * they asked.
 */
export default function AssistantPolicyPage() {
  const client = useQueryClient();
  const policy = useQuery({ queryKey: ['assistant', 'policy'], queryFn: () => apiClient.get<AssistantPolicyView>('/admin/assistant-policy') });
  const usage = useQuery({ queryKey: ['assistant', 'usage'], queryFn: () => apiClient.get<AssistantUsageRow[]>('/admin/assistant-usage', { days: '7' }) });
  const [draft, setDraft] = useState<AssistantPolicyView | null>(null);
  const [topics, setTopics] = useState('');
  useEffect(() => {
    if (policy.data) {
      setDraft(policy.data);
      setTopics(policy.data.blockedTopics.join('\n'));
    }
  }, [policy.data]);
  const save = useMutation({
    mutationFn: () =>
      apiClient.put<AssistantPolicyView>('/admin/assistant-policy', {
        enabled: draft!.enabled,
        allowFinance: draft!.allowFinance,
        allowPeople: draft!.allowPeople,
        dailyLimit: draft!.dailyLimit,
        blockedTopics: topics
          .split(/[\n,]/)
          .map((topic) => topic.trim())
          .filter((topic) => topic.length >= 2),
        guidance: draft!.guidance?.trim() || null,
      }),
    onSuccess: () => {
      toast.success(t('Pragnya settings saved'));
      void client.invalidateQueries({ queryKey: ['assistant'] });
    },
    onError: (error) => toast.error(t('The settings were not saved'), { description: describeError(error) }),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader variant="compact">
          <CardTitle>{t('Guardrails')}</CardTitle>
          <CardDescription>
            {t('Pragnya only ever reads, and only what the person asking may see. These settings narrow it further, and are enforced on the server — not left to the assistant.')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-4">
          <QueryBoundary isLoading={policy.isLoading || !draft} isError={policy.isError} error={policy.error} onRetry={() => void policy.refetch()} errorTitle={t('The settings could not be loaded')} skeleton={<ListSkeleton rows={5} />}>
            {draft ? (
              <div className="space-y-4">
                {[
                  ['enabled', t('Pragnya is available'), t('Switched off, nobody can ask it anything.')],
                  ['allowFinance', t('Answers finance questions'), t('Cash flow, margin, forecast and earned value — still only for people allowed to see finance.')],
                  ['allowPeople', t('Answers questions about people’s workload'), t('Team workload, over-allocation and everyone’s timesheets — still only for people allowed to see them.')],
                ].map(([key, label, hint]) => (
                  <label key={key} className="flex items-start gap-3 text-sm">
                    <Switch checked={draft[key as 'enabled'] as boolean} onCheckedChange={(value) => setDraft({ ...draft, [key as string]: value })} />
                    <span>
                      {label}
                      <span className="block text-2xs text-muted-foreground">{hint}</span>
                    </span>
                  </label>
                ))}
                <div className="space-y-1.5">
                  <Label htmlFor="assistant-limit">{t('Questions a person may ask a day')}</Label>
                  <Input id="assistant-limit" className="w-32" inputMode="numeric" value={String(draft.dailyLimit)} onChange={(event) => setDraft({ ...draft, dailyLimit: Number(event.target.value) || 0 })} />
                  <FieldHint>{t('0 for no limit.')}</FieldHint>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="assistant-topics">{t('Topics Pragnya declines')}</Label>
                  <Textarea id="assistant-topics" rows={4} value={topics} onChange={(event) => setTopics(event.target.value)} placeholder={t('One per line, e.g. salary, appraisal')} />
                  <FieldHint>{t('A question mentioning any of these is declined before the assistant sees it.')}</FieldHint>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="assistant-guidance">{t('Guidance from your organisation')}</Label>
                  <Textarea id="assistant-guidance" rows={4} value={draft.guidance ?? ''} onChange={(event) => setDraft({ ...draft, guidance: event.target.value })} placeholder={t('e.g. Answer in a formal tone. Refer contract questions to the PMO.')} />
                  <FieldHint>{t('It can narrow what Pragnya does, never widen it: its own rules and every permission still apply.')}</FieldHint>
                </div>
                <Button loading={save.isPending} onClick={() => save.mutate()}>
                  {t('Save')}
                </Button>
                {policy.data?.updatedAt ? <p className="text-2xs text-muted-foreground">{t('Last changed {when}.', { when: formatDateTime(policy.data.updatedAt) })}</p> : null}
              </div>
            ) : null}
          </QueryBoundary>
        </CardContent>
      </Card>
      <Card>
        <CardHeader variant="compact">
          <CardTitle>{t('Use in the last 7 days')}</CardTitle>
          <CardDescription>{t('Who asked how much, and which lookups ran — never what they asked. Every answer is also in the audit journal.')}</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto pt-4">
          <QueryBoundary isLoading={usage.isLoading} isError={usage.isError} error={usage.error} onRetry={() => void usage.refetch()} errorTitle={t('The use could not be loaded')} skeleton={<ListSkeleton rows={3} />}>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-2xs text-muted-foreground">
                  <th className="py-1.5 text-start font-medium">{t('Person')}</th>
                  <th className="py-1.5 text-end font-medium">{t('Questions')}</th>
                  <th className="py-1.5 text-end font-medium">{t('Declined')}</th>
                  <th className="py-1.5 text-start font-medium ps-4">{t('Lookups')}</th>
                  <th className="py-1.5 text-end font-medium">{t('Tokens')}</th>
                  <th className="py-1.5 text-end font-medium">{t('Last')}</th>
                </tr>
              </thead>
              <tbody>
                {(usage.data ?? []).map((row) => (
                  <tr key={row.userId} className="border-b border-border/60">
                    <td className="py-1.5" dir="auto">
                      {row.userName}
                    </td>
                    <td className="py-1.5 text-end">{formatNumber(row.questions)}</td>
                    <td className="py-1.5 text-end">{formatNumber(row.refused)}</td>
                    <td className="py-1.5 ps-4 text-2xs text-muted-foreground">
                      {Object.entries(row.tools)
                        .sort((a, b) => b[1] - a[1])
                        .map(([name, count]) => `${name} ${count}`)
                        .join(', ') || '—'}
                    </td>
                    <td className="py-1.5 text-end">{formatNumber(row.tokens)}</td>
                    <td className="py-1.5 text-end">{formatDateTime(row.lastAt)}</td>
                  </tr>
                ))}
                {(usage.data ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-3 text-2xs text-muted-foreground">
                      {t('Nobody has asked Pragnya anything in the last 7 days.')}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </QueryBoundary>
        </CardContent>
      </Card>
    </div>
  );
}
