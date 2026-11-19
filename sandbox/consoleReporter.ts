import type { Reporter } from 'vitest/reporters';

export const consoleFramePrefix = '__INTERVIEW_RUNNER_CONSOLE__';
export default class ConsoleReporter implements Reporter {
  private context?: Parameters<NonNullable<Reporter['onInit']>>[0];
  onInit(context: Parameters<NonNullable<Reporter['onInit']>>[0]): void { this.context = context; }
  onUserConsoleLog(log: Parameters<NonNullable<Reporter['onUserConsoleLog']>>[0]): void {
    const content = log.content.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
    const task = log.taskId ? this.context?.state.idMap.get(log.taskId) : undefined;
    let concurrent = false;
    for (let current = task; current; current = current.suite) if (current.concurrent) concurrent = true;
    const testName = task?.type === 'test' && !concurrent ? task.fullName.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').slice(0, 2000) : undefined;
    for (let offset = 0; offset < content.length; offset += 2048) process.stdout.write(`${consoleFramePrefix}${JSON.stringify({ stream: log.type === 'stderr' ? 'stderr' : 'stdout', text: content.slice(offset, offset + 2048), ...(testName ? { testName } : {}) })}\n`);
  }
}
