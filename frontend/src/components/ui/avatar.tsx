import * as React from 'react';
import * as AvatarPrimitive from '@radix-ui/react-avatar';
import { cn } from '@/lib/utils';
import type { AvatarAccent } from '@/types';

/*
 * The `AvatarAccent` keys are colour literals from the API and are persisted
 * per user, so they stay as they are — but after the Intertec re-skin they no
 * longer describe what you see: `blue` paints violet and `teal` paints the
 * brand's deep teal. Read them as slot names, not colours.
 *
 * Initials are 11-12px on a soft surface, so the text takes the `-strong` step
 * for the same reason `TONE_SOFT` does in lib/domain.ts.
 */
const ACCENT_CLASS: Record<AvatarAccent, string> = {
  blue: 'bg-primary-soft text-primary-dark',
  teal: 'bg-accent-soft text-accent-strong',
  violet: 'bg-highlight-soft text-highlight-strong',
  amber: 'bg-warning-soft text-warning-strong',
  rose: 'bg-danger-soft text-danger-strong',
  slate: 'bg-neutral-soft text-muted-foreground',
};

const SIZE_CLASS = {
  // The smallest face drops its line height instead of using a size off the
  // type scale; two initials still fit at 11px inside 20px.
  xs: 'h-5 w-5 text-2xs leading-none',
  sm: 'h-6 w-6 text-2xs',
  default: 'h-8 w-8 text-xs',
  lg: 'h-10 w-10 text-sm',
  xl: 'h-16 w-16 text-lg',
} as const;

export type AvatarSize = keyof typeof SIZE_CLASS;

const Avatar = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root> & { size?: AvatarSize }
>(({ className, size = 'default', ...props }, ref) => (
  <AvatarPrimitive.Root
    ref={ref}
    className={cn(
      'relative flex shrink-0 select-none overflow-hidden rounded-full',
      SIZE_CLASS[size],
      className,
    )}
    {...props}
  />
));
Avatar.displayName = AvatarPrimitive.Root.displayName;

const AvatarImage = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Image>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Image ref={ref} className={cn('aspect-square h-full w-full', className)} {...props} />
));
AvatarImage.displayName = AvatarPrimitive.Image.displayName;

const AvatarFallback = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Fallback>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback> & { accent?: AvatarAccent }
>(({ className, accent = 'slate', ...props }, ref) => (
  <AvatarPrimitive.Fallback
    ref={ref}
    className={cn(
      'flex h-full w-full items-center justify-center rounded-full font-semibold uppercase tracking-tight',
      ACCENT_CLASS[accent],
      className,
    )}
    {...props}
  />
));
AvatarFallback.displayName = AvatarPrimitive.Fallback.displayName;

export { Avatar, AvatarImage, AvatarFallback, ACCENT_CLASS };
