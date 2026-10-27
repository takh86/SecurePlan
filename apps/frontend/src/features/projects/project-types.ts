import type { StatusTone } from '../../shared/ui/StatusBadge';

/** Project resource as returned by the SP-08 API (`/api/v1/projects`): name + status only. */
export type ProjectStatus = 'ACTIVE' | 'INACTIVE';

export type Project = {
  id: string;
  name: string;
  status: ProjectStatus;
};

export type ProjectPage = {
  items: Project[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
};

export type ProjectListQuery = {
  status?: ProjectStatus;
  page?: number;
  /** Not taken from the page URL; used by selection lists that load all pages (SP-09). */
  pageSize?: number;
};

/** PATCH body: only changed fields. */
export type UpdateProjectInput = Partial<{ name: string; status: ProjectStatus }>;

export const PROJECT_STATUS: Record<ProjectStatus, { label: string; tone: StatusTone }> = {
  ACTIVE: { label: 'Aktiv', tone: 'success' },
  INACTIVE: { label: 'Inaktiv', tone: 'neutral' },
};

/** Same rule as the API (Phase 8.4): trimmed, 2..100 characters. */
export function validateProjectName(raw: string): string | null {
  const name = raw.trim();
  if (name.length === 0) return 'Bitte geben Sie einen Projektnamen ein.';
  if (name.length < 2) return 'Der Projektname muss mindestens 2 Zeichen lang sein.';
  if (name.length > 100) return 'Der Projektname darf höchstens 100 Zeichen lang sein.';
  return null;
}
