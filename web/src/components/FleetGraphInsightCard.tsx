import { useState } from 'react';
import type { FleetGraphInsight } from '@ship/shared';
import { useDismissInsight, useSnoozeInsight, useApproveInsight } from '@/hooks/useFleetGraph';

interface FleetGraphInsightCardProps {
  insight: FleetGraphInsight;
}

const severityStyles: Record<string, { bg: string; border: string; badge: string; text: string }> = {
  critical: { bg: 'bg-red-950/50', border: 'border-red-800', badge: 'bg-red-600 text-white', text: 'text-red-300' },
  high: { bg: 'bg-orange-950/50', border: 'border-orange-800', badge: 'bg-orange-600 text-white', text: 'text-orange-300' },
  medium: { bg: 'bg-amber-950/50', border: 'border-amber-800', badge: 'bg-amber-600 text-white', text: 'text-amber-300' },
  low: { bg: 'bg-zinc-800/50', border: 'border-zinc-700', badge: 'bg-zinc-600 text-white', text: 'text-zinc-400' },
};

const signalTypeLabels: Record<string, string> = {
  ghost_blocker: 'Ghost Blocker',
  scope_creep: 'Scope Creep',
  velocity_decay: 'Velocity Decay',
  team_overload: 'Team Overload',
  accountability_cascade: 'Accountability Gap',
  confidence_drift: 'Confidence Drift',
  approval_bottleneck: 'Approval Bottleneck',
  blocker_chain: 'Blocker Chain',
  sprint_collapse: 'Sprint Collapse Risk',
};

