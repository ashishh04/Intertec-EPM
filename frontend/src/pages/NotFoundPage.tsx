import { Link } from 'react-router-dom';
import { Compass, Home, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useUI } from '@/providers/UIProvider';

/** Route fallback inside the authenticated shell. */
export default function NotFoundPage() {
  const { setCommandPaletteOpen } = useUI();

  return (
    <Card className="mx-auto flex max-w-lg flex-col items-center gap-4 px-6 py-14 text-center">
      <span
        className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground"
        aria-hidden
      >
        <Compass className="h-6 w-6" />
      </span>

      <div className="space-y-1.5">
        <h1 className="text-lg font-semibold tracking-tight">This page does not exist</h1>
        <p className="text-xs text-muted-foreground">
          The link may be out of date, or the record may have been moved or archived.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button asChild>
          <Link to="/dashboard">
            <Home className="h-4 w-4" />
            Back to overview
          </Link>
        </Button>
        <Button variant="secondary" onClick={() => setCommandPaletteOpen(true)}>
          <Search className="h-4 w-4" />
          Search EPM
        </Button>
      </div>
    </Card>
  );
}
