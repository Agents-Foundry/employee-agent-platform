// Role-independent execution domain (Architecture V2, ADR 0003 and ADR 0008).
// Pure types and constants: safe for Angular, Node and future runtime hosts.
import type { ArtifactSummary, EvidenceReference } from './artifacts.js';

export type Iso8601 = string;

/** Correlation chain carried by every run-scoped record and runtime message. */
export interface RuntimeCorrelation {
  organizationId: string;
  employeeId: string;
  agentId: string;
  threadId: string;
  runId: string;
  stepId?: string;
  toolCallId?: string;
  actionId?: string;
}

/** Opaque reference to a work item in any issue tracker; never provider-specific logic. */
export interface WorkItemReference {
  system: string;
  key: string;
  url?: string;
}

export type TaskInputValue = string | number | boolean | string[];

/** The business objective a run works toward. Persisted with the run that executes it. */
export interface TaskSpec {
  objective: string;
  workflow?: string;
  workItem?: WorkItemReference;
  inputs: Record<string, TaskInputValue>;
}

export const threadStatuses = ['ACTIVE', 'ARCHIVED'] as const;
export type ThreadStatus = (typeof threadStatuses)[number];

/** Durable work context. A thread hosts successive runs and, later, one workspace. */
export interface Thread {
  id: string;
  organizationId: string;
  employeeId: string;
  agentId: string;
  conversationId: string | null;
  title: string;
  status: ThreadStatus;
  createdAt: Iso8601;
  updatedAt: Iso8601;
}

