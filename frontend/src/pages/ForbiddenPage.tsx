import { useNavigate } from 'react-router-dom';
import { ShieldOff } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/common/EmptyState';
import { msg, t } from '@/lib/i18n';

const TITLE = msg('This area is for administrators');

/**
 * Rendered in place of an administration route the signed-in person may not
 * enter. The link is hidden from their sidebar, but a typed or shared URL
 * still lands here, and it should say why rather than pretend the page is
 * missing.
 */
export default function ForbiddenPage() {
  const navigate = useNavigate();

  return (
    <Card className="mx-auto max-w-lg">
      {/* EmptyState renders its title as a paragraph; the page still needs a
          heading for the document outline and screen-reader navigation. */}
      <h1 className="sr-only">{t(TITLE)}</h1>
      <EmptyState
        icon={ShieldOff}
        title={t(TITLE)}
        description={t('Your account does not have access to this part of EPM. If you think it should, ask an administrator to grant it.')}
        action={{ label: t('Back to overview'), onClick: () => navigate('/dashboard') }}
      />
    </Card>
  );
}
