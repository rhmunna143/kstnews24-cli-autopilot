// ANSI color codes
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const GRAY = '\x1b[90m';

function timestamp(): string {
  const now = new Date();
  return now.toTimeString().split(' ')[0];
}

export interface RunSummary {
  published: number;
  skipped: number;
  failed: number;
}

export const logger = {
  info(message: string): void {
    console.log(`${GRAY}[${timestamp()}]${RESET} ${CYAN}ℹ${RESET} ${message}`);
  },

  step(stepName: string, detail?: string): void {
    const detailStr = detail ? ` ${DIM}${detail}${RESET}` : '';
    console.log(`${GRAY}[${timestamp()}]${RESET} ${BLUE}▶${RESET} ${BOLD}${stepName}${RESET}${detailStr}`);
  },

  success(message: string): void {
    console.log(`${GRAY}[${timestamp()}]${RESET} ${GREEN}✔${RESET} ${message}`);
  },

  warn(message: string): void {
    console.warn(`${GRAY}[${timestamp()}]${RESET} ${YELLOW}⚠ ${message}${RESET}`);
  },

  error(message: string, err?: unknown): void {
    console.error(`${GRAY}[${timestamp()}]${RESET} ${RED}✖ ${message}${RESET}`);
    if (err) {
      if (err instanceof Error && err.stack) {
        console.error(`${DIM}${err.stack}${RESET}`);
      } else {
        console.error(`${DIM}${String(err)}${RESET}`);
      }
    }
  },

  skip(id: number | string, reason: string): void {
    console.log(
      `${GRAY}[${timestamp()}]${RESET} [${BOLD}#${id}${RESET}] ${MAGENTA}⏭ Skipped${RESET} ${DIM}(${reason})${RESET}`
    );
  },

  published(id: number | string, url: string, draft = false): void {
    const action = draft ? `${YELLOW}Drafted${RESET}` : `${GREEN}Published${RESET}`;
    console.log(
      `${GRAY}[${timestamp()}]${RESET} [${BOLD}#${id}${RESET}] ${GREEN}✔${RESET} ${action} → ${CYAN}${url}${RESET}`
    );
  },

  failed(id: number | string, reason: string): void {
    console.error(
      `${GRAY}[${timestamp()}]${RESET} [${BOLD}#${id}${RESET}] ${RED}✖ Failed${RESET} ${DIM}(${reason})${RESET}`
    );
  },

  summary(counts: RunSummary): void {
    console.log('');
    console.log(`${BOLD}══════════════════════════════════════════════════${RESET}`);
    console.log(`${BOLD}               RUN SUMMARY                        ${RESET}`);
    console.log(`${BOLD}══════════════════════════════════════════════════${RESET}`);
    console.log(`  ${GREEN}✔ Published / Drafted :${RESET} ${counts.published}`);
    console.log(`  ${MAGENTA}⏭ Skipped             :${RESET} ${counts.skipped}`);
    console.log(`  ${RED}✖ Failed              :${RESET} ${counts.failed}`);
    console.log(`  ${BOLD}Total Processed       :${RESET} ${counts.published + counts.skipped + counts.failed}`);
    console.log(`${BOLD}══════════════════════════════════════════════════${RESET}`);
    console.log('');
  },
};
