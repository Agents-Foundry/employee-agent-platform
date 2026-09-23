export const jobKinds = ['families', 'disciplines', 'roles', 'levels', 'positions'] as const;
export type JobKind = (typeof jobKinds)[number];
export interface JobRecord {
  id: string;
  organizationId: string;
  name: string;
  code: string;
  description: string;
  status: 'active' | 'archived';
  version: number;
  createdAt: string;
  updatedAt: string;
  jobFamilyId?: string;
  disciplineId?: string;
  rank?: number;
  organizationalUnitId?: string;
  roleId?: string;
  jobLevelId?: string;
  reportsToPositionId?: string | null;
  referenceNames?: Record<string, string>;
}
