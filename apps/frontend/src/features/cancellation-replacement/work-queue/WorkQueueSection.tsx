import { useMemo, useState } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router';
import type { AppRoute } from '../../../app/routes';
import { useFocusHeadingOnSubpageChange } from '../../../app/use-focus-heading-on-subpage-change';
import type { IdentityContext } from '../../auth/auth-api';
import type { SessionApi } from '../../auth/session-api';
import { createProjectsApi } from '../../projects/projects-api';
import { createWorkQueueApi, type WorkQueueApi } from './work-queue-api';
import { WorkQueueCasePage } from './WorkQueueCasePage';
import { WorkQueuePage } from './WorkQueuePage';

type Props = {
  route: AppRoute;
  api: SessionApi;
  identity: IdentityContext;
};

/**
 * SP-19 admin area `/arbeitsuebersicht`: queue (`/`) and case view (`/:needId`).
 * Read-only. A new session or account gets a new boundary, so no state and no
 * in-flight response of the previous identity can appear on screen.
 */
export function WorkQueueSection(props: Props) {
  const [boundary, setBoundary] = useState({ api: props.api, identity: props.identity, generation: 0 });
  if (boundary.api !== props.api || boundary.identity !== props.identity)
    setBoundary({ api: props.api, identity: props.identity, generation: boundary.generation + 1 });
  useFocusHeadingOnSubpageChange();
  return <BoundWorkQueue key={boundary.generation} {...props} />;
}

function BoundWorkQueue({ route, api }: Props) {
  const queue = useMemo(() => createWorkQueueApi(api), [api]);
  const projects = useMemo(() => createProjectsApi(api), [api]);
  return (
    <Routes>
      <Route index element={<WorkQueuePage route={route} queue={queue} projects={projects} />} />
      <Route path=":needId" element={<CaseRoute route={route} queue={queue} />} />
      <Route path="*" element={<Navigate to={route.path} replace />} />
    </Routes>
  );
}

function CaseRoute({ route, queue }: { route: AppRoute; queue: WorkQueueApi }) {
  const { needId = '' } = useParams();
  // A different case is a different page: nothing carries over from the previous one.
  return <WorkQueueCasePage key={needId} route={route} queue={queue} needId={needId} />;
}
