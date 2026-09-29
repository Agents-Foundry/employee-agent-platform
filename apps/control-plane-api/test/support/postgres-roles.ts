/** Test-only roles and template database; the passwords guard nothing but a throwaway server. */
export const TEST_ROLES = {
  owner: { name: 'af_test_owner', password: 'af-test-owner' },
  tenant: { name: 'af_test_app', password: 'af-test-app' },
  platform: { name: 'af_test_platform', password: 'af-test-platform' },
};
export const TEMPLATE_DATABASE = 'af_test_template';
