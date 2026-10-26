/** API vocabulary of the project resource (v1). ARCHIVED exists only in the database; see project.mapper.ts. */
export const ProjectStatus = { ACTIVE: 'ACTIVE', INACTIVE: 'INACTIVE' } as const;
export type ProjectStatus = (typeof ProjectStatus)[keyof typeof ProjectStatus];

export const ProjectSortField = { name: 'name', status: 'status' } as const;
export type ProjectSortField = (typeof ProjectSortField)[keyof typeof ProjectSortField];

/** Response DTO. Deliberately excludes companyId and internal timestamps. */
export type ProjectResponse = {
  id: string;
  name: string;
  status: ProjectStatus;
};

export type ProjectPage = {
  items: ProjectResponse[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
};
