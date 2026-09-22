# Admin-created agents and employee assignments

In password-only customer deployments, the admin app now includes **Create and assign agents**. Activate employee accounts first, then refresh the setup panel to load eligible recipients.

## Workflow

1. Enter an agent name and select one to 25 active employees in the current organization.
2. Complete the versioned QA Engineer blueprint questionnaire, model/provider identifiers, and credential-source preference.
3. Review the enforced capabilities and choose **Create and assign**.
4. Each selected employee receives a distinct agent instance with a signed, employee-bound manifest. The admin assignment list records its recipient, creator, and creation time.
5. Employees open **Your assigned agents**, refresh, and choose **Verify and use agent**. Signature, key fingerprint, agent ID, employee ID and organization ID are verified before selection.

Agent creation is an explicit admin action, not an employee request impersonated by the admin. It does not add fabricated employee provisioning requests or bypass runtime policy: browser execution and external writes still require the existing approvals, and production deployment remains denied. Existing employee-request/admin-approval workflows continue unchanged.

## Isolation and retries

The server requires an authenticated organization admin, a valid write Origin, a current blueprint version, valid answers, and active employee identities from that same organization. Pending invites, disabled employees, admins, foreign users and duplicate recipients are rejected. Role, tenant and capabilities cannot be supplied by the browser.

Creation is one transaction, including all manifests, assignments, batch records, and audit entries. A recipient or signing failure rolls the entire batch back. The client supplies a UUID request ID and reuses it for unchanged retries. Server-side idempotency is scoped to the organization and includes the acting admin and validated payload: unchanged retries return the original result; conflicting reuse returns 409. Do not discard the request ID after an uncertain network response. A page reload currently loses the in-memory client retry ID; inspect the assignment list before resubmitting after a reload.

Each employee owns a separate instance and conversation history. An assignment is immutable in this slice: changing recipients requires creating new instances, not moving another employee's conversations or re-signing existing history. The admin list shows admin-created assignments; the existing catalog also includes agents from approved employee requests.

## Boundaries

- The current creation template is QA Engineer; a broader blueprint catalog is future work.
- Model/provider fields are configuration preferences, not active integrations. No secret entry, credential vault, or live model execution is added here.
- The new admin workflow targets database-managed password-mode organizations, not the legacy file-managed Google pilot.
- Reassignment, individual agent retirement, configuration editing/version rollout, seat limits and bulk operations beyond 25 recipients are not implemented.
- Disabling an employee still revokes their sessions and prevents further access to their agents. It does not delete retained conversations or assignments.

Audit events `agent.admin_created`, `agent.assigned`, and `agent.manifest.issued` identify the real admin and organization. Existing tenant and conversation ownership checks protect the employee workflow.
