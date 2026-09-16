/** @type {import('tailwindcss').Config} */
export default {
  // The Intertec brand is a light identity and the app has a single theme.
  // Nothing adds `.dark` any more, so this stays on the class strategy purely
  // so that a stray `dark:` utility resolves to an inert selector rather than
  // to `prefers-color-scheme`, which would half-style the app for anyone whose
  // OS is set to dark.
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '1.5rem', screens: { '2xl': '1536px' } },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        surface: {
          DEFAULT: 'hsl(var(--surface))',
          elevated: 'hsl(var(--surface-elevated))',
          sunken: 'hsl(var(--surface-sunken))',
        },
        // The gradient's two stops as standalone colours, so panels can build
        // their own sweep (a diagonal, say) instead of being stuck with the
        // horizontal `bg-brand` utility.
        brand: {
          from: 'hsl(var(--brand-from))',
          to: 'hsl(var(--brand-to))',
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
          dark: 'hsl(var(--primary-dark))',
          soft: 'hsl(var(--primary-soft))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
          soft: 'hsl(var(--accent-soft))',
          strong: 'hsl(var(--accent-strong))',
        },
        highlight: {
          DEFAULT: 'hsl(var(--highlight))',
          foreground: 'hsl(var(--highlight-foreground))',
          soft: 'hsl(var(--highlight-soft))',
          strong: 'hsl(var(--highlight-strong))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))',
          soft: 'hsl(var(--success-soft))',
          strong: 'hsl(var(--success-strong))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
          soft: 'hsl(var(--warning-soft))',
          strong: 'hsl(var(--warning-strong))',
        },
        danger: {
          DEFAULT: 'hsl(var(--danger))',
          foreground: 'hsl(var(--danger-foreground))',
          soft: 'hsl(var(--danger-soft))',
          strong: 'hsl(var(--danger-strong))',
        },
        neutral: {
          DEFAULT: 'hsl(var(--neutral))',
          soft: 'hsl(var(--neutral-soft))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar))',
          foreground: 'hsl(var(--sidebar-foreground))',
          muted: 'hsl(var(--sidebar-muted))',
          active: 'hsl(var(--sidebar-active))',
          border: 'hsl(var(--sidebar-border))',
        },
      },
      backgroundImage: {
        // The signature crimson-to-violet band. Reserved for brand moments —
        // hero CTAs, the active nav rail, KPI numerals, the active tab
        // underline — never for ordinary surfaces.
        brand: 'var(--brand-gradient)',
        'brand-y': 'var(--brand-gradient-y)',
        'brand-hover': 'var(--brand-gradient-hover)',
        // What filled buttons take, at every size — see the note on
        // --brand-gradient-diagonal in index.css.
        'brand-diagonal': 'var(--brand-gradient-diagonal)',
        'brand-diagonal-hover': 'var(--brand-gradient-diagonal-hover)',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        xl: 'calc(var(--radius) + 2px)',
      },
      fontFamily: {
        // Poppins is the brand voice and takes headings, nav, buttons and
        // figures. Inter stays on body and data: the app renders a lot of
        // 11-12px text where Poppins' wide geometric forms lose legibility.
        display: ['Poppins', 'Inter var', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['Inter var', 'Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        // Landing page only. Instrument Serif carries the editorial headlines
        // on "/" — its italic is the one voice in the identity that reads as
        // considered rather than corporate. It never appears inside the app.
        serif: ['Instrument Serif', 'ui-serif', 'Georgia', 'serif'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.01em' }],
      },
      boxShadow: {
        // The brand separates surfaces with hairlines, not elevation, so the
        // resting shadows are near-nothing and only genuinely floating things
        // (popovers, dialogs, sheets, the FAB) get real depth. Tinted with the
        // ink colour rather than the old cool navy that no longer exists in
        // the palette.
        xs: '0 1px 2px rgba(12,12,12,0.04)',
        sm: '0 1px 2px rgba(12,12,12,0.04)',
        card: '0 1px 2px rgba(12,12,12,0.04)',
        elevated: '0 8px 24px -8px rgba(12,12,12,0.12), 0 2px 6px rgba(12,12,12,0.04)',
        floating: '0 16px 40px -12px rgba(12,12,12,0.20), 0 4px 10px rgba(12,12,12,0.06)',
        focus: '0 0 0 3px hsl(var(--ring) / 0.28)',
      },
      spacing: { 4.5: '1.125rem', 13: '3.25rem', 15: '3.75rem', 18: '4.5rem', 68: '17rem' },
      keyframes: {
        'accordion-down': { from: { height: '0' }, to: { height: 'var(--radix-accordion-content-height)' } },
        'accordion-up': { from: { height: 'var(--radix-accordion-content-height)' }, to: { height: '0' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        'pulse-ring': {
          '0%': { boxShadow: '0 0 0 0 hsl(var(--success) / 0.5)' },
          '70%': { boxShadow: '0 0 0 5px hsl(var(--success) / 0)' },
          '100%': { boxShadow: '0 0 0 0 hsl(var(--success) / 0)' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.18s ease-out',
        'accordion-up': 'accordion-up 0.18s ease-out',
        shimmer: 'shimmer 1.8s infinite',
        'pulse-ring': 'pulse-ring 2.4s ease-out infinite',
      },
      transitionTimingFunction: { swift: 'cubic-bezier(0.32, 0.72, 0, 1)' },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
