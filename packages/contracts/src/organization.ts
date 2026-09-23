export const unitTypes = [
  'business_unit',
  'division',
  'department',
  'sub_department',
  'team',
  'squad',
  'pod',
  'chapter',
  'guild',
  'other',
] as const;
export type UnitType = (typeof unitTypes)[number];
export interface OrganizationUnitInput {
  name: string;
  code: string;
  unitType: UnitType;
  parentId: string | null;
  description: string;
}
export interface OrganizationUnit extends OrganizationUnitInput {
  parentName?: string | null;
  headPositionId: string | null;
  headPositionName: string | null;
  headEmployeeName: string | null;
  id: string;
  organizationId: string;
  status: 'active' | 'archived';
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
export interface UnitMembership {
  id: string;
  employeeId: string;
  displayName: string;
  membershipType: 'member' | 'lead' | 'manager' | 'owner' | 'contributor';
  isPrimary: boolean;
  startedAt: string;
  endedAt: string | null;
  version: number;
}
