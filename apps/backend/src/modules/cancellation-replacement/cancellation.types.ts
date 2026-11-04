import { IsUUID } from 'class-validator';
export class CreateCancellationDto {
  @IsUUID() assignmentId!: string;
}
export type CancellationResponse = {
  id: string;
  assignmentId: string;
  employee: {
    id: string;
    employeeCode: string;
    firstName: string;
    lastName: string;
  };
  duty: {
    id: string;
    dutyDate: string;
    shiftKind: 'DAY' | 'NIGHT';
    startsAt: string;
    endsAt: string;
  };
  status: 'OPEN' | 'WITHDRAWN' | 'REJECTED' | 'APPROVED' | 'OBSOLETE';
  createdAt: string;
  decidedAt: string | null;
  replacementNeed: {
    id: string;
    status: 'OPEN' | 'OPEN_UNFILLED' | 'RESOLVED' | 'CLOSED';
    resolvedAt: string | null;
  };
};
