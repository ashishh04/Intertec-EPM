import { Avatar, AvatarFallback, AvatarImage, type AvatarSize } from '@/components/ui/avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { EpmUser, UserStatus } from '@/types';

const STATUS_RING: Record<UserStatus, string> = {
  online: 'bg-success',
  away: 'bg-warning',
  offline: 'bg-neutral',
};

const STATUS_LABEL: Record<UserStatus, string> = {
  online: 'Online',
  away: 'Away',
  offline: 'Offline',
};

interface UserAvatarProps {
  user?: Pick<EpmUser, 'name' | 'initials' | 'accent' | 'avatarUrl' | 'status'>;
  size?: AvatarSize;
  showStatus?: boolean;
  className?: string;
}

/** Initials-based avatar, used whenever a user has no avatar image. */
function UserAvatar({ user, size = 'default', showStatus = false, className }: UserAvatarProps) {
  const label = user ? user.name : 'Unassigned';

  return (
    <span className={cn('relative inline-flex shrink-0', className)}>
      <Avatar size={size}>
        {user?.avatarUrl ? <AvatarImage src={user.avatarUrl} alt="" /> : null}
        <AvatarFallback accent={user?.accent ?? 'slate'}>
          {user?.initials ?? '–'}
          <span className="sr-only">{label}</span>
        </AvatarFallback>
      </Avatar>
      {showStatus && user ? (
        <span
          className={cn(
            'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface',
            STATUS_RING[user.status],
          )}
        >
          <span className="sr-only">{STATUS_LABEL[user.status]}</span>
        </span>
      ) : null}
    </span>
  );
}

/** Avatar with the person's name in a tooltip, for dense list contexts. */
function UserAvatarWithTooltip({ user, ...props }: UserAvatarProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0">
          <UserAvatar user={user} {...props} />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {user ? `${user.name}` : 'Unassigned'}
      </TooltipContent>
    </Tooltip>
  );
}

interface AvatarGroupProps {
  users: (EpmUser | undefined)[];
  max?: number;
  size?: AvatarSize;
  className?: string;
}

/** Sizes for the "+N" overflow chip, kept in step with the avatar sizes. */
const OVERFLOW_SIZE: Record<AvatarSize, string> = {
  xs: 'h-5 w-5 text-[9px]',
  sm: 'h-6 w-6 text-[10px]',
  default: 'h-8 w-8 text-xs',
  lg: 'h-10 w-10 text-sm',
  xl: 'h-16 w-16 text-lg',
};

/**
 * Avatar stack with a "+N" overflow chip.
 *
 * The overlap is deliberately shallow: these are initials, not photographs, and
 * a deeper stack would clip the glyphs of every avatar but the last.
 */
function AvatarGroup({ users, max = 4, size = 'sm', className }: AvatarGroupProps) {
  const known = users.filter(Boolean) as EpmUser[];
  const visible = known.slice(0, max);
  const overflow = known.length - visible.length;

  return (
    <div className={cn('flex items-center -space-x-0.5', className)}>
      {visible.map((user) => (
        <UserAvatarWithTooltip
          key={user.id}
          user={user}
          size={size}
          className="rounded-full ring-2 ring-surface"
        />
      ))}
      {overflow > 0 ? (
        <span
          className={cn(
            'inline-flex shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-muted-foreground ring-2 ring-surface',
            OVERFLOW_SIZE[size],
          )}
        >
          +{overflow}
        </span>
      ) : null}
    </div>
  );
}

export { UserAvatar, UserAvatarWithTooltip, AvatarGroup, STATUS_LABEL };
