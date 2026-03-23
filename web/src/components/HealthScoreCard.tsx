interface HealthScoreCardProps {
  projectId: string;
  projectTitle: string;
  overall: number;
  subScores: {
    velocity: number;
    blockers: number;
    workload: number;
    issue_freshness: number;
    approval_flow: number;
    accountability: number;
  };
  selected?: boolean;
  onClick?: () => void;
}

function scoreColor(score: number): string {
  if (score >= 80) return 'text-green-400';
  if (score >= 50) return 'text-yellow-400';
  return 'text-red-400';
}

function scoreBg(score: number): string {
  if (score >= 80) return 'bg-green-400';
  if (score >= 50) return 'bg-yellow-400';
  return 'bg-red-400';
}

const SUB_SCORE_LABELS: Record<string, string> = {
  velocity: 'Velocity',
  blockers: 'Blockers',
  workload: 'Workload',
  issue_freshness: 'Freshness',
  approval_flow: 'Approvals',
  accountability: 'Accountability',
};

export function HealthScoreCard({ projectId, projectTitle, overall, subScores, selected, onClick }: HealthScoreCardProps) {
  const entries = Object.entries(subScores) as [string, number][];

  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-lg border p-4 transition-colors ${
        selected
          ? 'border-blue-500 bg-blue-500/10'
          : 'border-zinc-700 bg-zinc-800/50 hover:border-zinc-600'
      }`}
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-zinc-200 truncate">{projectTitle}</h3>
        <span className={`text-2xl font-bold ${scoreColor(overall)}`}>{Math.round(overall)}</span>
      </div>
      <div className="space-y-1.5">
        {entries.map(([key, value]) => (
          <div key={key} className="flex items-center gap-2">
            <span className="text-xs text-zinc-500 w-20 shrink-0">{SUB_SCORE_LABELS[key] || key}</span>
            <div className="flex-1 h-1.5 rounded-full bg-zinc-700">
              <div
                className={`h-full rounded-full ${scoreBg(value)}`}
                style={{ width: `${Math.max(value, 2)}%` }}
              />
            </div>
            <span className="text-xs text-zinc-500 w-6 text-right">{Math.round(value)}</span>
          </div>
        ))}
      </div>
    </button>
  );
}
