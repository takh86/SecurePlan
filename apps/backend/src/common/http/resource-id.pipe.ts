import { Injectable, NotFoundException, type PipeTransform } from '@nestjs/common';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Path resource IDs: a value that cannot be an ID cannot exist, so it gets the
 * same 404 RESOURCE_NOT_FOUND as an unknown or foreign ID. It never reaches SQL
 * (where a uuid cast error would otherwise become a 500).
 */
@Injectable()
export class ResourceIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
    }
    return value.toLowerCase();
  }
}
