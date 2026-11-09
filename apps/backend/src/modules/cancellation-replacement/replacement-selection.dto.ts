import { IsUUID } from 'class-validator';

/** SP-20: the administrator selects exactly one OPEN offer. `null` is not accepted (approval without a replacement is SP-21). */
export class SelectReplacementDto {
  @IsUUID()
  offerId!: string;
}

export type SelectionResponse = {
  needId: string;
  cancellationRequestId: string;
  status: { cancellation: 'APPROVED'; need: 'RESOLVED' };
  decidedAt: string;
  needVersion: number;
  selectedOffer: {
    id: string;
    status: 'SELECTED';
    employee: { id: string; employeeNumber: string; firstName: string; lastName: string };
  };
  otherOffers: { id: string; status: 'NOT_SELECTED' }[];
  originalAssignment: { id: string; state: 'REMOVED'; removedAt: string };
  replacementAssignment: { id: string; employeeId: string; source: 'REPLACEMENT'; state: 'ACTIVE' };
  duty: { id: string; concurrencyVersion: number };
};
