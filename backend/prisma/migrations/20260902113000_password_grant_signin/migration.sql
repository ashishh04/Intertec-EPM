-- The authorization-code redirect flow is replaced by password sign-in, so the
-- table that held PKCE state between redirect and callback is no longer used.
DROP TABLE IF EXISTS "auth_requests";
