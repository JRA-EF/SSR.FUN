// Parses a transaction's log messages the same way @anchor-lang/core's
// EventParser does (see node_modules/@anchor-lang/core/dist/cjs/program/
// event.js's EventParser.parseLogs -- this file mirrors that exact
// execution-context-stack algorithm), but additionally tracks WHICH
// instruction each decoded event came from -- something EventParser itself
// discards. ingest.ts previously called EventParser.parseLogs() directly
// and left instruction_index/inner_instruction_index/instruction_name null
// for every row (a real gap, not a design choice -- flagged in a live
// acquisition-readiness review of the ledger's first production data).
//
// Reimplemented (not wrapped) because EventParser's generator yields only
// `{name, data}` with no position information, and there is no supported
// way to intercept its internal stack from the outside. Pure and
// network-free -- takes an already-fetched log array, so directly
// unit-testable against synthetic Solana log arrays (tests/phase_ledger.ts).

export interface EventWithInstructionContext {
  event: { name: string; data: Record<string, unknown> };
  /** 0-based position among this transaction's TOP-LEVEL instructions that actually invoked a program (matches how many distinct depth-1 "Program X invoke [1]" spans have occurred so far, counting every program, not just ours -- so a leading ComputeBudget instruction correctly makes our program's events land on instruction_index 1, not 0). */
  instructionIndex: number;
  /** 0-based CPI nesting depth (relative to top-level) at which this event was emitted, or null if emitted directly in the top-level instruction body (the overwhelmingly common case for this protocol's `emit!()` calls, which use `sol_log_data` directly rather than a self-CPI). Never fabricated as 0 when nesting depth genuinely could not be determined. */
  innerInstructionIndex: number | null;
  /** The Anchor instruction name active when this event was emitted (from the "Program log: Instruction: <Name>" line Anchor's `#[program]` macro logs first thing in every handler) -- null if no such line preceded the event (can happen for logs truncated by the RPC node, or an event emitted before that log line for some reason). */
  instructionName: string | null;
}

interface CoderEvents {
  decode(log: string): { name: string; data: Record<string, unknown> } | null;
}

const PROGRAM_LOG = "Program log: ";
const PROGRAM_DATA = "Program data: ";
const INVOKE_RE = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/;
const SUCCESS_RE = /^Program ([1-9A-HJ-NP-Za-km-z]+) success$/;
const INSTRUCTION_NAME_RE = /^Program log: Instruction: (.+)$/;

/**
 * Walks one transaction's logs and yields every event *this* program
 * emitted, each tagged with the instruction context it was emitted under.
 * `coder` is `program.coder.events` (an Anchor BorshEventCoder) -- same
 * decode call EventParser itself uses internally.
 */
export function parseLogsWithInstructionContext(logs: string[], programId: string, coderEvents: CoderEvents): EventWithInstructionContext[] {
  const results: EventWithInstructionContext[] = [];
  // Only lines starting with "Program " are meaningful -- matches
  // EventParser's own LogScanner, which drops loader logs that can appear
  // interleaved on some transactions.
  const filtered = logs.filter((l) => l.startsWith("Program "));
  const stack: string[] = [];
  let instructionIndex = -1;
  let instructionName: string | null = null;

  const pushTopLevelIfNeeded = (pid: string) => {
    if (stack.length === 0) {
      instructionIndex++;
      instructionName = null;
    }
    stack.push(pid);
  };

  for (let i = 0; i < filtered.length; i++) {
    const log = filtered[i];
    const invokeMatch = INVOKE_RE.exec(log);
    if (invokeMatch) {
      pushTopLevelIfNeeded(invokeMatch[1]);
      continue;
    }

    const executingProgram = stack.length > 0 ? stack[stack.length - 1] : null;

    if (executingProgram === programId) {
      if (log.startsWith(PROGRAM_LOG) || log.startsWith(PROGRAM_DATA)) {
        const body = log.startsWith(PROGRAM_LOG) ? log.slice(PROGRAM_LOG.length) : log.slice(PROGRAM_DATA.length);
        const nameMatch = INSTRUCTION_NAME_RE.exec(log);
        if (nameMatch) {
          instructionName = nameMatch[1];
          continue;
        }
        if (log.startsWith(PROGRAM_DATA)) {
          let decoded: { name: string; data: Record<string, unknown> } | null = null;
          try {
            decoded = coderEvents.decode(body);
          } catch {
            decoded = null;
          }
          if (decoded) {
            results.push({
              event: decoded,
              instructionIndex,
              innerInstructionIndex: stack.length > 1 ? stack.length - 2 : null,
              instructionName,
            });
          }
        }
        continue;
      }
      if (SUCCESS_RE.test(log)) {
        stack.pop();
      }
      continue;
    }

    // A different program is currently on top of the stack.
    if (invokeMatch) continue; // handled above already, unreachable here
    if (SUCCESS_RE.test(log)) {
      stack.pop();
      continue;
    }
    // Any other system/foreign-program log line -- ignored, matches
    // EventParser's own handleSystemLog default (returns [null, false]).
  }

  return results;
}
