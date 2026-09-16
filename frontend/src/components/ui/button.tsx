import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { ArrowUpRight, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/*
 * Buttons carry most of the Intertec identity: every one is a pill. `link` is
 * the one variant that stays square, because it is text rather than a control.
 *
 * There used to be two filled variants — solid violet for ordinary primary
 * actions, the crimson-to-violet sweep reserved for wide calls to action —
 * because a 90deg sweep degrades badly on a small control. That produced a
 * product where "New task", "Start sprint" and "Sync now" were flat violet
 * while the sign-in button next to them carried the brand. The sweep now runs
 * at 135deg instead, which survives any aspect ratio, so there is one filled
 * treatment and every primary action wears it.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full font-display text-sm font-semibold transition-[background-image,background-color,color,border-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-brand-diagonal text-white hover:bg-brand-diagonal-hover',
        secondary: 'border border-border bg-surface text-foreground hover:bg-muted',
        ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground',
        subtle: 'bg-muted text-foreground hover:bg-border/70',
        outline: 'border border-primary/40 bg-transparent text-primary hover:bg-primary-soft',
        danger: 'bg-danger text-danger-foreground hover:bg-danger/90',
        link: 'rounded-none text-primary underline-offset-4 hover:underline',
      },
      size: {
        // Pills need a little more horizontal room than rounded rectangles
        // before the label stops looking crowded by the curve.
        sm: 'h-8 px-3 text-xs',
        default: 'h-9 px-4',
        lg: 'h-10 px-5',
        icon: 'h-9 w-9',
        'icon-sm': 'h-8 w-8',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

/** Padding on the arrow side tightens, the way the site's CTAs are set. */
const ARROW_INSET: Record<string, string> = {
  sm: 'pr-1',
  default: 'pr-1',
  lg: 'pr-1.5',
};

/**
 * The circular arrow chip the site puts on its calls to action. It is a brand
 * flourish, not an affordance, so it is hidden from assistive tech — the
 * button's own label already says what happens.
 */
function ArrowChip({ size }: { size: 'sm' | 'default' | 'lg' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'ml-0.5 grid shrink-0 place-items-center rounded-full bg-white/25',
        size === 'lg' ? 'h-7 w-7' : size === 'sm' ? 'h-5 w-5' : 'h-6 w-6',
      )}
    >
      {/* `!size-*` because the base `[&_svg]:size-4` descendant rule outranks
          a plain utility on the icon itself. */}
      <ArrowUpRight className={size === 'sm' ? '!size-3' : '!size-3.5'} />
    </span>
  );
}

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
  /**
   * Adds the brand's circular arrow chip. Reserved for calls to action that
   * move you somewhere — hero buttons, the sign-in button, empty-state
   * prompts. Toolbars stay plain, or the flourish stops meaning anything.
   */
  arrow?: boolean;
}

/** The chip needs a filled, light-on-dark pill behind it to read as the mark. */
const ARROW_VARIANTS = new Set(['default']);

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, asChild = false, loading = false, arrow = false, children, disabled, ...props },
    ref,
  ) => {
    const Comp = asChild ? Slot : 'button';
    const chipSize = size === 'sm' ? 'sm' : size === 'lg' ? 'lg' : 'default';
    const showArrow =
      arrow && ARROW_VARIANTS.has(variant ?? 'default') && size !== 'icon' && size !== 'icon-sm';
    const classes = cn(buttonVariants({ variant, size, className }), showArrow && ARROW_INSET[chipSize]);

    if (asChild) {
      // Slot needs exactly one child, so the chip is folded into the consumer's
      // element rather than rendered as a sibling.
      return (
        <Comp className={classes} ref={ref} {...props}>
          {showArrow && React.isValidElement(children)
            ? React.cloneElement(children as React.ReactElement, undefined, (
                <>
                  {(children as React.ReactElement).props.children}
                  <ArrowChip size={chipSize} />
                </>
              ))
            : children}
        </Comp>
      );
    }

    return (
      <Comp
        className={classes}
        ref={ref}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading ? <Loader2 className="animate-spin" aria-hidden /> : null}
        {children}
        {showArrow ? <ArrowChip size={chipSize} /> : null}
      </Comp>
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
