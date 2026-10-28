import type { OpFilter } from './client.js';

/**
 * Every user — active, registered, locked and invited — as `/principals`
 * lists them: the same people `/users` does, without needing OpenProject's
 * "manage users" permission. EPM's service account reads the directory this
 * way (NFR06): it holds only "view all principals" and "view user email",
 * which give every field EPM reads except whether someone is an administrator.
 */
export const EVERY_USER: OpFilter[] = [
  { field: 'type', operator: '=', values: ['User'] },
  { field: 'status', operator: '=', values: ['1', '2', '3', '4'] },
];
