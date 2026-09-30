/**
 * Tenant domain notifications (ADR 0027): every change that can alter which organization a
 * verified host belongs to notifies `af_tenant_domains` when it commits, so each API instance
 * drops its cached resolutions at once. That includes changes made outside the API, such as an
 * operator suspending an organization. The notification carries no data.
 */
export const tenantDomainNotificationsSql = String.raw`
CREATE FUNCTION af_notify_tenant_domains() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('af_tenant_domains', '');
  RETURN NULL;
END $$;
CREATE TRIGGER organization_domains_notify
 AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON organization_domains
 FOR EACH STATEMENT EXECUTE FUNCTION af_notify_tenant_domains();
CREATE TRIGGER organizations_notify_tenant_domains
 AFTER UPDATE OR DELETE OR TRUNCATE ON organizations
 FOR EACH STATEMENT EXECUTE FUNCTION af_notify_tenant_domains();
`;
