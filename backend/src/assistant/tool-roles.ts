import type { AppRole } from '../auth/roles.js';

/**
 * Which EPM roles each group of Pragnya's tools is for, matching the screens
 * each role works in (ROLE_ACCESS in the frontend). A tool names one of these
 * in its `roles`; a tool without `roles` is for every internal role.
 *
 * In a module of their own so both tool files can use them: the analysis
 * tools cannot import `tools.ts`, which imports them.
 *
 * External users are in none of these, and `toolAllowed` refuses them every
 * tool besides: Pragnya is not offered in the portal.
 */

/** Team-wide reads about people: workload and everyone's timesheets. */
export const PEOPLE_ROLES: readonly AppRole[] = ['admin', 'manager', 'hr'];

/**
 * Money, portfolio planning and delivery insight: finance, earned value,
 * over-allocation, scenarios, risk and budget exposure, forecasts and the
 * actions recommended from them.
 */
export const MANAGEMENT_ROLES: readonly AppRole[] = ['admin', 'manager'];

/** Sprint delivery, which HR does not work in. */
export const DELIVERY_ROLES: readonly AppRole[] = ['admin', 'manager', 'employee'];
