import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { PoolClient } from 'pg';

/** Caller-owned transaction. Handlers must never begin/commit an independent transaction. */
export type MutationTransaction = Pick<PoolClient, 'query'>;
export type PlanningAssignmentMutation = {
  companyId: string;
  actorAccountId: string;
  correlationId: string;
  cause: 'DUTY_PATCH' | 'DUTY_DELETE' | 'EMPLOYEE_MONTH_SAVE';
  changes: readonly {
    dutyId: string;
    removedAssignmentIds: readonly string[];
  }[];
};
export type PlanningMutationHandler = (
  transaction: MutationTransaction,
  mutation: PlanningAssignmentMutation,
) => Promise<void>;
export const PLANNING_MUTATION_HANDLER = Symbol('PLANNING_MUTATION_HANDLER');

/** Neutral composition boundary: no imports from either owning business module. */
@Injectable()
export class PlanningMutationDispatcher implements OnModuleInit {
  constructor(
    @Inject(PLANNING_MUTATION_HANDLER)
    private readonly handler: PlanningMutationHandler,
  ) {}

  onModuleInit(): void {
    if (typeof this.handler !== 'function')
      throw new Error('Required planning mutation handler is not registered');
  }

  async dispatch(
    transaction: MutationTransaction,
    mutation: PlanningAssignmentMutation,
  ): Promise<void> {
    this.onModuleInit();
    await this.handler(transaction, mutation);
  }
}
