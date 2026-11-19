import { MANAGEMENT_ROLES as LEADERSHIP_ROLES, type AppRole } from '../auth/roles.js';

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

/** Team-wide reads about people: workload and everyone's timesheets. Every leadership role. */
export const PEOPLE_ROLES: readonly AppRole[] = LEADERSHIP_ROLES;

/**
 * Money, portfolio planning and delivery insight: finance, earned value,
 * over-allocation, scenarios, risk and budget exposure, forecasts and the
 * actions recommended from them. Every leadership role.
 */
export const MANAGEMENT_ROLES: readonly AppRole[] = LEADERSHIP_ROLES;

/** Sprint delivery: the people who run projects and the people who do the work. */
export const DELIVERY_ROLES: readonly AppRole[] = [...LEADERSHIP_ROLES, 'employee'];
