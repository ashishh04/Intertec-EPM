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
   * Sent once and never stored on either side. Optional when an invitation is
   * sent: the server then generates one that nobody ever sees, and the person
   * chooses their own from the link. Required when no invitation goes out,
   * because otherwise nobody created that way could ever sign in.
   */
  password?: string;
  /**
   * Email the person a link to set their own password. The server defaults
   * this to true when an email address is given, so it is only worth sending
   * to turn it off.
   */
  sendInvite?: boolean;
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
  /** Whether an invitation email actually went out. */
  inviteSent: boolean;
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

  /** A fresh invitation link; any earlier one stops working. */
  resendInvite(id: ID): Promise<{ inviteSent: boolean }> {
    return apiClient.post<{ inviteSent: boolean }>(`/accounts/${id}/invite`);
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
