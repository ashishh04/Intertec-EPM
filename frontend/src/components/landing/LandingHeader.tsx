import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Menu, Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { EpmLogo } from '@/components/common/EpmLogo';
import { useTheme } from '@/providers/ThemeProvider';

const SECTIONS = [
  { href: '#platform', label: 'Platform' },
  { href: '#capabilities', label: 'Capabilities' },
  { href: '#how-it-works', label: 'How it works' },
  { href: '#security', label: 'Security' },
];

function ThemeToggle() {
  const { resolvedTheme, toggleTheme } = useTheme();
  const Icon = resolvedTheme === 'dark' ? Sun : Moon;

  return (
    <Button
      variant="secondary"
      size="icon"
      onClick={toggleTheme}
      aria-label={`Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} theme`}
    >
      <Icon />
    </Button>
  );
}

export function LandingHeader() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-surface/80 backdrop-blur supports-[backdrop-filter]:bg-surface/70">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-5 sm:px-8">
        <Link to="/" className="rounded-lg" aria-label="EPM home">
          <EpmLogo />
        </Link>

        <nav aria-label="Sections" className="hidden lg:block">
          <ul className="flex items-center gap-7">
            {SECTIONS.map((section) => (
              <li key={section.href}>
                <a
                  href={section.href}
                  className="rounded text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  {section.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex items-center gap-2">
          <ThemeToggle />

          <Button asChild className="hidden sm:inline-flex">
            <Link to="/login">Sign in</Link>
          </Button>

          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <Button variant="secondary" size="icon" className="lg:hidden" aria-label="Open menu">
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-72">
              <SheetHeader>
                <SheetTitle>Menu</SheetTitle>
              </SheetHeader>
              <nav aria-label="Sections" className="mt-6">
                <ul className="space-y-1">
                  {SECTIONS.map((section) => (
                    <li key={section.href}>
                      <a
                        href={section.href}
                        onClick={() => setMenuOpen(false)}
                        className="block rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        {section.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
              <Button asChild className="mt-6 w-full">
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
