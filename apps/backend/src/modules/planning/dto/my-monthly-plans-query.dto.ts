import { IsDefined, IsString, Matches } from 'class-validator';

/** Structural only. Civil validity and first-day semantics follow whitelisting. */
export class MyMonthlyPlansQueryDto {
  @IsDefined()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  monthStart!: string;
}
