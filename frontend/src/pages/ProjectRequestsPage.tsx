import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FilePlus2, Plus } from 'lucide-react';

import { ListSkeleton, TableCard } from '@/components/common/DataTable';
import { EmptyState } from '@/components/common/EmptyState';
import { PageHeader } from '@/components/common/PageHeader';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { ProjectRequestDialog } from '@/components/requests/ProjectRequestDialog';
import { REQUEST_STATUS } from '@/components/requests/requestMeta';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useProjectRequests } from '@/hooks/useRequests';
import { t } from '@/lib/i18n';
import { formatCurrency, formatShortDate } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';

/**
 * Project requests: proposals to start a project, each decided through the
 * approval chain for project requests. Everyone sees their own; whoever
 * manages portfolios sees them all.
 */
export default function ProjectRequestsPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  // The whole intake is for whoever reviews it, as a PMO does.
  const mayManage = can('requests:review') || can('portfolios:manage');
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const requests = useProjectRequests(scope);
  const [creating, setCreating] = useState(false);
  const items = requests.data ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('Project requests')}
        description={t('Proposals to start a project, decided through an approval chain, then turned into projects.')}
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" />
            {t('Request a project')}
          </Button>
        }
      />
      {mayManage ? (
        <Tabs value={scope} onValueChange={(value) => setScope(value as 'mine' | 'all')}>
          <TabsList>
            <TabsTrigger value="mine">{t('Mine')}</TabsTrigger>
            <TabsTrigger value="all">{t('All requests')}</TabsTrigger>
          </TabsList>
        </Tabs>
      ) : null}
      <QueryBoundary
        isLoading={requests.isLoading}
        isError={requests.isError}
        error={requests.error}
        onRetry={() => requests.refetch()}
        errorTitle={t('Unable to load the requests')}
        skeleton={<ListSkeleton rows={4} />}
        isEmpty={items.length === 0}
        empty={
          <Card>
            <EmptyState
              icon={FilePlus2}
              title={t('No project requests')}
              description={t('Propose a project: what it is for, why, and what it would cost.')}
              action={{ label: t('Request a project'), onClick: () => setCreating(true) }}
            />
          </Card>
        }
      >
        <TableCard>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('Request')}</TableHead>
                <TableHead>{t('Status')}</TableHead>
                <TableHead>{t('Portfolio')}</TableHead>
                <TableHead numeric>{t('Budget')}</TableHead>
                {scope === 'all' ? <TableHead>{t('Requested by')}</TableHead> : null}
                <TableHead>{t('Submitted')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((request) => (
                <TableRow key={request.id} interactive onClick={() => navigate(`/project-requests/${request.id}`)}>
                  <TableCell>
                    <Link to={`/project-requests/${request.id}`} className="font-medium hover:text-primary" dir="auto" onClick={(event) => event.stopPropagation()}>
                      {request.title}
                    </Link>
                    <span className="ms-2 font-mono text-2xs text-muted-foreground">{request.key}</span>
                  </TableCell>
                  <TableCell>
                    <Badge size="sm" tone={REQUEST_STATUS[request.status].tone}>
                      {REQUEST_STATUS[request.status].label()}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">{request.portfolioName ?? '—'}</TableCell>
                  <TableCell numeric>{request.budget !== undefined ? formatCurrency(request.budget) : '—'}</TableCell>
                  {scope === 'all' ? <TableCell className="text-xs">{request.requestedByName ?? '—'}</TableCell> : null}
                  <TableCell className="text-xs">{request.submittedAt ? formatShortDate(request.submittedAt) : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableCard>
      </QueryBoundary>
      <ProjectRequestDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
