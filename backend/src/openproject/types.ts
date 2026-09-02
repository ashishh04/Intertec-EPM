/**
 * OpenProject API v3 HAL shapes.
 *
 * These are raw upstream payloads and must not leak past `src/mapping/` — the
 * frontend contract is the flat EPM model in `src/types/epm.ts`.
 */

export interface HalLink {
  href: string | null;
  title?: string;
  templated?: boolean;
  method?: string;
}

export type HalLinks = Record<string, HalLink | HalLink[] | undefined>;

export interface HalResource {
  _type?: string;
  _links?: HalLinks;
}

export interface HalCollection<T> extends HalResource {
  total: number;
  count: number;
  pageSize?: number;
  offset?: number;
  _embedded: { elements: T[] };
}

/** OpenProject renders long text as `{ format, raw, html }`. */
export interface Formattable {
  format: 'markdown' | 'textile' | 'plain';
  raw: string | null;
  html?: string | null;
}

export interface OpPrincipal extends HalResource {
  id: number;
  name: string;
  firstName?: string;
  lastName?: string;
  email?: string | null;
  login?: string;
  admin?: boolean;
  status?: 'active' | 'invited' | 'registered' | 'locked';
  avatar?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface OpProject extends HalResource {
  id: number;
  identifier: string;
  name: string;
  active: boolean;
  public: boolean;
  description?: Formattable;
  statusExplanation?: Formattable;
  createdAt: string;
  updatedAt: string;
}

export interface OpWorkPackage extends HalResource {
  id: number;
  subject: string;
  description?: Formattable;
  startDate?: string | null;
  dueDate?: string | null;
  date?: string | null;
  derivedStartDate?: string | null;
  derivedDueDate?: string | null;
  estimatedTime?: string | null;
  derivedEstimatedTime?: string | null;
  spentTime?: string | null;
  percentageDone?: number | null;
  createdAt: string;
  updatedAt: string;
  lockVersion: number;
}

export interface OpStatus extends HalResource {
  id: number;
  name: string;
  isClosed: boolean;
  isDefault: boolean;
  position: number;
  defaultDoneRatio?: number | null;
}

export interface OpType extends HalResource {
  id: number;
  name: string;
  isMilestone: boolean;
  isDefault: boolean;
  position: number;
  color?: string;
}

export interface OpPriority extends HalResource {
  id: number;
  name: string;
  isDefault: boolean;
  position: number;
  active: boolean;
}

export interface OpVersion extends HalResource {
  id: number;
  name: string;
  description?: Formattable;
  startDate?: string | null;
  endDate?: string | null;
  status: 'open' | 'locked' | 'closed';
  sharing: string;
  createdAt: string;
  updatedAt: string;
}

export interface OpMembership extends HalResource {
  id: number;
  createdAt: string;
  updatedAt: string;
}

export interface OpTimeEntry extends HalResource {
  id: number;
  comment?: Formattable;
  spentOn: string;
  hours: string;
  createdAt: string;
  updatedAt: string;
}

export interface OpActivity extends HalResource {
  id: number;
  comment?: Formattable;
  details?: Formattable[];
  version?: number;
  createdAt: string;
  updatedAt?: string;
}

export interface OpNotification extends HalResource {
  id: number;
  reason: string;
  readIAN: boolean;
  createdAt: string;
  updatedAt: string;
  subject?: string;
  message?: Formattable;
}

export interface OpAttachment extends HalResource {
  id: number;
  fileName: string;
  fileSize: number;
  description?: Formattable;
  contentType: string;
  digest?: { algorithm: string; hash: string };
  createdAt: string;
}

export interface OpRoot extends HalResource {
  instanceName: string;
  coreVersion: string;
  productVersion?: string;
  userPreferences?: unknown;
}

/** OpenProject's own error body. */
export interface OpErrorBody {
  _type?: 'Error';
  errorIdentifier?: string;
  message?: string;
  _embedded?: { details?: { attribute?: string }; errors?: OpErrorBody[] };
}