export const agentRunStatuses = [
  'QUEUED',
  'RUNNING',
  'WAITING_FOR_APPROVAL',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type AgentRunStatus = (typeof agentRunStatuses)[number];

export const manifestApiVersions = ['agents-foundry/v1', 'agents-foundry/v2'] as const;
export type ManifestApiVersion = (typeof manifestApiVersions)[number];

export interface ManifestReference {
  manifestId: string;
  apiVersion: ManifestApiVersion;
  keyId: string;
}

/** One autonomous invocation within a thread. */
export interface AgentRun {
  id: string;
  organizationId: string;
  threadId: string;
  employeeId: string;
  agentId: string;
  /** Null only for the unsigned local-demo agent. */
  manifest: ManifestReference | null;
  task: TaskSpec;
  runtimeProfile: string;
  status: AgentRunStatus;
  statusReason: string | null;
  /** Link to the legacy QA record while QA migrates (ADR 0003). */
  legacyQaRunId: string | null;
  createdAt: Iso8601;
  updatedAt: Iso8601;
  startedAt: Iso8601 | null;
  completedAt: Iso8601 | null;
}

export const runStepKinds = ['PLAN', 'MODEL', 'TOOL', 'ACTION', 'MESSAGE'] as const;
export type RunStepKind = (typeof runStepKinds)[number];

export const runStepStatuses = [
  'PENDING',
  'RUNNING',
  'WAITING_FOR_APPROVAL',
  'COMPLETED',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
] as const;
export type RunStepStatus = (typeof runStepStatuses)[number];

export interface RunStep {
  id: string;
  organizationId: string;
  runId: string;
  sequence: number;
  kind: RunStepKind;
  title: string;
  status: RunStepStatus;
  detail: Record<string, unknown>;
  createdAt: Iso8601;
  startedAt: Iso8601 | null;
  completedAt: Iso8601 | null;
}

/** Events only the control plane may record; a runtime can never emit these. */
export const controlPlaneEventTypes = [
  'run.created',
  'user.message',
  'approval.requested',
  'approval.approved',
  'approval.rejected',
] as const;

/** Events an agent runtime may emit through `agents-foundry/runtime/v1`. */
export const runtimeEventTypes = [
  'run.started',
  'run.paused',
  'run.resumed',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'step.started',
  'step.completed',
  'step.failed',
  'agent.message',
  'agent.reasoning.started',
  'model.requested',
  'model.responded',
  'tool.requested',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'artifact.created',
] as const;

export type ControlPlaneEventType = (typeof controlPlaneEventTypes)[number];
export type RuntimeEventType = (typeof runtimeEventTypes)[number];
export type AgentEventType = ControlPlaneEventType | RuntimeEventType;
export const agentEventTypes: readonly AgentEventType[] = [
  ...controlPlaneEventTypes,
  ...runtimeEventTypes,
];

export type AgentEventSource = 'CONTROL_PLANE' | 'RUNTIME';

/** Append-only run history (product/runtime events, distinct from security audit events). */
export interface AgentEvent {
  id: string;
  organizationId: string;
  threadId: string;
  runId: string;
  stepId: string | null;
  sequence: number;
  type: AgentEventType;
  source: AgentEventSource;
  actorId: string | null;
  payload: Record<string, unknown>;
  occurredAt: Iso8601;
  recordedAt: Iso8601;
}

export interface ExecutionError {
  code: string;
  message: string;
}

export interface ToolCall {
  id: string;
  runId: string;
  stepId: string;
  toolId: string;
  toolVersion: string;
  /** SHA-256 of the canonical input; raw input stays in the runtime. */
  inputDigest: string;
  requestedAt: Iso8601;
}

export interface ToolResult {
  toolCallId: string;
  status: 'SUCCEEDED' | 'FAILED' | 'DENIED';
  outputDigest?: string;
  error?: ExecutionError;
  artifactIds: string[];
  durationMs: number;
  completedAt: Iso8601;
}

export const approvalRisks = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type ApprovalRisk = (typeof approvalRisks)[number];

/** Generic governed-action approval request (target shape for the Action Gateway, ADR 0005). */
export interface ApprovalRequest {
  id: string;
  organizationId: string;
  action: string;
  risk: ApprovalRisk;
  requestedBy: string;
  agentId: string | null;
  runId: string | null;
  stepId: string | null;
  resource: { type: string; id: string };
  summary: string;
  evidence: EvidenceReference[];
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  requestedAt: Iso8601;
  expiresAt: Iso8601 | null;
  decidedBy?: string;
  decidedAt?: Iso8601;
  decisionReason?: string;
}

export const workspaceStates = [
  'PROVISIONING',
  'READY',
  'IN_USE',
  'SUSPENDED',
  'LOST',
  'DESTROYED',
] as const;
export type WorkspaceState = (typeof workspaceStates)[number];

export interface RepositoryMapping {
  repositoryUrl: string;
  ref: string;
  path: string;
}

/** Execution-runtime workspace (contracts only in Phase A, ADR 0007). */
export interface Workspace {
  id: string;
  organizationId: string;
  employeeId: string;
  agentId: string;
  threadId: string;
  provider: string;
  environment: string | null;
  repositories: RepositoryMapping[];
  state: WorkspaceState;
  createdAt: Iso8601;
}

/** How a run is bound to a workspace when submitted to a runtime. */
export interface WorkspaceBinding {
  workspaceId: string;
  /** A missing persistent workspace must fail the run, never be silently recreated. */
  persistence: 'EPHEMERAL' | 'PERSISTENT';
}

export interface ResourceLimits {
  timeoutMs: number;
  cpuMillis: number;
  memoryMb: number;
  maxProcesses: number;
  network: { mode: 'NONE' | 'ALLOW_LIST'; allowedHosts: string[] };
}

export type ExecutionOperation =
  | { kind: 'command'; command: string; args: string[]; cwd: string }
  | { kind: 'file.read'; path: string }
  | { kind: 'file.write'; path: string; contentArtifactId: string }
  | { kind: 'git.checkout'; repositoryUrl: string; ref: string; path: string }
  | { kind: 'git.status'; path: string }
  | { kind: 'playwright.run'; project: string; baseUrl: string };

export interface ExecutionRequest {
  id: string;
  correlation: RuntimeCorrelation;
  workspaceId: string;
  operation: ExecutionOperation;
  limits: ResourceLimits;
}

export interface ExecutionResult {
  requestId: string;
  status: 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'DENIED';
  exitCode?: number;
  artifactIds: string[];
  durationMs: number;
  error?: ExecutionError;
}

/** A runtime process's claim on a run; heartbeats detect abandoned runs. */
export interface RuntimeSession {
  id: string;
  runtimeId: string;
  organizationId: string;
  runId: string;
  state: 'ACTIVE' | 'CLOSED';
  startedAt: Iso8601;
  heartbeatAt: Iso8601;
}

/** Read models served by `/api/execution/v1`. */
export interface ThreadDetail {
  thread: Thread;
  runs: AgentRun[];
}

export interface RunApprovalSummary {
  id: string;
  action: string;
  risk: ApprovalRisk;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  stepId: string | null;
  createdAt: Iso8601;
  decidedAt?: Iso8601;
}

export interface AgentRunDetail {
  run: AgentRun;
  steps: RunStep[];
  approvals: RunApprovalSummary[];
  artifacts: ArtifactSummary[];
}

export interface AgentEventPage {
  items: AgentEvent[];
  nextAfterSequence: number;
}
