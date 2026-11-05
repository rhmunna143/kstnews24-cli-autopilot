import input from 'input';
import { loadConfig } from './config.js';
import { logger, RunSummary } from './logger.js';
import { loadState, saveState, resetState, AppState } from './state.js';
import { TelegramService, PostUnit } from './telegram.js';
import { GeminiService } from './gemini.js';
import { WordPressClient } from './wordpress.js';
import { checkFontSanity } from './media.js';
import { processUnit, PipelineContext } from './pipeline.js';

interface CliArgs {
  once: boolean;
  watch: boolean;
  draft: boolean;
  reset: boolean;
  dryRun: boolean;
  noState: boolean;
  limit?: number;
  yes?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    once: false,
    watch: false,
    draft: false,
    reset: false,
    dryRun: false,
    noState: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--once') args.once = true;
    else if (arg === '--watch') args.watch = true;
    else if (arg === '--draft') args.draft = true;
    else if (arg === '--reset') args.reset = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--no-state') args.noState = true;
    else if (arg === '-y' || arg === '--yes') args.yes = true;
    else if (arg === '--limit') {
      const val = argv[++i];
      const parsed = parseInt(val, 10);
      if (!isNaN(parsed) && parsed > 0) {
        args.limit = parsed;
      }
    }
  }

  // Default mode if none specified: --once
  if (!args.once && !args.watch && !args.reset) {
    args.once = true;
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  // Catch unhandled errors
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Promise Rejection:', reason);
  });
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception:', err);
    process.exit(1);
  });

  // 1. Reset command
  if (args.reset) {
    logger.warn('State reset requested.');
    let confirmed = args.yes;
    if (!confirmed) {
      confirmed = await input.confirm(
        'Are you sure you want to reset state.json? All processed IDs will be cleared. (y/N): ',
        { default: false }
      );
    }

    if (confirmed) {
      const channel = process.env.TG_CHANNEL?.trim() || 'basherkella';
      await resetState(channel);
      logger.success('state.json has been reset.');
    } else {
      logger.info('Reset cancelled.');
    }
    process.exit(0);
  }

  // 2. Load and validate configuration
  logger.step('Loading configuration...');
  const config = loadConfig({ draft: args.draft });
  if (args.draft) {
    logger.info('Draft mode enabled: WordPress post status forced to "draft".');
  }
  if (args.dryRun) {
    logger.info('Dry-run mode enabled: WordPress write endpoints will NOT be called.');
  }

  // 3. Verify WordPress credentials
  logger.step(`Verifying WordPress connection at ${config.wpUrl}...`);
  const wordpress = new WordPressClient(config);
  try {
    if (!args.dryRun) {
      await wordpress.verifyAuth();
      logger.success('WordPress authentication verified successfully.');
    } else {
      logger.info('[DRY-RUN] Skipping live WordPress verifyAuth.');
    }
  } catch (err: any) {
    logger.error(`WordPress connection failed: ${err.message}`);
    process.exit(1);
  }

  // 4. Font sanity check
  logger.step('Checking Bengali font rendering...');
  await checkFontSanity();

  // 5. Connect to Telegram
  logger.step('Connecting to Telegram MTProto...');
  const telegram = new TelegramService(config);
  try {
    await telegram.connect();
  } catch (err: any) {
    logger.error(`Telegram connection failed: ${err.message}`);
    process.exit(1);
  }

  // 6. Initialize Gemini
  const gemini = new GeminiService(config.geminiApiKey, config.geminiModel);

  // 7. Load local state
  const state: AppState = await loadState(config.tgChannel);
  logger.info(
    `State loaded. Channel: @${state.channel}, Last Processed Message ID: #${state.lastProcessedId}`
  );

  // Abort controller for graceful shutdown (Ctrl+C)
  const abortController = new AbortController();
  let isShuttingDown = false;

  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log('');
    logger.warn('Graceful shutdown initiated (Ctrl+C / SIGINT)...');
    abortController.abort();

    try {
      await saveState(state, 'state.json', args.noState || args.dryRun);
      await telegram.disconnect();
      logger.success('State saved and Telegram disconnected cleanly.');
    } catch (err: any) {
      logger.error('Error during shutdown:', err);
    }
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  const context: PipelineContext = {
    config,
    state,
    telegram,
    gemini,
    wordpress,
    draft: args.draft,
    dryRun: args.dryRun,
    noState: args.noState,
    abortSignal: abortController.signal,
  };

  const counts: RunSummary = {
    published: 0,
    skipped: 0,
    failed: 0,
  };

  // 8. Catch-up phase (fetch unread posts)
  logger.step('Checking for unread channel messages...');
  const units: PostUnit[] = await telegram.fetchUnread(
    state.lastProcessedId,
    args.limit
  );

  if (units.length === 0) {
    logger.info('No new messages to process.');
  } else {
    logger.info(`Found ${units.length} post unit(s) to process. Starting sequential pipeline...`);

    for (const unit of units) {
      if (abortController.signal.aborted) break;

      const res = await processUnit(unit, context);
      if (res.outcome === 'published') counts.published++;
      else if (res.outcome === 'skipped') counts.skipped++;
      else if (res.outcome === 'failed') counts.failed++;
    }
  }

  // Record history
  state.history.push({
    runAt: new Date().toISOString(),
    mode: args.watch ? 'watch' : args.draft ? 'draft' : 'sync',
    published: counts.published,
    skipped: counts.skipped,
    failed: counts.failed,
  });
  await saveState(state, 'state.json', args.noState || args.dryRun);

  // 9. Run mode dispatch
  if (args.watch) {
    logger.summary(counts);
    logger.info('Starting live watch mode. New posts will be processed automatically.');

    telegram.listen(async (unit: PostUnit) => {
      if (abortController.signal.aborted) return;
      logger.info(`[LIVE] Received new post unit #${unit.id}`);

      const res = await processUnit(unit, context);
      if (res.outcome === 'published') counts.published++;
      else if (res.outcome === 'skipped') counts.skipped++;
      else if (res.outcome === 'failed') counts.failed++;
    });

    // Keep process alive indefinitely until Ctrl+C
    await new Promise(() => {});
  } else {
    // One-shot mode
    logger.summary(counts);
    await telegram.disconnect();

    if (counts.failed > 0) {
      process.exit(2);
    }
    process.exit(0);
  }
}

main().catch((err) => {
  logger.error('Fatal CLI execution error:', err);
  process.exit(1);
});
