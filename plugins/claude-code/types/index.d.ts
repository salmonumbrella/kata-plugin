export type WorkflowCompletion = {verified: boolean; files: string[]; statements: string[]};
export type Evidence = { commits: string[]; prs: string[]; tests: string[]; written: string[] };
export type Verification = { evidence: Evidence; verified: boolean; failedChecks: string[]; incomplete?: boolean; unknownWrites?: boolean; unknownWritePaths?: boolean; codeWrites?: boolean; documentationStatement?: string };
export type KataStatus =
  "running" | "completed" | "failed" | "killed" | "denied" | "session-ended";
export type KataReply = { turnId: string; answer: string; reason: string; messageDriven?: boolean; incomplete?: boolean; documentationStatement?: string; workflowCompletion?: WorkflowCompletion };
export type KataEntry = {
  workflowCompletion?: WorkflowCompletion;
  evidence?: Evidence;
  verification?: Verification;
  scope?: string;
  project?: string;
  workspace?: string;
  repositoryRoot?: string;
  title?: string;
  closedBy?: "agent" | "mod";
  ref?: string;
  teammate: string;
  workflowName?: string;
  workflowRemote?: boolean;
  status: KataStatus;
  parent: string;
  toolId: string;
  background?: boolean;
  agentId?: string;
  teammateId?: string;
  reply?: KataReply;
  statusEffect?: string;
  fallbackJoined?: boolean;
  messagingTurn?: boolean;
  priorReplies?: KataReply[];
  finished?: { from: string; timestamp: string; result: string };
  finishedThrough?: string;
  /** Tracking is bound to an existing issue the spawn named; no child was created. */
  bound?: boolean;
  /** Why a named issue was not bound (written as claude.binding_note on the child). */
  bindingNote?: string;
};
export type KataOperation = {
  id: string;
  kind: "create" | "meta" | "deny" | "report" | "auto-meta" | "reparent" | "close" | "parent-close" | "observe";
  entry: "spawn" | "run";
  key: string;
  ref?: string;
  parent?: string;
  args?: string[];
  prepare?: boolean;
  context?: KataSession;
  metadata?: Record<string, string>;
  status?: KataStatus;
  marker?: string;
  body?: string;
  attempts: number;
  deadline?: number;
  ack?: boolean;
  notBefore?: number;
  closeAttempted?: boolean;
  ownerSessionId?: string;
  ownerBindingKey?: string;
  sessionId?: string;
  scope?: string;
  project?: string;
  workspace?: string;
};
export type KataSession = {
  id: string;
  parent?: string | null;
  autoParent?: string;
  autoParentWorkspace?: string;
  autoParentProject?: string;
  autoParentClosed?: boolean;
  firstPrompt?: string;
  firstPromptTitle?: string;
  /** Issue the first user prompt names as its work; adopted as parent at first delegation. */
  promptRef?: string;
  /** Why the first prompt's named issue was not adopted. */
  promptRefNote?: string;
  sessionName?: string;
  bindingVersion?: number;
  cwd?: string;
  repositoryRoot?: string;
  workspace?: string;
  scope?: string;
  project?: string;
  mainActive?: boolean;
  ended?: boolean;
  parentGeneration?: number;
  autoDisabled?: boolean;
  unbound?: boolean;
};
declare module "claude-code" {
  interface PluginState {
    "kata": {
      session: KataSession;
      contract: {id: string; text?: string};
      spawn: StateFamily<KataEntry>;
      agent: StateFamily<string>;
      run: StateFamily<KataEntry>;
      early: StateFamily<KataReply[]>;
    };
  }
}
