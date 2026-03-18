/**
 * FleetGraph — Project Intelligence Agent
 *
 * Entry point for the FleetGraph service. Re-exports the graph executor
 * and key utilities for use by routes and scheduled jobs.
 */

export { runProactive, runOnDemand } from './graph-executor.js';
export { isBedrockAvailable } from './bedrock.js';
export { createInitialState } from './graph-state.js';
export type { ExecutionTrace } from './graph-executor.js';
