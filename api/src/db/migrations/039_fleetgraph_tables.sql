-- FleetGraph agent state and insights tables

-- Agent state per entity (tracks polling, suppressions, narrative memory)
CREATE TABLE IF NOT EXISTS fleetgraph_state (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  last_checked_at TIMESTAMPTZ DEFAULT now(),
  last_activity_count INTEGER DEFAULT 0,
  last_findings JSONB DEFAULT '[]'::jsonb,
  suppressed_findings JSONB DEFAULT '[]'::jsonb,
  narrative JSONB DEFAULT '[]'::jsonb,
  health_score JSONB DEFAULT NULL,
  PRIMARY KEY (workspace_id, entity_id)
);

CREATE INDEX idx_fleetgraph_state_workspace ON fleetgraph_state(workspace_id);
CREATE INDEX idx_fleetgraph_state_last_checked ON fleetgraph_state(last_checked_at);

-- Surfaced insights with full reasoning chain
CREATE TABLE IF NOT EXISTS fleetgraph_insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  root_cause JSONB DEFAULT NULL,
  recovery_options JSONB DEFAULT NULL,
  proposed_action JSONB DEFAULT NULL,
  drafted_artifact JSONB DEFAULT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'viewed', 'approved', 'dismissed', 'snoozed')),
  snoozed_until TIMESTAMPTZ DEFAULT NULL,
  target_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_fleetgraph_insights_workspace ON fleetgraph_insights(workspace_id);
CREATE INDEX idx_fleetgraph_insights_entity ON fleetgraph_insights(entity_id);
CREATE INDEX idx_fleetgraph_insights_status ON fleetgraph_insights(status) WHERE status = 'pending';
CREATE INDEX idx_fleetgraph_insights_target_user ON fleetgraph_insights(target_user_id) WHERE target_user_id IS NOT NULL;
CREATE INDEX idx_fleetgraph_insights_created ON fleetgraph_insights(created_at DESC);
