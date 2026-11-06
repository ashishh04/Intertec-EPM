import { apiClient } from './client';
import type { AppRole, ID, MfaAdminView, MfaConfirmed, MfaPolicyView, MfaSetup, MfaStatus } from '@/types';

/**
 * Two-factor authentication. The code itself is only ever checked on the
 * server; the secret reaches the browser once, to be shown to the person's
 * authenticator app, and recovery codes once, to be saved.
 */
export class ApiMfaRepository {
  status(): Promise<MfaStatus> {
    return apiClient.get<MfaStatus>('/auth/mfa');
  }

  startSetup(password?: string): Promise<MfaSetup> {
    return apiClient.post<MfaSetup>('/auth/mfa/setup', password ? { password } : {});
  }

  confirmSetup(code: string): Promise<MfaConfirmed> {
    return apiClient.post<MfaConfirmed>('/auth/mfa/confirm', { code });
  }

  regenerateRecoveryCodes(code: string): Promise<MfaConfirmed> {
    return apiClient.post<MfaConfirmed>('/auth/mfa/recovery-codes', { code });
  }

  disable(code: string, password?: string): Promise<void> {
    return apiClient.post<void>('/auth/mfa/disable', password ? { code, password } : { code });
  }

  adminView(): Promise<MfaAdminView> {
    return apiClient.get<MfaAdminView>('/admin/mfa');
  }

  savePolicy(requiredRoles: AppRole[]): Promise<MfaPolicyView> {
    return apiClient.put<MfaPolicyView>('/admin/mfa/policy', { requiredRoles });
  }

  resetPerson(userId: ID): Promise<void> {
    return apiClient.post<void>(`/admin/mfa/users/${encodeURIComponent(userId)}/reset`);
  }
}
