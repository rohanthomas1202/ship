import { useState } from 'react';
import {
  useFleetGraphInsights,
  useHealthScores,
  useRunProactiveScan,
  isScanRunning,
} from '@/hooks/useFleetGraph';
import { HealthScoreCard } from '@/components/HealthScoreCard';
import { FleetGraphInsightCard } from '@/components/FleetGraphInsightCard';
import type { FleetGraphInsight } from '@ship/shared';

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const SIGNAL_TYPE_OPTIONS = [
  { value: '', label: 'All types' },
  { value: 'ghost_blocker', label: 'Ghost Blocker' },
  { value: 'blocker_chain', label: 'Blocker Chain' },
  { value: 'sprint_collapse', label: 'Sprint Collapse' },
  { value: 'scope_creep', label: 'Scope Creep' },
  { value: 'team_overload', label: 'Team Overload' },
  { value: 'approval_bottleneck', label: 'Approval Bottleneck' },
  { value: 'confidence_drift', label: 'Confidence Drift' },
  { value: 'velocity_decay', label: 'Velocity Decay' },
  { value: 'accountability_cascade', label: 'Accountability Gap' },
];

const SEVERITY_OPTIONS = [
  { value: '', label: 'All severities' },
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

export function HealthDashboardPage() {
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [severityFilter, setSeverityFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');

  const { data: scoresData, isLoading: scoresLoading } = useHealthScores();
  const { data: insightsData, isLoading: insightsLoading } = useFleetGraphInsights(
    selectedProject || undefined,
    severityFilter || undefined,
  );
  const scanMutation = useRunProactiveScan();

  const scores = scoresData?.scores || {};
  const allInsights: FleetGraphInsight[] = insightsData?.insights || [];

  // Apply client-side type filter (API doesn't support category filter)
  const filteredInsights = allInsights
    .filter(i => !typeFilter || i.category === typeFilter)
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 4) - (SEVERITY_ORDER[b.severity] ?? 4));

  const projectEntries = Object.entries(scores).sort(
    ([, a], [, b]) => (a.overall ?? 100) - (b.overall ?? 100),
  );

  const activeHighCritical = allInsights.filter(
    i => i.severity === 'high' || i.severity === 'critical',
  ).length;

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="w-56 shrink-0 border-r border-zinc-800 overflow-y-auto p-3 space-y-1">
        <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2 px-2">Projects</h2>
        <button
          onClick={() => setSelectedProject(null)}
          className={`w-full text-left rounded-md px-2 py-1.5 text-sm transition-colors ${
            !selectedProject ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-400 hover:text-zinc-300 hover:bg-zinc-800/50'
          }`}
        >
          All Projects
        </button>
        {projectEntries.map(([id, data]) => (
          <button
            key={id}
            onClick={() => setSelectedProject(id)}
            className={`w-full text-left rounded-md px-2 py-1.5 text-sm flex items-center justify-between transition-colors ${
              selectedProject === id ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-400 hover:text-zinc-300 hover:bg-zinc-800/50'
            }`}
          >
            <span className="truncate">{data.project_title || id.slice(0, 8)}</span>
            <ScoreBadge score={data.overall} />
          </button>
        ))}
        {projectEntries.length === 0 && !scoresLoading && (
          <p className="px-2 text-xs text-zinc-600">No health scores yet. Run a scan to generate them.</p>
        )}
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-900/95 backdrop-blur px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-zinc-100">Project Health</h1>
            <p className="text-xs text-zinc-500 mt-0.5">
              {activeHighCritical > 0
                ? `${activeHighCritical} high/critical finding${activeHighCritical !== 1 ? 's' : ''} require attention`
                : 'All projects healthy'}
            </p>
          </div>
          <button
            onClick={() => scanMutation.mutate()}
            disabled={scanMutation.isPending}
            className="flex items-center gap-2 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            {scanMutation.isSuccess || isScanRunning() ? 'Scan Running (results appear below)' : 'Run Scan'}
          </button>
        </div>

        <div className="p-6 space-y-8">
          {/* Health Scores Grid */}
          {projectEntries.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-zinc-300 mb-3">Health Scores</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {projectEntries.map(([id, data]) => (
                  <HealthScoreCard
                    key={id}
                    projectId={id}
                    projectTitle={data.project_title || id.slice(0, 8)}
                    overall={data.overall ?? 0}
                    subScores={{
                      velocity: data.sub_scores?.velocity?.score ?? 0,
                      blockers: data.sub_scores?.blockers?.score ?? 0,
                      workload: data.sub_scores?.workload?.score ?? 0,
                      issue_freshness: data.sub_scores?.issue_freshness?.score ?? 0,
                      approval_flow: data.sub_scores?.approval_flow?.score ?? 0,
                      accountability: data.sub_scores?.accountability?.score ?? 0,
                    }}
                    selected={selectedProject === id}
                    onClick={() => setSelectedProject(selectedProject === id ? null : id)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Active Insights */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-zinc-300">
                Active Insights
                {filteredInsights.length > 0 && (
                  <span className="ml-2 text-zinc-500 font-normal">({filteredInsights.length})</span>
                )}
              </h2>
              <div className="flex gap-2">
                <select
                  value={severityFilter}
                  onChange={e => setSeverityFilter(e.target.value)}
                  className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 focus:border-blue-500 focus:outline-none"
                >
                  {SEVERITY_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <select
                  value={typeFilter}
                  onChange={e => setTypeFilter(e.target.value)}
                  className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 focus:border-blue-500 focus:outline-none"
                >
                  {SIGNAL_TYPE_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {insightsLoading ? (
              <div className="text-sm text-zinc-500">Loading insights...</div>
            ) : filteredInsights.length === 0 ? (
              <div className="rounded-lg border border-zinc-800 bg-zinc-800/30 p-8 text-center">
                <svg className="mx-auto h-8 w-8 text-zinc-600 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p className="text-sm text-zinc-500">No active insights</p>
                <p className="text-xs text-zinc-600 mt-1">
                  {Object.keys(scores).length === 0
                    ? 'Run a proactive scan to analyze your projects'
                    : 'All projects look healthy'}
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {filteredInsights.map(insight => (
                  <FleetGraphInsightCard key={insight.id} insight={insight} />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const color = score >= 80 ? 'bg-green-500' : score >= 50 ? 'bg-yellow-500' : 'bg-red-500';
  return (
    <span className={`inline-flex items-center justify-center h-5 min-w-[20px] rounded-full px-1 text-[10px] font-bold text-white ${color}`}>
      {Math.round(score)}
    </span>
  );
}
