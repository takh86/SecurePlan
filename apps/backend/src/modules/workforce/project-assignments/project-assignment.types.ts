/**
 * Response DTO of the month-scoped project assignment (API v1): stable id plus
 * the three business dimensions and the concurrency token. Deliberately
 * excludes companyId and internal timestamps.
 */
export type ProjectAssignmentResponse = {
  id: string;
  employeeId: string;
  projectId: string;
  /** First day of the planning month, YYYY-MM-01. */
  monthStart: string;
  /**
   * #73: opaque positive safe integer that changes with every effective change
   * of this assignment; sent back as `Expected-Version` to remove it. Not an
   * authorization control and not a guaranteed physical timestamp.
   */
  version: number;
};

export type ProjectAssignmentPage = {
  items: ProjectAssignmentResponse[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
};
