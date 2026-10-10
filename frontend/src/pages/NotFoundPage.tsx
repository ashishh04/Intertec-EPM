import { useNavigate } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/common/EmptyState';
import { useUI } from '@/providers/UIProvider';
import { msg, t } from '@/lib/i18n';

const TITLE = msg('This page does not exist');

/** Route fallback inside the authenticated shell. */
export default function NotFoundPage() {
  const navigate = useNavigate();
  const { setCommandPaletteOpen } = useUI();

  return (
    <Card className="mx-auto max-w-lg">
      {/* EmptyState renders its title as a paragraph; the page still needs a
          heading for the document outline and screen-reader navigation. */}
      <h1 className="sr-only">{t(TITLE)}</h1>
      <EmptyState
        icon={Compass}
        title={t(TITLE)}
        description={t('The link may be out of date, or the record may have been moved or archived.')}
        action={{ label: t('Back to overview'), onClick: () => navigate('/dashboard') }}
        secondaryAction={{ label: t('Search EPM'), onClick: () => setCommandPaletteOpen(true) }}
      />
    </Card>
  );
}
