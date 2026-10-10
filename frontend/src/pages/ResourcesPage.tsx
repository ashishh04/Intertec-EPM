import { useSearchParams } from 'react-router-dom';

import { PageHeader } from '@/components/common/PageHeader';
import { AvailabilityPanel } from '@/components/resources/AvailabilityPanel';
import { BookingsPanel } from '@/components/resources/BookingsPanel';
import { CapacityHeatmap } from '@/components/resources/CapacityHeatmap';
import { LevellingPanel } from '@/components/resources/LevellingPanel';
import { OverAllocationList } from '@/components/resources/OverAllocationList';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { t } from '@/lib/i18n';
import ForbiddenPage from '@/pages/ForbiddenPage';
import { useAuth } from '@/providers/AuthProvider';

const TABS = ['capacity', 'over', 'levelling', 'bookings', 'availability'] as const;
type Tab = (typeof TABS)[number];

/**
 * Resources (Module 6): who is available, what is asked of them across every
 * project, where that does not fit, and how to level it. The tab is in the
 * address, so a view can be shared.
 */
export default function ResourcesPage() {
  const { can } = useAuth();
  const plan = can('resources:plan');
  const manage = can('employees:manage');
  const [params, setParams] = useSearchParams();
  // Whoever manages people but does not plan sees availability only.
  const allowed: readonly Tab[] = plan ? TABS : manage ? ['availability'] : [];
  const asked = params.get('tab') ?? '';
  const tab = (allowed as readonly string[]).includes(asked) ? (asked as Tab) : allowed[0];
  const setTab = (value: string) =>
    setParams(
      (current) => {
        const next = new URLSearchParams();
        next.set('tab', value);
        if (value === 'availability' && current.get('person')) next.set('person', current.get('person')!);
        return next;
      },
      { replace: true },
    );

  if (!tab) return <ForbiddenPage />;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('Resources')}
        description={t('Who is available, what is asked of them across every project, where it does not fit — and levelling it.')}
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList variant="underline">
          {plan ? (
            <>
              <TabsTrigger value="capacity" variant="underline">
                {t('Capacity')}
              </TabsTrigger>
              <TabsTrigger value="over" variant="underline">
                {t('Over-allocation')}
              </TabsTrigger>
              <TabsTrigger value="levelling" variant="underline">
                {t('Levelling')}
              </TabsTrigger>
              <TabsTrigger value="bookings" variant="underline">
                {t('Bookings')}
              </TabsTrigger>
            </>
          ) : null}
          <TabsTrigger value="availability" variant="underline">
            {t('Availability')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="capacity" className="mt-4">
          <CapacityHeatmap />
        </TabsContent>
        <TabsContent value="over" className="mt-4">
          <OverAllocationList />
        </TabsContent>
        <TabsContent value="levelling" className="mt-4">
          <LevellingPanel />
        </TabsContent>
        <TabsContent value="bookings" className="mt-4">
          <BookingsPanel />
        </TabsContent>
        <TabsContent value="availability" className="mt-4">
          <AvailabilityPanel initialPersonId={params.get('person') ?? undefined} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
