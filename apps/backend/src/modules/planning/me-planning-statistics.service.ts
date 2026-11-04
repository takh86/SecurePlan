import { Injectable } from '@nestjs/common';
import type { TenantContext } from '../../auth/authorization/tenant-context.js';
import type { MyMonthlyPlansResponse } from './me-monthly-plan.types.js';
import { MeMonthlyPlansReadService } from './me-monthly-plans-read.service.js';

export type PlanningStatisticsResponse = {
  monthStart: string;
  plannedWorkdays: number;
  dayShiftCount: number;
  nightShiftCount: number;
};

/** Input has already passed the owner read's integrity and authorization checks. */
export function aggregatePlanningStatistics(
  response: MyMonthlyPlansResponse,
  monthStart: string,
): PlanningStatisticsResponse {
  const dates = new Set<string>();
  let dayShiftCount = 0;
  let nightShiftCount = 0;
  for (const plan of response.items) {
    for (const duty of plan.duties) {
      dates.add(duty.dutyDate);
      if (duty.shiftKind === 'DAY') dayShiftCount++;
      else nightShiftCount++;
    }
  }
  return {
    monthStart,
    plannedWorkdays: dates.size,
    dayShiftCount,
    nightShiftCount,
  };
}

@Injectable()
export class MePlanningStatisticsService {
  constructor(private readonly plans: MeMonthlyPlansReadService) {}

  async read(
    tenant: TenantContext,
    monthStart: string,
  ): Promise<PlanningStatisticsResponse> {
    const response = await this.plans.read(tenant, monthStart);
    return aggregatePlanningStatistics(response, monthStart);
  }
}
