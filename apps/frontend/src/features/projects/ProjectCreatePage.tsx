import { Link, useNavigate } from 'react-router';
import { PageFrame } from '../../app/PageFrame';
import { ProjectNameForm } from './ProjectNameForm';
import type { ProjectsApi } from './projects-api';

export type ProjectNotice = 'created';

export function ProjectCreatePage({ basePath, projects }: { basePath: string; projects: ProjectsApi }) {
  const navigate = useNavigate();

  async function create(name: string) {
    const created = await projects.create(name);
    navigate(`${basePath}/${created.id}`, { state: { notice: 'created' satisfies ProjectNotice } });
  }

  return (
    <PageFrame title="Projekt anlegen" lead="Neue Projekte starten aktiv. Weitere Stammdaten wie Adresse sind in dieser Ausbaustufe nicht vorgesehen.">
      <div className="employees employees--narrow">
        <ProjectNameForm
          initialName=""
          submitLabel="Projekt anlegen"
          pendingLabel="Wird angelegt …"
          onSubmit={create}
          cancel={<Link className="employees-button" to={basePath}>Abbrechen</Link>}
        />
      </div>
    </PageFrame>
  );
}
