import { useNavigate } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/common/EmptyState';
import { useUI } from '@/providers/UIProvider';

const TITLE = 'This page does not exist';

/** Route fallback inside the authenticated shell. */
export default function NotFoundPage() {
  const navigate = useNavigate();
  const { setCommandPaletteOpen } = useUI();

  return (
    <Card className="mx-auto max-w-lg">
      {/* EmptyState renders its title as a paragraph; the page still needs a
          heading for the document outline and screen-reader navigation. */}
      <h1 className="sr-only">{TITLE}</h1>
      <EmptyState
        icon={Compass}
        title={TITLE}
        description="The link may be out of date, or the record may have been moved or archived."
        action={{ label: 'Back to overview', onClick: () => navigate('/dashboard') }}
        secondaryAction={{ label: 'Search EPM', onClick: () => setCommandPaletteOpen(true) }}
      />
    </Card>
  );
}
