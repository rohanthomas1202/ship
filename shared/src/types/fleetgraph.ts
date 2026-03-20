// FleetGraph — Project Intelligence Agent Types

// ============================================================
// Graph State
// ============================================================

export type FleetGraphMode = 'proactive' | 'on_demand';

export type FleetGraphTriggerType = 'schedule' | 'websocket_event' | 'user_chat';

export interface FleetGraphTrigger {
  type: FleetGraphTriggerType;
  entity?: { type: string; id: string };
  user_id?: string;
  user_role?: 'admin' | 'member';
  user_person_id?: string;
  workspace_id: string;
  chat_message?: string;
  chat_history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface FleetGraphState {
  mode: FleetGraphMode;
  trigger: FleetGraphTrigger;

  // Fetched data
  data: FleetGraphData;

  // Analysis pipeline
  health_signals: HealthSignal[];
  findings: Finding[];
  compound_findings: CompoundFinding[];
  root_causes: RootCause[];
  recovery_options: RecoveryOption[];
  action_queue: PrioritizedAction[];

  // On-demand chat
  response_draft: string;

  // Narrative memory
  project_narratives: Record<string, string[]>;

  // Meta
  errors: GraphError[];
  suppressed_hashes: string[];
  last_checked: Record<string, string>;
}

export interface FleetGraphData {
  projects: any[];
  sprints: any[];
  issues: any[];
  team: any[];
  activity: Record<string, Array<{ date: string; count: number }>>;
  accountability_items: any[];
  document_history: any[];
}

// ============================================================
// Health Signals & Findings
// ============================================================

export type SignalType =
  | 'ghost_blocker'
  | 'scope_creep'
  | 'velocity_decay'
  | 'team_overload'
  | 'accountability_cascade'
  | 'confidence_drift'
  | 'approval_bottleneck'
  | 'blocker_chain'
  | 'sprint_collapse';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface HealthSignal {
  type: SignalType;
  entity_id: string;
  entity_type: string;
  description: string;
  data: Record<string, any>;
  detected_at: string;
}

export interface Finding {
  id: string;
  signal_type: SignalType;
  severity: Severity;
  title: string;
  description: string;
  affected_entities: Array<{ type: string; id: string; title?: string }>;
  data: Record<string, any>;
  confidence: number; // 0-1
  source: 'reasoning' | 'heuristic' | 'deterministic';
  proposed_action?: ProposedAction;
}

export interface CompoundFinding {
  id: string;
  root_entity_id: string;
  root_entity_type: string;
  findings: Finding[];
  combined_severity: Severity;
  coordinated_recommendation: string;
}

// ============================================================
// Root Cause & Recovery
// ============================================================

export interface RootCause {
  finding_id: string;
  explanation: string;
  contributing_factors: Array<{
    factor: string;
    evidence: string;
    source_entity_id?: string;
  }>;
  temporal_context?: string; // "This started in Week 11 when..."
}

export interface RecoveryOption {
  id: string;
  finding_id: string;
  description: string;
  projected_impact: {
    timeline_change_days: number;
    story_points_affected: number;
    entities_unblocked: string[];
  };
  risks: string[];
  confidence: number; // 0-1
  requires_reassignment?: {
    issue_id: string;
    from_person_id: string;
    to_person_id: string;
  };
}

// ============================================================
// Actions
// ============================================================

export interface ProposedAction {
  type: 'comment' | 'reassign' | 'state_change' | 'create_issue' | 'scope_change';
  entity_id: string;
  entity_type: string;
  payload: Record<string, any>;
  description: string;
}

export interface PrioritizedAction {
  rank: number;
  target_user_id: string;
  target_user_role: 'director' | 'pm' | 'engineer';
  action_description: string;
  entity_id: string;
  entity_type: string;
  urgency: number;
  impact: number;
  finding_id?: string;
}

export interface DraftedArtifact {
  type: 'comment' | 'standup' | 'retro' | 'pm_update';
  target_entity_id: string;
  content: string;
  metadata?: Record<string, any>;
}

// ============================================================
// Insights (persisted)
// ============================================================

export type InsightStatus = 'pending' | 'viewed' | 'approved' | 'dismissed' | 'snoozed';

export interface FleetGraphInsight {
  id: string;
  workspace_id: string;
  entity_id: string;
  entity_type: string;
  severity: Severity;
  category: string;
  title: string;
  content: Record<string, any>;
  root_cause?: RootCause;
  recovery_options?: RecoveryOption[];
  proposed_action?: ProposedAction;
  drafted_artifact?: DraftedArtifact;
  status: InsightStatus;
  snoozed_until?: string;
  target_user_id?: string;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Health Score
// ============================================================

export interface HealthSubScore {
  name: string;
  score: number; // 0-100
  description: string;
  finding_ids: string[];
}

export interface ProjectHealthScore {
  overall: number; // 0-100
  sub_scores: {
    velocity: HealthSubScore;
    blockers: HealthSubScore;
    workload: HealthSubScore;
    issue_freshness: HealthSubScore;
    approval_flow: HealthSubScore;
    accountability: HealthSubScore;
  };
  computed_at: string;
}

// ============================================================
// API Request/Response Types
// ============================================================

export interface FleetGraphChatRequest {
  entity_type: string;
  entity_id: string;
  message: string;
  chat_history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface FleetGraphChatResponse {
  message: string;
  findings?: Finding[];
  proposed_actions?: ProposedAction[];
  recovery_options?: RecoveryOption[];
  health_score?: ProjectHealthScore;
}

export interface FleetGraphInsightsResponse {
  insights: FleetGraphInsight[];
  health_scores: Record<string, ProjectHealthScore>;
}

// ============================================================
// Graph Error
// ============================================================

export interface GraphError {
  node: string;
  error: string;
  recovered: boolean;
  fallback_used?: string;
}
