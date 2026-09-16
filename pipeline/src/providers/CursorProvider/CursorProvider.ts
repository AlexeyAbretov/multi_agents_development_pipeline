import { Agent, CursorAgentError } from '@cursor/sdk';

import type { Config } from '@config';
import type { Role } from '@types';

import type {
  CursorIssue,
  CursorPull,
  CursorRunResult,
  CursorRunStarted,
  CursorTokenUsage,
} from './CursorProvider.types';
import {
  buildMessage,
  formatCursorModel,
  loadPrompt,
  readCursorUsage,
} from './CursorProvider.utils';

export class CursorClient {
  constructor(private readonly config: Config) {}

  async runCloudAgent(
    role: Role,
    issue: CursorIssue,
    onStarted: (ids: CursorRunStarted) => Promise<void>,
    pull?: CursorPull,
  ): Promise<CursorRunResult> {
    let agentId: string | null = null;
    let runId: string | null = null;

    try {
      await using agent = await Agent.create({
        apiKey: this.config.CURSOR_API_KEY,
        model: { id: this.config.CURSOR_MODEL },
        cloud: {
          repos: [
            {
              url: this.config.CURSOR_REPO_URL,
              startingRef: pull?.headRef || this.config.CURSOR_STARTING_REF,
            },
          ],
          skipReviewerRequest: true,
          autoCreatePR: role === 'developer',
          metadata: {
            issue: String(issue.number),
            role,
          },
        },
      });

      agentId = agent.agentId;
      const run = await agent.send(
        buildMessage(
          loadPrompt(this.config.PROMPTS_DIR, role),
          issue,
          pull,
          role,
        ),
      );

      runId = run.id;
      await onStarted({ agentId, runId });

      const result = await run.wait();
      const model = formatCursorModel(
        result.model ?? agent.model,
        this.config.CURSOR_MODEL,
      );
      const usage = await readCursorUsage({
        fetchBilled: () => agent.getUsage({ runId: run.id }),
        live: result.usage,
      });

      if (result.status === 'error') {
        return {
          agentId,
          runId,
          status: 'error',
          error: result.error?.message ?? 'run.status=error',
          text: result.result ?? null,
          model,
          usage,
        };
      }

      if (result.status === 'cancelled') {
        return {
          agentId,
          runId,
          status: 'error',
          error: 'run cancelled',
          text: result.result ?? null,
          model,
          usage,
        };
      }

      return {
        agentId,
        runId,
        status: 'finished',
        error: null,
        text: result.result ?? null,
        model,
        usage,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable =
        err instanceof CursorAgentError
          ? ` retryable=${String(err.isRetryable)}`
          : '';
      const status = runId ? 'error' : 'startup_error';
      const usage = await this.usageAfterThrow(agentId, runId);

      return {
        agentId,
        runId,
        status,
        error: `${message}${retryable}`,
        text: null,
        model: formatCursorModel(undefined, this.config.CURSOR_MODEL),
        usage,
      };
    }
  }

  private async usageAfterThrow(
    agentId: string | null,
    runId: string | null,
  ): Promise<CursorTokenUsage | null> {
    if (!agentId || !runId) {
      return null;
    }

    return readCursorUsage({
      fetchBilled: () =>
        Agent.getUsage(agentId, {
          apiKey: this.config.CURSOR_API_KEY,
          runId,
        }),
    });
  }
}
