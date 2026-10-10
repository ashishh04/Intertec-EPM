import { apiClient } from './client';
import type {
  CalculatedField,
  CalculatedFieldInput,
  CalculatedFieldValidation,
  CalculatedResultType,
  CalculatedStatus,
  CalculatedValue,
  FormulaReference,
  ID,
} from '@/types';

/**
 * Calculated fields (BRQ-04: BR-406 to BR-408): formulas EPM works out on
 * every work package they apply to, and mirrors into an OpenProject field each,
 * so views show, filter, group and sum them like any field. Defining one needs
 * `fields:configure`.
 */
export class ApiCalculatedFieldRepository {
  list(): Promise<CalculatedField[]> {
    return apiClient.get<CalculatedField[]>('/calculated-fields');
  }

  get(id: ID): Promise<CalculatedField> {
    return apiClient.get<CalculatedField>(`/calculated-fields/${id}`);
  }

  /** What a formula can read and call, for the editor. */
  reference(): Promise<FormulaReference> {
    return apiClient.get<FormulaReference>('/calculated-fields/reference');
  }

  status(): Promise<CalculatedStatus> {
    return apiClient.get<CalculatedStatus>('/calculated-fields/status');
  }

  /** Checks a formula as typed and, given a work package, works it out there. Saves nothing. */
  validate(body: {
    id?: ID;
    key?: string;
    name?: string;
    resultType: CalculatedResultType;
    expression: string;
    projectIds?: ID[];
    typeIds?: ID[];
    workPackageId?: ID;
  }): Promise<CalculatedFieldValidation> {
    return apiClient.post<CalculatedFieldValidation>('/calculated-fields/validate', body);
  }

  create(input: CalculatedFieldInput): Promise<CalculatedField> {
    return apiClient.post<CalculatedField>('/calculated-fields', input);
  }

  /** The key and the type are fixed once made. */
  update(id: ID, input: Partial<CalculatedFieldInput>): Promise<CalculatedField> {
    return apiClient.patch<CalculatedField>(`/calculated-fields/${id}`, input);
  }

  setActive(id: ID, active: boolean): Promise<CalculatedField> {
    return apiClient.post<CalculatedField>(`/calculated-fields/${id}/${active ? 'activate' : 'deactivate'}`);
  }

  remove(id: ID): Promise<void> {
    return apiClient.delete<void>(`/calculated-fields/${id}`);
  }

  recalculate(): Promise<CalculatedStatus & { pending?: boolean }> {
    return apiClient.post<CalculatedStatus & { pending?: boolean }>('/calculated-fields/recalculate');
  }

  /** One work package's values, each with why it is empty when it is. */
  workPackageValues(id: ID): Promise<CalculatedValue[]> {
    return apiClient.get<CalculatedValue[]>(`/work-packages/${id}/calculated-values`);
  }
}
