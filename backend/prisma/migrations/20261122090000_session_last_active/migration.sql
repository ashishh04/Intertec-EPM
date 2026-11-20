-- When the person last did something on a session: signing in, a save, a click
-- or key the page reported. The session ends after EPM_SESSION_IDLE_MINUTES
-- without it (November 2026). Sessions open at the time count from now.
ALTER TABLE "sessions" ADD COLUMN "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
