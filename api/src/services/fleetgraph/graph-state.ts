/**
 * FleetGraph state management — graph state initialization and persistence.
 */

import type {
  FleetGraphState,
  FleetGraphMode,
  FleetGraphTrigger,
  HealthSignal,
  Finding,
  CompoundFinding,
  RootCause,
  RecoveryOption,
  PrioritizedAction,
  GraphError,
} from '@ship/shared';

export function createInitialState(
  mode: FleetGraphMode,
  trigger: FleetGraphTrigger
): FleetGraphState {
  return {
    mode,
    trigger,
    data: {
      projects: [],
      sprints: [],
      issues: [],
      team: [],
      activity: {},
      accountability_items: [],
      document_history: [],
    },
    health_signals: [],
    findings: [],
    compound_findings: [],
    root_causes: [],
    recovery_options: [],
    action_queue: [],
    response_draft: '',
    project_narratives: {},
    errors: [],
    suppressed_hashes: [],
    last_checked: {},
  };
}

/** Merge new signals into state (immutable update) */
export function addHealthSignals(state: FleetGraphState, signals: HealthSignal[]): FleetGraphState {
  return { ...state, health_signals: [...state.health_signals, ...signals] };
}

export function addFindings(state: FleetGraphState, findings: Finding[]): FleetGraphState {
  return { ...state, findings: [...state.findings, ...findings] };
}

export function addCompoundFindings(state: FleetGraphState, cf: CompoundFinding[]): FleetGraphState {
  return { ...state, compound_findings: [...state.compound_findings, ...cf] };
}

export function addRootCauses(state: FleetGraphState, rcs: RootCause[]): FleetGraphState {
  return { ...state, root_causes: [...state.root_causes, ...rcs] };
}

export function addRecoveryOptions(state: FleetGraphState, ros: RecoveryOption[]): FleetGraphState {
  return { ...state, recovery_options: [...state.recovery_options, ...ros] };
}

export function addError(state: FleetGraphState, error: GraphError): FleetGraphState {
  return { ...state, errors: [...state.errors, error] };
}

export function setResponseDraft(state: FleetGraphState, draft: string): FleetGraphState {
  return { ...state, response_draft: draft };
}
