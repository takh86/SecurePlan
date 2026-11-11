import {
  Equals,
  IsIn,
  Validate,
  ValidateIf,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';

/** A single runtime DTO is required: a TypeScript union emits Object metadata and bypasses validation. */
@ValidatorConstraint({ name: 'decisionDutyVersion', async: false })
class DecisionDutyVersion implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const dto = args.object as CancellationDecisionDto;
    return dto.decision === 'APPROVE'
      ? typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      : value === undefined;
  }
}

export class CancellationDecisionDto {
  @IsIn(['APPROVE', 'REJECT'])
  decision!: 'APPROVE' | 'REJECT';

  // APPROVE requires a positive safe integer; REJECT forbids the field, including null.
  // No @Type/transform: numeric strings must fail closed.
  @Validate(DecisionDutyVersion)
  expectedDutyVersion?: number;

  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @Equals(null)
  replacementOfferId?: null;
}
