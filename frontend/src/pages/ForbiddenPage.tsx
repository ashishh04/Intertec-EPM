import { useNavigate } from 'react-router-dom';
import { ShieldOff } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/common/EmptyState';
import { msg, t } from '@/lib/i18n';

const TITLE = {
  administrator: msg('This area is for administrators'),
  permission: msg('This area is not part of your access'),
  role: msg('This area is not part of your role'),
};

/**
 * Rendered in place of a route the signed-in person may not enter. The link
 * is hidden from their sidebar, but a typed or shared URL still lands here,
 * and it should say why rather than pretend the page is missing.
 *
 * The reason names the gate that refused them:
 * - `administrator`: Administration, which is for administrators only.
 * - `permission`: an area behind a permission, which a Manager's or HR's role
 *   may carry or an administrator may grant, so only their access lacks it.
 * - `role`: an area outside the person's role (Manager, HR, Employee).
 */
export default function ForbiddenPage({ reason = 'permission' }: { reason?: keyof typeof TITLE }) {
  const navigate = useNavigate();
  const title = TITLE[reason];

  return (
    <Card className="mx-auto max-w-lg">
      {/* EmptyState renders its title as a paragraph; the page still needs a
          heading for the document outline and screen-reader navigation. */}
      <h1 className="sr-only">{t(title)}</h1>
      <EmptyState
        icon={ShieldOff}
        title={t(title)}
        description={
          reason === 'role'
            ? t('Your role does not work in this part of EPM, so it is not in your sidebar. If your role should change, ask an administrator.')
            : t('Your account does not have access to this part of EPM. If you think it should, ask an administrator to grant it.')
        }
        action={{ label: t('Back to overview'), onClick: () => navigate('/dashboard') }}
      />
    </Card>
  );
}
