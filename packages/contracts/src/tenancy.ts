export interface OrganizationProfile {
  id: string;
  name: string;
  legalName: string;
  code: string;
  slug: string;
  website: string;
  industry: string;
  country: string;
  timezone: string;
  locale: string;
  status: 'active' | 'suspended' | 'disabled';
  version: number;
  updatedAt: string;
}
export interface TenantDomain {
  id: string;
  organizationId: string;
  domain: string;
  domainType: 'custom_domain' | 'platform_subdomain' | 'internal';
  isPrimary: boolean;
  verificationStatus: 'pending' | 'verified' | 'disabled';
  verificationToken: string | null;
  verifiedAt: string | null;
  version: number;
}
export interface EmploymentRecord {
  id: string;
  organizationId: string;
  userId: string | null;
  displayName: string;
  email: string;
  employeeNumber: string | null;
  employmentType: 'employee' | 'contractor' | 'external';
  employmentStatus: 'active' | 'inactive';
  version: number;
  positionId: string | null;
  positionTitle: string | null;
  unitName: string | null;
  roleName: string | null;
  levelName: string | null;
}
export interface OrganizationMembership {
  id: string;
  userId: string;
  employeeId: string;
  displayName: string;
  email: string;
  securityRole: 'ADMIN' | 'EMPLOYEE';
  membershipStatus: 'pending' | 'active' | 'suspended';
  version: number;
}
