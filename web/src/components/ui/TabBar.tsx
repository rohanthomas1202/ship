import { cn } from '@/lib/cn';

export interface Tab {
  id: string;
  label: string;
}

interface TabBarProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  rightContent?: React.ReactNode;
}

export function TabBar({ tabs, activeTab, onTabChange, rightContent }: TabBarProps) {
  return (
    <div className="flex items-center justify-between border-b border-border px-6">
      <div className="flex" role="tablist" aria-label="Content tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={activeTab === tab.id}
            aria-controls={`tabpanel-${tab.id}`}
            onClick={() => onTabChange(tab.id)}
            className={cn(
              'relative px-4 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-sm',
              activeTab === tab.id
                ? 'text-foreground'
                : 'text-muted hover:text-foreground'
            )}
          >
            {tab.label}
            {activeTab === tab.id && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent" aria-hidden="true" />
            )}
          </button>
        ))}
      </div>
      {rightContent && <div className="flex items-center gap-2">{rightContent}</div>}
    </div>
  );
}
