import { apiClient } from './client';
import type { EpmAccount, ID } from '@/types';

/**
 * User accounts.
 *
 * Accounts live upstream; nothing here is stored by EPM. Separate from
 * `userService`, which reads the ordinary directory: that carries no login, no
 * email for most callers and no account state, because it is built from
 * principals rather than the administration endpoint.
 *
 * `create` is the one call that spans both stores — it makes the sign-in
 * account and writes the EPM department, team and capacity in one step.
 */

export interface AccountInput {
  login: string;
  firstName: string;
  lastName: string;
  email: string;
  /**
   * The starting password, on create only.
   *
   * Sent once and never stored on either side. Required because this
   * deployment has no mail transport: an emailed invitation would leave the
   * person with no password and no way to receive one.
   */
  password?: string;
  language?: string;
  admin?: boolean;
  /** EPM placement, all optional. */
  departmentId?: ID;
  teamId?: ID;
  hoursCapacity?: number;
}

/**
 * The account, plus anything that went wrong *after* it was created.
 *
 * The account exists either way, so a failed placement is reported rather than
 * rolled back — pretending nothing happened would leave an orphan upstream.
 */
export interface CreatedAccount extends EpmAccount {
  placementProblems?: string[];
}

export class ApiAccountRepository {
  list(): Promise<EpmAccount[]> {
    return apiClient.get<EpmAccount[]>('/accounts');
  }

  get(id: ID): Promise<EpmAccount> {
    return apiClient.get<EpmAccount>(`/accounts/${id}`);
  }

  create(input: AccountInput): Promise<CreatedAccount> {
    return apiClient.post<CreatedAccount>('/accounts', input);
  }

  update(id: ID, patch: Partial<AccountInput>): Promise<EpmAccount> {
    return apiClient.patch<EpmAccount>(`/accounts/${id}`, patch);
  }

  /** Deactivate. Reversible, and the reason there is rarely a need to delete. */
  lock(id: ID): Promise<EpmAccount> {
    return apiClient.post<EpmAccount>(`/accounts/${id}/lock`);
  }

  unlock(id: ID): Promise<EpmAccount> {
    return apiClient.delete<EpmAccount>(`/accounts/${id}/lock`);
  }

  /** Permanent, and only offered where the instance allows it at all. */
  remove(id: ID): Promise<void> {
    return apiClient.delete<void>(`/accounts/${id}`);
  }
}
