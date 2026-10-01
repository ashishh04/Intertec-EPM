import { Suspense } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { TableSkeleton } from '@/components/common/DataTable';
import { PageHeader } from '@/components/common/PageHeader';
import { Card } from '@/components/ui/card';
import {
  ADMIN_AREAS,
  adminAreaPath,
  adminPageKey,
  adminPagePath,
  findAdminArea,
  findAdminPage,
  firstAdminPage,
  isSinglePageArea,
  type AdminArea,
  type AdminPage,
} from '@/config/administration';
import NotFoundPage from '@/pages/NotFoundPage';
import { cn } from '@/lib/utils';
import { ManagedPanel } from './ManagedPanel';
import { ADMIN_PAGE_COMPONENTS } from './pages';
import { Placeholder } from './pages/Placeholder';

/**
 * Administration, shaped like OpenProject's: one overview of tiles, one area
 * per tile, and inside an area a sub-navigation of pages.
 *
 * Handles `/admin`, `/admin/:areaId`, `/admin/:areaId/:pageId` and
 * `/admin/:areaId/:pageId/:itemId` (a page may read `itemId` itself, e.g. a role). A
 * multi-page area opened by its id alone redirects to its first page; a
 * single-page area is its own page. Anything that does not resolve renders
 * the not-found page in place, so the address still explains itself.
 */
export default function AdministrationPage() {
  const { areaId, pageId } = useParams<{ areaId?: string; pageId?: string }>();

  if (!areaId) return <Overview />;

  const area = findAdminArea(areaId);
  if (!area) return <NotFoundPage />;

  if (isSinglePageArea(area)) {
    if (pageId) return <NotFoundPage />;
    return <AreaPage area={area} page={firstAdminPage(area)} />;
  }

  if (!pageId) return <Navigate to={adminAreaPath(area)} replace />;

  const page = findAdminPage(area, pageId);
  if (!page) return <NotFoundPage />;

  return <AreaPage area={area} page={page} />;
}

/* ------------------------------------------------------------------------ */
/* Overview                                                                  */
/* ------------------------------------------------------------------------ */

function Overview() {
  return (
    <Layout>
      <PageHeader
        eyebrow="Administration"
        title="Overview"
        description="Areas of EPM that you manage for everyone else."
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        {ADMIN_AREAS.map((area) => (
          // The card is the whole link: lifting it on hover says "this opens
          // somewhere" without a chevron on every tile.
          <Card
            key={area.id}
            className="transition-all hover:-translate-y-0.5 hover:border-primary/40 focus-within:border-primary/40"
          >
            <Link
              to={adminAreaPath(area)}
              className="flex h-full flex-col gap-3 rounded-xl p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary ring-1 ring-inset ring-primary/10"
                aria-hidden
              >
                <area.icon className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-semibold tracking-tight">{area.label}</span>
                <span className="mt-0.5 block text-2xs leading-relaxed text-muted-foreground">
                  {area.description}
                </span>
              </span>
            </Link>
          </Card>
        ))}
      </div>
    </Layout>
  );
}

/* ------------------------------------------------------------------------ */
/* One page inside an area                                                   */
/* ------------------------------------------------------------------------ */

function AreaPage({ area, page }: { area: AdminArea; page: AdminPage }) {
  const single = isSinglePageArea(area);

  // The app header already draws the breadcrumb for admin routes, so the page
  // itself starts at its heading.
  return (
    <Layout>
      <BackToAdministration />
      <PageHeader
        eyebrow={single ? 'Administration' : `Administration · ${area.label}`}
        title={page.label}
        description={page.description}
      />
      {single ? null : <PageTabs area={area} page={page} />}
      <PageContent area={area} page={page} />
    </Layout>
  );
}

function PageContent({ area, page }: { area: AdminArea; page: AdminPage }) {
  if (page.kind === 'managed') {
    return (
      <ManagedPanel
        title={page.label}
        description={page.description}
        enterprise={page.enterprise}
        managedAt={page.managedAt}
      />
    );
  }

  const Component = ADMIN_PAGE_COMPONENTS[adminPageKey(area, page)];
  if (!Component) return <Placeholder label={page.label} />;

  return (
    <Suspense fallback={<TableSkeleton columns={5} rows={6} />}>
      <Component />
    </Suspense>
  );
}

/* ------------------------------------------------------------------------ */
/* Layout and navigation                                                     */
/* ------------------------------------------------------------------------ */

function Layout({ children }: { children: React.ReactNode }) {
  return <div className="min-w-0 space-y-5">{children}</div>;
}

/**
 * The overview tiles are the navigation between areas, so area pages carry
 * only a way back rather than a second copy of that list.
 */
function BackToAdministration() {
  return (
    <Link
      to="/admin"
      className="inline-flex items-center gap-1.5 rounded-lg text-2xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowLeft className="h-3 w-3" aria-hidden />
      All administration areas
    </Link>
  );
}

/** Inside a multi-page area: its pages as a tab strip under the heading. */
function PageTabs({ area, page }: { area: AdminArea; page: AdminPage }) {
  return (
    <nav aria-label={`${area.label} pages`} className="epm-scroll -mb-1 overflow-x-auto">
      <ul className="flex items-center gap-4 border-b border-border">
        {area.pages.map((item) => {
          const active = item.id === page.id;
          return (
            <li key={item.id} className="shrink-0">
              <Link
                to={adminPagePath(area, item)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  '-mb-px inline-flex whitespace-nowrap border-b-2 px-0.5 pb-2.5 pt-1 text-xs font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