export function FleetGraphInsightCard({ insight }: FleetGraphInsightCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editedContent, setEditedContent] = useState('');
  const dismissMutation = useDismissInsight();
  const snoozeMutation = useSnoozeInsight();
  const approveMutation = useApproveInsight();

  const style = severityStyles[insight.severity] || severityStyles.low;
  const content = insight.content as { description?: string; confidence?: number; data?: Record<string, any> };
  const rootCause = insight.root_cause;
  const hasAction = !!(insight.proposed_action || insight.drafted_artifact);
  const isApproved = insight.status === 'approved';

  const handleApprove = (contentOverride?: string) => {
    approveMutation.mutate({
      insightId: insight.id,
      edited_content: contentOverride,
    });
    setEditing(false);
  };

  const handleStartEdit = () => {
    const defaultContent = insight.drafted_artifact?.content
      || insight.proposed_action?.payload?.content
      || '';
    setEditedContent(defaultContent);
    setEditing(true);
  };

  return (
    <div className={`rounded-lg border ${style.border} ${style.bg} p-4`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${style.badge}`}>
              {insight.severity}
            </span>
            <span className="text-xs text-zinc-500">
              {signalTypeLabels[insight.category] || insight.category}
            </span>
            {isApproved && (
              <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-green-600 text-white">
                approved
              </span>
            )}
          </div>
          <h4 className="text-sm font-medium text-zinc-200 truncate">{insight.title}</h4>
        </div>

        {/* Actions */}
        {!isApproved && (
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={() => snoozeMutation.mutate({ insightId: insight.id, hours: 24 })}
              className="rounded p-1 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50"
              title="Snooze for 24 hours"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>
            <button
              onClick={() => dismissMutation.mutate(insight.id)}
              className="rounded p-1 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50"
              title="Dismiss"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* Description */}
      <p className={`mt-2 text-xs ${style.text} leading-relaxed`}>
        {content.description}
      </p>

      {/* Confidence */}
      {content.confidence != null && (
        <div className="mt-2 flex items-center gap-2">
          <div className="h-1 flex-1 rounded-full bg-zinc-700 overflow-hidden">
            <div
              className="h-full rounded-full bg-zinc-500"
              style={{ width: `${Math.round(content.confidence * 100)}%` }}
            />
          </div>
          <span className="text-xs text-zinc-500">{Math.round(content.confidence * 100)}% confidence</span>
        </div>
      )}

      {/* Expandable root cause */}
      {rootCause && (
        <div className="mt-3">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"
          >
            <svg
              className={`h-3 w-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            Root Cause Analysis
          </button>

          {expanded && (
            <div className="mt-2 rounded-md bg-zinc-900/50 p-3 text-xs text-zinc-400 leading-relaxed">
              <p>{rootCause.explanation}</p>
              {rootCause.temporal_context && (
                <p className="mt-2 text-zinc-500 italic">{rootCause.temporal_context}</p>
              )}
              {rootCause.contributing_factors.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {rootCause.contributing_factors.map((f, i) => (
                    <li key={i} className="flex gap-1">
                      <span className="text-zinc-600">-</span>
                      <span>{f.factor}: {f.evidence}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {/* Recovery options */}
      {insight.recovery_options && insight.recovery_options.length > 0 && expanded && (
        <div className="mt-3 space-y-2">
          <span className="text-xs font-medium text-zinc-400">Recovery Options</span>
          {insight.recovery_options.map((opt, i) => (
            <div key={opt.id || i} className="rounded-md bg-zinc-900/50 p-2 text-xs text-zinc-400">
              <p>{opt.description}</p>
              <p className="mt-1 text-zinc-500">
                Impact: {opt.projected_impact.timeline_change_days > 0 ? '+' : ''}{opt.projected_impact.timeline_change_days}d
                {' | '}Confidence: {Math.round(opt.confidence * 100)}%
                {opt.risks.length > 0 && ` | Risks: ${opt.risks.join(', ')}`}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Proposed action / Drafted artifact — HITL gate */}
      {hasAction && !isApproved && (
        <div className="mt-3 rounded-md border border-zinc-700 bg-zinc-900/50 p-3">
          {/* Show action description */}
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-zinc-400">
              {insight.drafted_artifact
                ? `Draft ${insight.drafted_artifact.type}`
                : `Proposed: ${insight.proposed_action?.description || insight.proposed_action?.type}`}
            </span>
          </div>

          {/* Content preview or edit mode */}
          {editing ? (
            <div className="space-y-2">
              <textarea
                value={editedContent}
                onChange={e => setEditedContent(e.target.value)}
                className="w-full rounded-md border border-zinc-600 bg-zinc-800 p-2 text-xs text-zinc-300 focus:border-blue-500 focus:outline-none"
                rows={4}
              />
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setEditing(false)}
                  className="rounded px-2 py-1 text-xs text-zinc-400 hover:text-zinc-300"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleApprove(editedContent)}
                  disabled={approveMutation.isPending}
                  className="rounded px-3 py-1 text-xs font-medium bg-green-600 text-white hover:bg-green-500 disabled:opacity-50"
                >
                  {approveMutation.isPending ? 'Applying...' : 'Approve & Apply'}
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="text-xs text-zinc-400 whitespace-pre-wrap">
                {insight.drafted_artifact?.content
                  || insight.proposed_action?.payload?.content
                  || JSON.stringify(insight.proposed_action?.payload, null, 2)}
              </p>
              <div className="flex gap-2 justify-end mt-2">
                <button
                  onClick={handleStartEdit}
                  className="rounded px-2 py-1 text-xs text-zinc-400 hover:text-zinc-300 border border-zinc-700 hover:border-zinc-600"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleApprove()}
                  disabled={approveMutation.isPending}
                  className="rounded px-3 py-1 text-xs font-medium bg-green-600 text-white hover:bg-green-500 disabled:opacity-50"
                >
                  {approveMutation.isPending ? 'Applying...' : 'Approve'}
                </button>
              </div>
            </>
          )}

          {/* Error display */}
          {approveMutation.isError && (
            <p className="mt-2 text-xs text-red-400">
              {approveMutation.error?.message || 'Failed to apply action'}
            </p>
          )}
        </div>
      )}

      {/* Approved confirmation */}
      {hasAction && isApproved && (
        <div className="mt-3 rounded-md border border-green-800 bg-green-950/30 p-3">
          <p className="text-xs text-green-400">
            Action applied: {insight.proposed_action?.description || insight.drafted_artifact?.type}
          </p>
        </div>
      )}
    </div>
  );
}
