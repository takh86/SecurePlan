/**
 * Response DTO of the month-scoped project assignment (API v1): stable id plus
 * the three business dimensions. Deliberately excludes companyId and internal
 * timestamps.
 */
export type ProjectAssignmentResponse = {
  id: string;
  employeeId: string;
  projectId: string;
  /** First day of the planning month, YYYY-MM-01. */
  monthStart: string;
};

export type ProjectAssignmentPage = {
  items: ProjectAssignmentResponse[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
};
