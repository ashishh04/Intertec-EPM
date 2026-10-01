import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Menu } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { EpmLogo } from '@/components/common/EpmLogo';
import { APP_NAME } from '@/config/env';

const SECTIONS = [
  { href: '#platform', label: 'Platform' },
  { href: '#capabilities', label: 'Capabilities' },
  { href: '#how-it-works', label: 'How it works' },
  { href: '#integrations', label: 'Integrations' },
  { href: '#faq', label: 'FAQ' },
  { href: '#security', label: 'Security' },
];

/**
 * The landing page's navigation: a floating glass pill rather than the app's
 * hairline bar, because it sits over moving footage and a solid bar would cut
 * the hero in two.
 */
export function LandingHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  // Over the hero the pill is barely there, which is the point. Over the body
  // copy further down, that same transparency leaves headings running straight
  // through the nav — so once the page has moved, the glass fills in.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header className="fixed inset-x-0 top-0 z-50 px-5 py-4 sm:px-6 sm:py-6">
      <div
        className={cn(
          'liquid-glass mx-auto flex max-w-5xl items-center justify-between gap-4 rounded-full px-4 py-2.5 transition-colors duration-300 sm:px-6 sm:py-3',
          // Deep enough that a 60px white headline passing underneath does not
          // read through it. Anything lighter and the type ghosts the nav.
          scrolled && 'bg-black/90 backdrop-blur-xl',
        )}
      >
        <div className="flex items-center gap-8">
          <Link to="/" className="rounded-full" aria-label={`${APP_NAME} home`}>
            {/* The logotype paints in `currentColor`, so the reversed-out
                version is just white text — no second asset. The crimson dot
                is fixed either way, which is how the brand specifies it. */}
            <EpmLogo className="text-white [&_span[aria-hidden]]:bg-white/20" />
          </Link>

          <nav aria-label="Sections" className="hidden lg:block">
            <ul className="flex items-center gap-8">
              {SECTIONS.map((section) => (
                <li key={section.href}>
                  <a
                    href={section.href}
                    className="rounded text-sm font-medium text-white/70 transition-colors hover:text-white"
                  >
                    {section.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <div className="flex items-center gap-2">
          <Button asChild className="hidden ring-offset-black sm:inline-flex" arrow>
            <Link to="/login">Sign in</Link>
          </Button>

          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="rounded-full text-white ring-offset-black hover:bg-white/10 hover:text-white lg:hidden"
                aria-label="Open menu"
              >
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent
              side="right"
              className="w-72 bg-black/95 text-white backdrop-blur-xl [&>button]:text-white/60 [&>button]:hover:text-white"
            >
              <SheetHeader className="border-white/10">
                <SheetTitle className="text-white">Menu</SheetTitle>
              </SheetHeader>
              <nav aria-label="Sections" className="mt-6 px-5">
                <ul className="space-y-1">
                  {SECTIONS.map((section) => (
                    <li key={section.href}>
                      <a
                        href={section.href}
                        onClick={() => setMenuOpen(false)}
                        className="block rounded-lg px-3 py-2 text-sm font-medium text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                      >
                        {section.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
              <Button asChild className="mx-5 mt-6 ring-offset-black" arrow>
                <Link to="/login" onClick={() => setMenuOpen(false)}>
                  Sign in
                </Link>
              </Button>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
