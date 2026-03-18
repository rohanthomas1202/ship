import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '@/lib/api';
import type {
  FleetGraphChatResponse,
  FleetGraphInsight,
  Finding,
} from '@ship/shared';

export function useFleetGraphInsights(entityId?: string, severity?: string) {
  const params = new URLSearchParams();
  if (entityId) params.set('entity_id', entityId);
  if (severity) params.set('severity', severity);
  const query = params.toString();

  return useQuery<{ insights: FleetGraphInsight[] }>({
    queryKey: ['fleetgraph-insights', entityId, severity],
    queryFn: async () => {
      const response = await apiGet(`/api/fleetgraph/insights${query ? `?${query}` : ''}`);
      if (!response.ok) throw new Error('Failed to fetch insights');
      return response.json();
    },
    refetchInterval: 5 * 60 * 1000, // Refresh every 5 minutes
  });
}

export function useFleetGraphChat(entityType: string, entityId: string) {
  const queryClient = useQueryClient();

  return useMutation<
    FleetGraphChatResponse,
    Error,
    { message: string; chat_history?: Array<{ role: 'user' | 'assistant'; content: string }> }
  >({
    mutationFn: async ({ message, chat_history }) => {
      const response = await apiPost('/api/fleetgraph/chat', {
        entity_type: entityType,
        entity_id: entityId,
        message,
        chat_history,
      });
      if (!response.ok) throw new Error('FleetGraph chat failed');
      return response.json();
    },
    onSuccess: () => {
      // Refresh insights after a chat (agent may have discovered new findings)
      queryClient.invalidateQueries({ queryKey: ['fleetgraph-insights', entityId] });
    },
  });
}

export function useDismissInsight() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (insightId: string) => {
      const response = await apiPost(`/api/fleetgraph/insights/${insightId}/dismiss`);
      if (!response.ok) throw new Error('Failed to dismiss insight');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fleetgraph-insights'] });
    },
  });
}

export function useSnoozeInsight() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ insightId, hours }: { insightId: string; hours?: number }) => {
      const response = await apiPost(`/api/fleetgraph/insights/${insightId}/snooze`, { hours: hours || 24 });
      if (!response.ok) throw new Error('Failed to snooze insight');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fleetgraph-insights'] });
    },
  });
}
