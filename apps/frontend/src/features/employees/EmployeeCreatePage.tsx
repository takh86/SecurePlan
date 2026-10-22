import { Link, useNavigate } from 'react-router';
import { PageFrame } from '../../app/PageFrame';
import { EMPTY_FORM, serverFieldErrors, toCreateInput } from './employee-form';
import { EmployeeForm, type SubmitOutcome } from './EmployeeForm';
import type { EmployeesApi } from './employees-api';

export type EmployeeNotice = 'created';

export function EmployeeCreatePage({ basePath, employees }: { basePath: string; employees: EmployeesApi }) {
  const navigate = useNavigate();

  async function create(values: Parameters<typeof toCreateInput>[0]): Promise<SubmitOutcome> {
    try {
      const created = await employees.create(toCreateInput(values));
      navigate(`${basePath}/${created.id}`, { state: { notice: 'created' satisfies EmployeeNotice } });
      return undefined;
    } catch (error) {
      const fieldErrors = serverFieldErrors(error);
      return fieldErrors ? { fieldErrors } : { error: error instanceof Error ? error : new Error('Create failed') };
    }
  }

  return (
    <PageFrame
      title="Mitarbeiter:in anlegen"
      lead="Mit dem Anlegen entsteht ein persönliches Konto. Die Person aktiviert es selbst über einen Einladungslink und vergibt dabei ihr Passwort; hier wird kein Passwort gesetzt."
    >
      <div className="employees employees--narrow">
        <EmployeeForm
          mode="create"
          initialValues={EMPTY_FORM}
          submitLabel="Mitarbeiter:in anlegen"
          pendingLabel="Wird angelegt …"
          onSubmit={create}
          cancel={<Link className="employees-button" to={basePath}>Abbrechen</Link>}
        />
      </div>
    </PageFrame>
  );
}
