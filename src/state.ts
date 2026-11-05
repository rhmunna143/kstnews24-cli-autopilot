import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from './logger.js';

export interface ProcessedEntry {
  messageIds: number[];
  wpPostId?: number;
  url?: string;
  status: 'publish' | 'draft' | 'pending' | 'skipped' | 'failed';
  reason?: string;
  processedAt?: string;
}

export interface RunHistoryEntry {
  runAt: string;
  mode: string;
  published: number;
  skipped: number;
  failed: number;
}

export interface AppState {
  channel: string;
  lastProcessedId: number;
  history: RunHistoryEntry[];
  processed: ProcessedEntry[];
  failures?: Record<string, number>; // messageId -> failure count
}

const DEFAULT_STATE_FILE = 'state.json';

export function getDefaultState(channel = 'basherkella'): AppState {
  return {
    channel,
    lastProcessedId: 0,
    history: [],
    processed: [],
    failures: {},
  };
}

export async function loadState(
  channel: string,
  statePath = DEFAULT_STATE_FILE
): Promise<AppState> {
  const fullPath = path.resolve(statePath);
  try {
    const raw = await fs.readFile(fullPath, 'utf8');
    const parsed = JSON.parse(raw) as AppState;

    if (!parsed || typeof parsed !== 'object') {
      logger.warn(`Corrupt state file found at ${statePath}. Initializing fresh state.`);
      return getDefaultState(channel);
    }

    // Check if channel changed
    if (parsed.channel && parsed.channel !== channel) {
      logger.warn(
        `Channel in state.json ("${parsed.channel}") differs from configured TG_CHANNEL ("${channel}").`
      );
      logger.warn(`If you switched channels, please run "npm run reset" first to avoid ID collisions.`);
    }

    return {
      channel: parsed.channel || channel,
      lastProcessedId: typeof parsed.lastProcessedId === 'number' ? parsed.lastProcessedId : 0,
      history: Array.isArray(parsed.history) ? parsed.history : [],
      processed: Array.isArray(parsed.processed) ? parsed.processed : [],
      failures: parsed.failures && typeof parsed.failures === 'object' ? parsed.failures : {},
    };
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      // First run, file doesn't exist yet
      return getDefaultState(channel);
    }
    logger.warn(`Error reading ${statePath}: ${err.message}. Initializing default state.`);
    return getDefaultState(channel);
  }
}

export async function saveState(
  state: AppState,
  statePath = DEFAULT_STATE_FILE,
  dryRunOrNoState = false
): Promise<void> {
  if (dryRunOrNoState) {
    return;
  }

  // Cap history to last 50 and processed to last 200
  state.history = state.history.slice(-50);
  state.processed = state.processed.slice(-200);

  const fullPath = path.resolve(statePath);
  const tmpPath = `${fullPath}.tmp`;
  const data = JSON.stringify(state, null, 2);

  // Atomic write: write to tmp, then rename
  await fs.writeFile(tmpPath, data, 'utf8');
  await fs.rename(tmpPath, fullPath);
}

export function isAlreadyProcessed(state: AppState, messageIds: number[]): ProcessedEntry | undefined {
  return state.processed.find(
    (entry) =>
      ['publish', 'draft', 'pending'].includes(entry.status)
        ? entry.messageIds.some((id) => messageIds.includes(id)) && entry.wpPostId
        : false
  );
}

export function recordFailure(state: AppState, messageId: number): number {
  if (!state.failures) {
    state.failures = {};
  }
  const current = (state.failures[String(messageId)] || 0) + 1;
  state.failures[String(messageId)] = current;
  return current;
}

export function clearFailure(state: AppState, messageId: number): void {
  if (state.failures && state.failures[String(messageId)]) {
    delete state.failures[String(messageId)];
  }
}

export async function markProcessed(
  state: AppState,
  entry: ProcessedEntry,
  maxUnitId: number,
  statePath = DEFAULT_STATE_FILE,
  noState = false
): Promise<void> {
  entry.processedAt = new Date().toISOString();
  state.processed.push(entry);

  if (
    entry.status === 'publish' ||
    entry.status === 'draft' ||
    entry.status === 'pending' ||
    entry.status === 'skipped'
  ) {
    // Clear any previous failure count for these IDs
    for (const id of entry.messageIds) {
      clearFailure(state, id);
    }
    // Advance lastProcessedId if this unit ID is higher
    if (maxUnitId > state.lastProcessedId) {
      state.lastProcessedId = maxUnitId;
    }
  } else if (entry.status === 'failed') {
    const failCount = recordFailure(state, maxUnitId);
    if (failCount >= 3) {
      logger.warn(
        `Post unit #${maxUnitId} failed 3 times. Skipping and advancing lastProcessedId past it.`
      );
      if (maxUnitId > state.lastProcessedId) {
        state.lastProcessedId = maxUnitId;
      }
    }
  }

  await saveState(state, statePath, noState);
}

export async function resetState(
  channel: string,
  statePath = DEFAULT_STATE_FILE
): Promise<void> {
  const fresh = getDefaultState(channel);
  await saveState(fresh, statePath, false);
}
