# SecurePlan_Phase_7.2_PostgreSQL_Physical_Database_Design_v1.0

> Designquelle: SecurePlan_Phase_7.2_PostgreSQL_Physical_Database_Design_v1.0.docx. Markdown-Übertragung vom 07.10.2026; Quellstatus ist keine Implementierungsfreigabe. Bei Konflikten gelten CRs, 8.11 und der G0-Handoff.

SecurePlan – Phase 7.2

PostgreSQL Physical Database Design · Version 1.0

| Status<br>FINAL / APPROVED – PASS FOR PHASE 7.3 (Database Operations & Final Gate) |
| --- |


| Feld | Wert |
| --- | --- |
| Dokument | SecurePlan – Phase 7.2 PostgreSQL Physical Database Design |
| Version | v1.0 |
| Stand | 30.09.2026 |
| Status | FINAL / APPROVED – PASS FOR PHASE 7.3 |
| Datenbank | PostgreSQL · Shared DB / Shared Schema |
| Naming | Plural snake_case für Tabellen; snake_case für Spalten, Constraints und Indizes. |
| Primary Keys | UUID v7 als technischer Schlüssel; Generation in der Anwendung, um keine spezielle PostgreSQL-Extension vorauszusetzen. |
| Tenant-Modell | Company = Tenant; tenantbezogene Tabellen sind company-scoped und verwenden tenant-aware Composite Foreign Keys. |
| Statuswerte | TEXT + CHECK statt PostgreSQL ENUM, damit Statusänderungen migrationsfreundlich bleiben. |
| Zeitwerte | TIMESTAMPTZ für Ereignis-/Systemzeit; DATE für fachliche Kalendertage/Monate; TIME für lokale Schichtzeiten. |
| Basis | Phase 7.1 FINAL + gültige Phase-2/3/4/5/6-Baselines + CR-01/02/03. |
| Nicht-Ziel | Noch keine ausführbaren Migrationen/Seeds; diese folgen in Phase 7.3. |

## 1. Ziel und technische Designentscheidungen

Phase 7.2 konkretisiert das in Phase 7.1 freigegebene logische Modell als PostgreSQL-Schema: Tabellen, Spalten, Datentypen, Keys, Foreign Keys, Check-/Unique-Constraints, ON-DELETE-Strategie, Tenant-Isolation, Concurrency und query-getriebene Indizes.

| Thema | Entscheidung |
| --- | --- |
| Schema | Ein gemeinsames PostgreSQL-Schema für alle Tenants; kein Schema-per-Tenant. |
| PK | id UUID PRIMARY KEY, UUID v7 aus dem NestJS/TypeScript-Application-Layer. |
| Strings | TEXT statt künstlicher VARCHAR-Limits, sofern kein fachliches Längenlimit existiert. |
| Status | TEXT + CHECK (... IN (...)); UI-Texte werden davon getrennt lokalisiert. |
| Timestamps | TIMESTAMPTZ NOT NULL DEFAULT now() für technische Zeitpunkte. |
| Tenant-FKs | Alle tenantbezogenen Business-Tabellen tragen company_id direkt. Beziehungen nutzen möglichst (company_id, foreign_id). |
| Delete | RESTRICT/NO ACTION als Default. Master-/Workflow-Historie wird nicht per Cascade gelöscht. |
| Soft lifecycle | Status/Deaktivierung/Archivierung statt generischem deleted_at auf jeder Tabelle. |
| RLS | Nicht Teil dieser Baseline. Serverseitiger Tenant Context + Composite Tenant-FKs sind verpflichtend; RLS kann Phase 9 als zusätzliche Defense-in-Depth prüfen. |

| Warum company_id bewusst mehrfach gespeichert wird<br>Das ist kontrollierte Denormalisierung für Tenant-Sicherheit: Die Datenbank kann dadurch Cross-Company-Referenzen mit Composite Foreign Keys blockieren, statt sich nur auf korrekte WHERE-Filter im Backend zu verlassen. |
| --- |


## 2. Naming-, Key- und Constraint-Konventionen

| Objekt | Konvention | Beispiel |
| --- | --- | --- |
| Tabellen | plural snake_case | project_assignments |
| Spalten | snake_case | planning_month |
| Primary Key | pk_<table> | pk_employees |
| Foreign Key | fk_<table>__<target> | fk_plan_assignments__employees |
| Unique Constraint | uq_<table>__<columns> | uq_project_assignments__employee_month |
| Check Constraint | ck_<table>__<rule> | ck_monthly_plans__month_start |
| Index | idx_<table>__<query> | idx_cancellation_requests__work_queue |

Business Keys bleiben ausdrücklich neben dem UUID-PK bestehen. Beispiel: employee_number ist innerhalb einer Company eindeutig, aber nicht der Primary Key. Damit können fachliche Kennungen korrigiert werden, ohne die technische Identität und alle Referenzen umzubauen.

## 3. Tenant Isolation – physische Strategie

Jede tenantbezogene Business-Tabelle führt company_id NOT NULL. Parent-Tabellen erhalten zusätzlich zu ihrem UUID-PK einen UNIQUE(company_id, id), damit Child-Tabellen Composite Foreign Keys auf (company_id, parent_id) setzen können.

-- Muster für tenant-sichere Referenz
unique (company_id, id)

foreign key (company_id, employee_id)
  references employees(company_id, id)
  on delete restrict

Cross-Company-Verknüpfungen scheitern bereits auf DB-Ebene, auch wenn zwei UUIDs jeweils für sich gültig sind.

Business Keys wie employee_number und project internal_code werden company-scoped eindeutig, nicht global.

company_id wird aus der serverseitig authentifizierten Identity/Tenant Context abgeleitet; Clientwerte sind nicht vertrauenswürdig.

Platform-Accounts sind die einzige bewusst nicht tenantgebundene Account-Variante.

## 4. Tabellenkatalog

### 4.1 companies

Tenant-Stammsatz. Kein gemeinsames Firmen-Login; die Company ist der Workspace/Tenant.

| Spalte | PostgreSQL-Typ | Null? | Default | Bedeutung |
| --- | --- | --- | --- | --- |
| id | uuid | NO | - | UUID v7 Primary Key; durch Application erzeugt. |
| name | text | NO | - | Anzeigename des Kundenunternehmens. |
| status | text | NO | 'ACTIVE' | ACTIVE \| SUSPENDED \| DEACTIVATED. |
| created_at | timestamptz | NO | now() | Erstellungszeitpunkt. |
| updated_at | timestamptz | NO | now() | Letzte fachliche/technische Aktualisierung; im Write-Pfad fortschreiben. |

#### Constraints

PRIMARY KEY (id).

CHECK status IN ('ACTIVE','SUSPENDED','DEACTIVATED').

Kein UNIQUE(name): unterschiedliche Kundenunternehmen dürfen denselben Namen tragen.

Kein Hard Delete im normalen Betrieb; abhängige Tenant-Daten verwenden ON DELETE RESTRICT.

#### Indizes

idx_companies__status(status) – relevant für providerseitige Tenant-Verwaltung.

### 4.2 accounts

Persönliche Login-Identität. Tenant-Accounts gehören genau einer Company; Platform Admin ist logisch/physisch über account_scope getrennt.

| Spalte | PostgreSQL-Typ | Null? | Default | Bedeutung |
| --- | --- | --- | --- | --- |
| id | uuid | NO | - | UUID v7 Primary Key; durch Application erzeugt. |
| company_id | uuid | YES | - | Tenant für TENANT-Accounts; NULL bei PLATFORM. |
| account_scope | text | NO | 'TENANT' | TENANT \| PLATFORM. |
| role | text | NO | - | COMPANY_ADMIN \| EMPLOYEE \| PLATFORM_ADMIN. |
| email | text | NO | - | Login-/Kontaktadresse; case-insensitive eindeutig. |
| password_hash | text | YES | - | NULL bis initiale Aktivierung/Passwortsetzung möglich. |
| email_verified_at | timestamptz | YES | - | Zeitpunkt erfolgreicher E-Mail-Verifikation. |
| status | text | NO | 'PENDING_ACTIVATION' | PENDING_ACTIVATION \| ACTIVE \| DEACTIVATED. |
| deactivated_at | timestamptz | YES | - | Zeitpunkt manueller Deaktivierung, falls vorhanden. |
| created_at | timestamptz | NO | now() | Erstellungszeitpunkt. |
| updated_at | timestamptz | NO | now() | Letzte fachliche/technische Aktualisierung; im Write-Pfad fortschreiben. |

#### Constraints

PRIMARY KEY (id).

UNIQUE (company_id, id) für tenant-sichere Composite FKs.

CHECK account_scope IN ('TENANT','PLATFORM').

CHECK role IN ('COMPANY_ADMIN','EMPLOYEE','PLATFORM_ADMIN').

CHECK status IN ('PENDING_ACTIVATION','ACTIVE','DEACTIVATED').

CHECK: PLATFORM => company_id IS NULL AND role='PLATFORM_ADMIN'; TENANT => company_id IS NOT NULL AND role IN ('COMPANY_ADMIN','EMPLOYEE').

FK company_id → companies(id) ON DELETE RESTRICT, wenn company_id gesetzt ist.

Globale case-insensitive E-Mail-Eindeutigkeit via UNIQUE INDEX ON lower(email).

#### Indizes

uq_accounts__email_ci ON accounts(lower(email)).

idx_accounts__company_status_role(company_id, status, role) WHERE company_id IS NOT NULL.

#### Hinweise

Activation-/Reset-/Session-Token-Tabellen werden nicht vorweggenommen; konkrete Session-/Token-Strategie gehört zu Phase 9 Security Design.

### 4.3 employees

Fachlicher Mitarbeiterstammsatz; getrennt vom Account-Lifecycle.

| Spalte | PostgreSQL-Typ | Null? | Default | Bedeutung |
| --- | --- | --- | --- | --- |
| id | uuid | NO | - | UUID v7 Primary Key; durch Application erzeugt. |
| company_id | uuid | NO | - | Tenant. |
| account_id | uuid | NO | - | Persönlicher Tenant-Account. |
| employee_number | text | NO | - | Fachliche Mitarbeiter-ID/Kennung innerhalb der Company. |
| first_name | text | NO | - | Vorname. |
| last_name | text | NO | - | Nachname. |
| employment_start | date | YES | - | Beschäftigungsbeginn; kann für frühe Aktivierung in der Zukunft liegen. |
| employment_end | date | YES | - | Firmenbezogenes Beschäftigungsende. |
| shift_eligibility | text | NO | - | TAG \| NACHT \| BOTH. |
| status | text | NO | 'ACTIVE' | ACTIVE \| DEACTIVATED. |
| deactivated_at | timestamptz | YES | - | Manuelle fachliche Deaktivierung. |
| created_at | timestamptz | NO | now() | Erstellungszeitpunkt. |
| updated_at | timestamptz | NO | now() | Letzte fachliche/technische Aktualisierung; im Write-Pfad fortschreiben. |

#### Constraints

PRIMARY KEY (id).

UNIQUE (company_id, id).

UNIQUE (company_id, employee_number).

UNIQUE (company_id, account_id).

Composite FK (company_id, account_id) → accounts(company_id, id) ON DELETE RESTRICT.

CHECK shift_eligibility IN ('TAG','NACHT','BOTH').

CHECK status IN ('ACTIVE','DEACTIVATED').

CHECK employment_end IS NULL OR employment_start IS NULL OR employment_end >= employment_start.

#### Indizes

idx_employees__company_status_name(company_id, status, last_name, first_name).

### 4.4 projects

Einsatzobjekt/Projekt einschließlich der in Phase 5 freigegebenen Stammdaten und Lifecycle-Zustände.

| Spalte | PostgreSQL-Typ | Null? | Default | Bedeutung |
| --- | --- | --- | --- | --- |
| id | uuid | NO | - | UUID v7 Primary Key; durch Application erzeugt. |
| company_id | uuid | NO | - | Tenant. |
| name | text | NO | - | Projektname. |
| address | text | NO | - | Projektadresse. |
| internal_code | text | YES | - | Optionale interne Kennung, z. B. CM-01. |
| note | text | YES | - | Optionale interne Notiz. |
| status | text | NO | 'ACTIVE' | ACTIVE \| INACTIVE \| ARCHIVED. |
| created_at | timestamptz | NO | now() | Erstellungszeitpunkt. |
| updated_at | timestamptz | NO | now() | Letzte fachliche/technische Aktualisierung; im Write-Pfad fortschreiben. |

#### Constraints

PRIMARY KEY (id).

UNIQUE (company_id, id).

FK company_id → companies(id) ON DELETE RESTRICT.

CHECK status IN ('ACTIVE','INACTIVE','ARCHIVED').

Kein UNIQUE(name) und kein UNIQUE(address).

Optionale internal_code ist nur innerhalb derselben Company eindeutig.

#### Indizes

uq_projects__company_internal_code(company_id, internal_code) WHERE internal_code IS NOT NULL.

idx_projects__company_status(company_id, status).

#### Hinweise

ARCHIVED wird durch Application Policy read-only behandelt; die DB löscht das Projekt nicht.

### 4.5 project_assignments

Zeitabhängige Zuordnung Employee ↔ Project für einen Kalendermonat.

| Spalte | PostgreSQL-Typ | Null? | Default | Bedeutung |
| --- | --- | --- | --- | --- |
| id | uuid | NO | - | UUID v7 Primary Key; durch Application erzeugt. |
| company_id | uuid | NO | - | Tenant. |
| employee_id | uuid | NO | - | Zugeordneter Employee. |
| project_id | uuid | NO | - | Zielprojekt. |
| planning_month | date | NO | - | Immer erster Kalendertag des Monats, z. B. 2026-10-01. |
| created_at | timestamptz | NO | now() | Erstellungszeitpunkt. |
| updated_at | timestamptz | NO | now() | Letzte fachliche/technische Aktualisierung; im Write-Pfad fortschreiben. |

#### Constraints

PRIMARY KEY (id).

UNIQUE (company_id, id).

Composite FK (company_id, employee_id) → employees(company_id, id) ON DELETE RESTRICT.

Composite FK (company_id, project_id) → projects(company_id, id) ON DELETE RESTRICT.

UNIQUE (company_id, employee_id, planning_month) – höchstens ein Projekt je Mitarbeiter/Monat.

CHECK planning_month = date_trunc('month', planning_month)::date.

#### Indizes

idx_project_assignments__project_month(company_id, project_id, planning_month).

idx_project_assignments__employee_month(company_id, employee_id, planning_month) – durch Unique Constraint bereits abgedeckt.

### 4.6 shift_definitions

Projektbezogene TAG/NACHT-Schichtdefinition mit lokalen Start-/Endzeiten.

| Spalte | PostgreSQL-Typ | Null? | Default | Bedeutung |
| --- | --- | --- | --- | --- |
| id | uuid | NO | - | UUID v7 Primary Key; durch Application erzeugt. |
| company_id | uuid | NO | - | Tenant. |
| project_id | uuid | NO | - | Owning Project. |
| shift_code | text | NO | - | TAG \| NACHT. |
| start_time | time | NO | - | Lokale Schichtstartzeit. |
| end_time | time | NO | - | Lokale Schichtendzeit; kann am Folgetag liegen. |
| is_active | boolean | NO | true | Ob die Definition für neue Planung verwendet werden darf. |
| created_at | timestamptz | NO | now() | Erstellungszeitpunkt. |
| updated_at | timestamptz | NO | now() | Letzte fachliche/technische Aktualisierung; im Write-Pfad fortschreiben. |

#### Constraints

PRIMARY KEY (id).

UNIQUE (company_id, id).

Zusätzlich UNIQUE (company_id, project_id, id) für projekt-sichere Duty-FKs.

Composite FK (company_id, project_id) → projects(company_id, id) ON DELETE RESTRICT.

UNIQUE (company_id, project_id, shift_code).

CHECK shift_code IN ('TAG','NACHT').

start_time = end_time wird nicht pauschal verboten; konkrete Fachregel kann später validiert werden.

#### Indizes

idx_shift_definitions__project_active(company_id, project_id, is_active).

### 4.7 employee_absences

Minimaler Eligibility-Datensatz für KRANK bzw. genehmigten URLAUB; keine medizinischen Freitexte.

| Spalte | PostgreSQL-Typ | Null? | Default | Bedeutung |
| --- | --- | --- | --- | --- |
| id | uuid | NO | - | UUID v7 Primary Key; durch Application erzeugt. |
| company_id | uuid | NO | - | Tenant. |
| employee_id | uuid | NO | - | Betroffener Employee. |
| absence_type | text | NO | - | KRANK \| URLAUB. |
| starts_on | date | NO | - | Erster betroffener Kalendertag. |
| ends_on | date | NO | - | Letzter betroffener Kalendertag; bei Einzeltag = starts_on. |
| created_at | timestamptz | NO | now() | Erstellungszeitpunkt. |
| updated_at | timestamptz | NO | now() | Letzte fachliche/technische Aktualisierung; im Write-Pfad fortschreiben. |

#### Constraints

PRIMARY KEY (id).

UNIQUE (company_id, id).

Composite FK (company_id, employee_id) → employees(company_id, id) ON DELETE RESTRICT.

CHECK absence_type IN ('KRANK','URLAUB').

CHECK ends_on >= starts_on.

UNIQUE (company_id, employee_id, absence_type, starts_on, ends_on) verhindert exakte Duplikate.

#### Indizes

idx_employee_absences__employee_dates(company_id, employee_id, starts_on, ends_on).

#### Hinweise

Bewusst keine Spalten für Diagnose, Symptome, Krankheitsgrund oder medizinische Notiz.

Überlappende Zeiträume werden nicht durch eine erfundene DB-Regel verboten; Eligibility wird fachlich geprüft.

### 4.8 monthly_plans

Stabile Monatsplan-Ressource pro Project + Kalendermonat.

| Spalte | PostgreSQL-Typ | Null? | Default | Bedeutung |
| --- | --- | --- | --- | --- |
| id | uuid | NO | - | UUID v7 Primary Key; durch Application erzeugt. |
| company_id | uuid | NO | - | Tenant. |
| project_id | uuid | NO | - | Owning Project. |
| planning_month | date | NO | - | Erster Kalendertag des Planmonats. |
| status | text | NO | 'UNPUBLISHED' | UNPUBLISHED \| PUBLISHED. |
| published_at | timestamptz | YES | - | Zeitpunkt der Erstveröffentlichung. |
| published_by_account_id | uuid | YES | - | Tenant-Admin der Erstveröffentlichung. |
| created_at | timestamptz | NO | now() | Erstellungszeitpunkt. |
| updated_at | timestamptz | NO | now() | Letzte fachliche/technische Aktualisierung; im Write-Pfad fortschreiben. |

#### Constraints

PRIMARY KEY (id).

UNIQUE (company_id, id).

Zusätzlich UNIQUE (company_id, project_id, id) für projekt-sichere Duty-FKs.

Composite FK (company_id, project_id) → projects(company_id, id) ON DELETE RESTRICT.

Composite FK (company_id, published_by_account_id) → accounts(company_id, id) ON DELETE RESTRICT, wenn gesetzt.

UNIQUE (company_id, project_id, planning_month).

CHECK planning_month = date_trunc('month', planning_month)::date.

CHECK status IN ('UNPUBLISHED','PUBLISHED').

CHECK: UNPUBLISHED => published_at/published_by NULL; PUBLISHED => beide NOT NULL.

#### Indizes

idx_monthly_plans__company_month(company_id, planning_month).

#### Hinweise

Kein revision/version-Feld für fachliche Monatsplanversionen. Nach der ersten Veröffentlichung bleibt derselbe MonthlyPlan PUBLISHED.

### 4.9 duties

Konkrete Planning Unit; Startdatum + projektspezifische Schichtdefinition. Diese Tabelle ist die Optimistic-Concurrency-Boundary.

| Spalte | PostgreSQL-Typ | Null? | Default | Bedeutung |
| --- | --- | --- | --- | --- |
| id | uuid | NO | - | UUID v7 Primary Key; durch Application erzeugt. |
| company_id | uuid | NO | - | Tenant. |
| project_id | uuid | NO | - | Projektkontext, bewusst redundant für Integrity. |
| monthly_plan_id | uuid | NO | - | Owning MonthlyPlan. |
| shift_definition_id | uuid | NO | - | Projektbezogene TAG/NACHT-Definition. |
| duty_date | date | NO | - | Kalendertag, an dem die Schicht beginnt. |
| concurrency_version | bigint | NO | 1 | Technischer Optimistic-Concurrency-Token; bei jeder Mutation +1. |
| created_at | timestamptz | NO | now() | Erstellungszeitpunkt. |
| updated_at | timestamptz | NO | now() | Letzte fachliche/technische Aktualisierung; im Write-Pfad fortschreiben. |

#### Constraints

PRIMARY KEY (id).

UNIQUE (company_id, id).

Composite FK (company_id, project_id, monthly_plan_id) → monthly_plans(company_id, project_id, id) ON DELETE RESTRICT.

Composite FK (company_id, project_id, shift_definition_id) → shift_definitions(company_id, project_id, id) ON DELETE RESTRICT.

UNIQUE (company_id, monthly_plan_id, duty_date, shift_definition_id).

CHECK concurrency_version > 0.

#### Indizes

idx_duties__plan_date(company_id, monthly_plan_id, duty_date).

idx_duties__project_date(company_id, project_id, duty_date).

#### Hinweise

Die Regel duty_date liegt im planning_month wird im Planning-Service beim Create/Publish geprüft; ein einfacher CHECK kann nicht auf monthly_plans.planning_month zugreifen.

### 4.10 plan_assignments

Aktuelle Zuordnung eines Employees zu einer Duty; keine eigenständige vollständige Planungshistorie.

| Spalte | PostgreSQL-Typ | Null? | Default | Bedeutung |
| --- | --- | --- | --- | --- |
| id | uuid | NO | - | UUID v7 Primary Key; durch Application erzeugt. |
| company_id | uuid | NO | - | Tenant. |
| duty_id | uuid | NO | - | Konkrete Duty. |
| employee_id | uuid | NO | - | Eingeplanter Employee. |
| duty_function | text | NO | 'MITARBEITER' | MITARBEITER \| SCHICHTLEITER. |
| created_at | timestamptz | NO | now() | Erstellungszeitpunkt. |
| updated_at | timestamptz | NO | now() | Letzte fachliche/technische Aktualisierung; im Write-Pfad fortschreiben. |

#### Constraints

PRIMARY KEY (id).

UNIQUE (company_id, id).

Composite FK (company_id, duty_id) → duties(company_id, id) ON DELETE RESTRICT.

Composite FK (company_id, employee_id) → employees(company_id, id) ON DELETE RESTRICT.

UNIQUE (company_id, duty_id, employee_id).

CHECK duty_function IN ('MITARBEITER','SCHICHTLEITER').

#### Indizes

idx_plan_assignments__employee(company_id, employee_id).

idx_plan_assignments__duty(company_id, duty_id) – Unique Constraint beginnt bereits mit duty_id nach company_id.

#### Hinweise

Beim Replacement darf die alte Assignment explizit entfernt und die neue angelegt werden; Audit dokumentiert Old/New.

Kein DB-UNIQUE(employee_id, duty_date): die genaue Mehrfachbelegungs-/Ruhezeitregel ist nicht ausreichend freigegeben und bleibt Domain/Production-Gate.

### 4.11 cancellation_requests

Absageantrag eines Employees für einen eigenen Dienst. Antragstellung verändert den Plan nicht automatisch.

| Spalte | PostgreSQL-Typ | Null? | Default | Bedeutung |
| --- | --- | --- | --- | --- |
| id | uuid | NO | - | UUID v7 Primary Key; durch Application erzeugt. |
| company_id | uuid | NO | - | Tenant. |
| duty_id | uuid | NO | - | Betroffene Duty. |
| requester_employee_id | uuid | NO | - | Absagender Employee. |
| status | text | NO | 'OPEN' | OPEN \| UNDER_REVIEW \| APPROVED \| REJECTED \| WITHDRAWN \| VOID. |
| decided_by_account_id | uuid | YES | - | Admin bei finaler Entscheidung, sofern vorhanden. |
| decided_at | timestamptz | YES | - | Finaler Entscheidungszeitpunkt, sofern vorhanden. |
| created_at | timestamptz | NO | now() | Erstellungszeitpunkt. |
| updated_at | timestamptz | NO | now() | Letzte fachliche/technische Aktualisierung; im Write-Pfad fortschreiben. |

#### Constraints

PRIMARY KEY (id).

UNIQUE (company_id, id).

Composite FK (company_id, duty_id) → duties(company_id, id) ON DELETE RESTRICT.

Composite FK (company_id, requester_employee_id) → employees(company_id, id) ON DELETE RESTRICT.

Composite FK (company_id, decided_by_account_id) → accounts(company_id, id) ON DELETE RESTRICT, wenn gesetzt.

CHECK status IN ('OPEN','UNDER_REVIEW','APPROVED','REJECTED','WITHDRAWN','VOID').

Partieller UNIQUE-Index verhindert einen zweiten gleichzeitig offenen/prüfbaren Antrag für dieselbe Duty + denselben Employee.

#### Indizes

uq_cancellation_requests__active_request(company_id, duty_id, requester_employee_id) WHERE status IN ('OPEN','UNDER_REVIEW').

idx_cancellation_requests__work_queue(company_id, status, created_at) WHERE status IN ('OPEN','UNDER_REVIEW').

idx_cancellation_requests__duty(company_id, duty_id).

#### Hinweise

Ob der Employee bei Erstellung aktuell in plan_assignments der Duty steht, wird serverseitig in derselben Business-Transaktion geprüft.

### 4.12 replacement_needs

Organisatorischer Ersatzbedarf als 1:1-Folge einer gültigen CancellationRequest.

| Spalte | PostgreSQL-Typ | Null? | Default | Bedeutung |
| --- | --- | --- | --- | --- |
| id | uuid | NO | - | UUID v7 Primary Key; durch Application erzeugt. |
| company_id | uuid | NO | - | Tenant. |
| cancellation_request_id | uuid | NO | - | Root CancellationRequest. |
| status | text | NO | 'OPEN' | OPEN \| RESOLVED \| CLOSED. |
| resolved_at | timestamptz | YES | - | Zeitpunkt erfolgreicher Ersatzauflösung/Schließung, sofern passend. |
| created_at | timestamptz | NO | now() | Erstellungszeitpunkt. |
| updated_at | timestamptz | NO | now() | Letzte fachliche/technische Aktualisierung; im Write-Pfad fortschreiben. |

#### Constraints

PRIMARY KEY (id).

UNIQUE (company_id, id).

Composite FK (company_id, cancellation_request_id) → cancellation_requests(company_id, id) ON DELETE RESTRICT.

UNIQUE (company_id, cancellation_request_id) – genau ein Need pro CancellationRequest.

CHECK status IN ('OPEN','RESOLVED','CLOSED').

#### Indizes

idx_replacement_needs__open(company_id, created_at) WHERE status='OPEN'.

#### Hinweise

APPROVED ohne Ersatz lässt den Need OPEN, damit der unbesetzte Dienst als offener Besetzungsbedarf sichtbar bleibt.

WITHDRAWN/VOID/REJECTED schließen den offenen Need fachlich (CLOSED).

### 4.13 replacement_offers

Angebot eines geeigneten Employees für einen offenen ReplacementNeed.

| Spalte | PostgreSQL-Typ | Null? | Default | Bedeutung |
| --- | --- | --- | --- | --- |
| id | uuid | NO | - | UUID v7 Primary Key; durch Application erzeugt. |
| company_id | uuid | NO | - | Tenant. |
| replacement_need_id | uuid | NO | - | Offener Ersatzbedarf. |
| employee_id | uuid | NO | - | Anbietender Employee. |
| status | text | NO | 'OPEN' | OPEN \| SELECTED \| NOT_SELECTED \| INVALIDATED. |
| created_at | timestamptz | NO | now() | Erstellungszeitpunkt. |
| updated_at | timestamptz | NO | now() | Letzte fachliche/technische Aktualisierung; im Write-Pfad fortschreiben. |

#### Constraints

PRIMARY KEY (id).

UNIQUE (company_id, id).

Composite FK (company_id, replacement_need_id) → replacement_needs(company_id, id) ON DELETE RESTRICT.

Composite FK (company_id, employee_id) → employees(company_id, id) ON DELETE RESTRICT.

CHECK status IN ('OPEN','SELECTED','NOT_SELECTED','INVALIDATED').

Partieller UNIQUE-Index: höchstens ein aktives OPEN-Angebot pro Employee + Need.

Partieller UNIQUE-Index: höchstens ein SELECTED-Angebot pro Need.

#### Indizes

uq_replacement_offers__active_employee_need(company_id, replacement_need_id, employee_id) WHERE status='OPEN'.

uq_replacement_offers__one_selected(company_id, replacement_need_id) WHERE status='SELECTED'.

idx_replacement_offers__need_status(company_id, replacement_need_id, status).

idx_replacement_offers__employee_status(company_id, employee_id, status).

#### Hinweise

Eligibility (Projektzuordnung, TAG/NACHT, KRANK/URLAUB, aktueller Planstand) muss bei Angebot und nochmals vor finaler Auswahl serverseitig revalidiert werden.

Kein Ersatzkontingent/Counter; CR-01 entfernt diese Regel vollständig.

### 4.14 audit_entries

Append-only Business Audit für kritische Mutationen; getrennt vom technischen Application Log.

| Spalte | PostgreSQL-Typ | Null? | Default | Bedeutung |
| --- | --- | --- | --- | --- |
| id | uuid | NO | - | UUID v7 Primary Key; durch Application erzeugt. |
| company_id | uuid | YES | - | Tenant bei tenantbezogenem Audit; NULL für providerweite Plattformereignisse. |
| scope | text | NO | 'TENANT' | TENANT \| PLATFORM. |
| actor_account_id | uuid | YES | - | Ausführender Account; NULL bei Systemaktion. |
| action | text | NO | - | Stabiler technischer Action-Code. |
| resource_type | text | NO | - | z. B. EMPLOYEE, DUTY, CANCELLATION_REQUEST. |
| resource_id | uuid | YES | - | Betroffene Ressource, falls vorhanden. |
| old_values | jsonb | YES | - | Nur relevante alte Business-Werte. |
| new_values | jsonb | YES | - | Nur relevante neue Business-Werte. |
| correlation_id | uuid | YES | - | Technische Korrelation über Request/Use Case. |
| occurred_at | timestamptz | NO | now() | Fachlich/technischer Ereigniszeitpunkt. |

#### Constraints

PRIMARY KEY (id).

FK company_id → companies(id) ON DELETE RESTRICT, wenn gesetzt.

FK actor_account_id → accounts(id) ON DELETE RESTRICT, wenn gesetzt.

CHECK scope IN ('TENANT','PLATFORM').

CHECK: TENANT => company_id IS NOT NULL; PLATFORM => company_id IS NULL oder providerweiter Vorgang.

Keine UPDATE/DELETE-Nutzung durch normale Application-Pfade; append-only Policy wird zusätzlich über DB-Privileges in Security/Deployment gehärtet.

#### Indizes

idx_audit_entries__resource(company_id, resource_type, resource_id, occurred_at DESC).

idx_audit_entries__actor(actor_account_id, occurred_at DESC).

#### Hinweise

Audit speichert keine Passwörter, Tokens oder medizinischen Inhalte. Keine vollständige MonthlyPlan-Kopie pro Duty-Änderung.

### 4.15 edit_leases

Kurzlebige Koordinationssperre für dieselbe Duty bzw. optional denselben Cancellation Case; kein PostgreSQL-Langzeitlock.

| Spalte | PostgreSQL-Typ | Null? | Default | Bedeutung |
| --- | --- | --- | --- | --- |
| id | uuid | NO | - | UUID v7 Primary Key; durch Application erzeugt. |
| company_id | uuid | NO | - | Tenant. |
| duty_id | uuid | YES | - | Geleaste Planning Unit. |
| cancellation_request_id | uuid | YES | - | Optional geleaster Workflow-Case. |
| owner_account_id | uuid | NO | - | Admin, der die Bearbeitung hält. |
| acquired_at | timestamptz | NO | now() | Lease-Erwerb. |
| renewed_at | timestamptz | YES | - | Letzte Erneuerung. |
| expires_at | timestamptz | NO | - | Ablaufzeit; Application prüft/erneuert atomar. |

#### Constraints

PRIMARY KEY (id).

UNIQUE (company_id, id).

Composite FK (company_id, duty_id) → duties(company_id, id) ON DELETE RESTRICT, wenn gesetzt.

Composite FK (company_id, cancellation_request_id) → cancellation_requests(company_id, id) ON DELETE RESTRICT, wenn gesetzt.

Composite FK (company_id, owner_account_id) → accounts(company_id, id) ON DELETE RESTRICT.

CHECK genau eine der Spalten duty_id / cancellation_request_id ist NOT NULL.

CHECK expires_at > acquired_at.

#### Indizes

uq_edit_leases__duty(company_id, duty_id) WHERE duty_id IS NOT NULL.

uq_edit_leases__case(company_id, cancellation_request_id) WHERE cancellation_request_id IS NOT NULL.

idx_edit_leases__expires_at(expires_at) – Cleanup/Expiry.

#### Hinweise

Abgelaufene Slot-Zeilen werden atomar übernommen/aktualisiert. Korrektheitsgarantie bleibt duties.concurrency_version.

### 4.16 idempotency_records

Selektive Request-Idempotency für kritische Commands, nicht für jeden Write.

| Spalte | PostgreSQL-Typ | Null? | Default | Bedeutung |
| --- | --- | --- | --- | --- |
| id | uuid | NO | - | UUID v7 Primary Key; durch Application erzeugt. |
| company_id | uuid | NO | - | Tenant. |
| operation | text | NO | - | Stabiler Command-Scope, z. B. SELECT_REPLACEMENT. |
| idempotency_key | text | NO | - | Client/Command-Key. |
| request_fingerprint | text | NO | - | Hash des normalisierten fachlichen Requests. |
| response_status | integer | YES | - | Gespeicherter HTTP/Command-Status für identischen Retry. |
| response_body | jsonb | YES | - | Kompakte Ergebnis-Metadaten, keine sensitiven Secrets. |
| resource_id | uuid | YES | - | Optional erzeugte/betroffene Ressource. |
| expires_at | timestamptz | NO | - | Ablauf gemäß konfigurierter Retention. |
| created_at | timestamptz | NO | now() | Erstellungszeitpunkt. |

#### Constraints

PRIMARY KEY (id).

FK company_id → companies(id) ON DELETE RESTRICT.

UNIQUE (company_id, operation, idempotency_key).

CHECK expires_at > created_at.

#### Indizes

idx_idempotency_records__expires_at(expires_at).

#### Hinweise

Die konkrete Retention-Dauer ist Betriebs-/Implementierungskonfiguration und kein fachlicher DB-Invariant. Ein gleicher Key mit anderem Fingerprint wird als Conflict behandelt.

### 4.17 outbox_events

Transactional Outbox für tatsächlich implementierte asynchrone Side Effects.

| Spalte | PostgreSQL-Typ | Null? | Default | Bedeutung |
| --- | --- | --- | --- | --- |
| id | uuid | NO | - | UUID v7 Primary Key; durch Application erzeugt. |
| company_id | uuid | YES | - | Tenant bei tenantbezogenem Event; optional NULL für spätere Platform-Events. |
| event_type | text | NO | - | Stabiler Eventname. |
| aggregate_type | text | NO | - | Quellressourcentyp. |
| aggregate_id | uuid | YES | - | Quellressource. |
| payload | jsonb | NO | '{}'::jsonb | Minimales Eventpayload/Referenzen. |
| status | text | NO | 'PENDING' | PENDING \| PROCESSING \| PROCESSED \| FAILED. |
| attempts | integer | NO | 0 | Anzahl Verarbeitungsversuche. |
| available_at | timestamptz | NO | now() | Frühester Verarbeitungszeitpunkt. |
| locked_at | timestamptz | YES | - | Kurzlebiges Worker-Lock. |
| processed_at | timestamptz | YES | - | Erfolgreicher Abschluss. |
| last_error | text | YES | - | Letzter technischer Fehler, ohne Secrets. |
| created_at | timestamptz | NO | now() | Erstellungszeitpunkt. |

#### Constraints

PRIMARY KEY (id).

FK company_id → companies(id) ON DELETE RESTRICT, wenn gesetzt.

CHECK status IN ('PENDING','PROCESSING','PROCESSED','FAILED').

CHECK attempts >= 0.

#### Indizes

idx_outbox_events__dispatch(available_at, created_at) WHERE status IN ('PENDING','FAILED').

idx_outbox_events__aggregate(company_id, aggregate_type, aggregate_id).

#### Hinweise

At-least-once-Verarbeitung; stabile Event-ID = id. Worker muss idempotent sein. Outbox wird nur aktiviert, wenn der Release tatsächlich einen Async Side Effect besitzt.

## 5. Zentrale DB-Invarianten und wo sie durchgesetzt werden

| Invariant | Enforcement | Umsetzung |
| --- | --- | --- |
| Employee-ID nur innerhalb Company eindeutig | DB | UNIQUE(company_id, employee_number). |
| Ein Project pro Employee/Monat | DB | UNIQUE(company_id, employee_id, planning_month). |
| Ein MonthlyPlan pro Project/Monat | DB | UNIQUE(company_id, project_id, planning_month). |
| Keine Cross-Tenant-Referenzen | DB | company_id auf allen Tenant-Tabellen + Composite FKs. |
| Ein aktiver Cancellation-Request pro Employee/Duty | DB | Partial Unique Index auf OPEN/UNDER_REVIEW. |
| Ein aktives Offer je Employee/Need | DB | Partial Unique Index auf status=OPEN. |
| Höchstens ein final ausgewähltes Offer je Need | DB | Partial Unique Index auf status=SELECTED. |
| Gültiger ProjectAssignment für geplanten Employee | Domain + Transaction | Vor Assignment und vor Publish/Replacement revalidieren. |
| TAG/NACHT-Eignung | Domain + Transaction | Employee.shift_eligibility gegen Duty/Shift prüfen. |
| KRANK/URLAUB | Domain + Transaction | employee_absences am betroffenen Duty-Tag prüfen. |
| Keine stale Duty-Überschreibung | DB conditional update + Domain | UPDATE ... WHERE id=? AND concurrency_version=?; sonst Conflict. |
| Replacement + Planmutation + Audit atomar | Transaction | Eine lokale PostgreSQL-Transaktion. |
| Keine erfundene Ruhezeitregel | Nicht als DB-Constraint | Production Gate; bis dahin nur freigegebene Planungsregeln validieren. |

## 6. Optimistic Concurrency und Edit Lease

Der Edit Lease verbessert die Multi-Admin-UX, ist aber nicht die Korrektheitsgarantie. Der maßgebliche Schutz gegen Lost Updates ist duties.concurrency_version.

-- Beispiel: erwartete Version = 12
UPDATE duties
SET concurrency_version = concurrency_version + 1,
    updated_at = now()
WHERE company_id = :company_id
  AND id = :duty_id
  AND concurrency_version = 12;

-- affected_rows = 0  =>  STALE / CONFLICT, kein Blind-Retry

Lease-Erwerb/Erneuerung erfolgt atomar und nur, wenn der bestehende Lease abgelaufen ist oder demselben Owner gehört.

Manuelle Planänderung und Replacement-Entscheidung verwenden für dieselbe Duty denselben Lease-Scope.

Unabhängige Duties können parallel bearbeitet werden.

## 7. Kritische Transaction Boundaries

| Use Case | Atomarer Persistenzumfang |
| --- | --- |
| Erstveröffentlichung | MonthlyPlan status→PUBLISHED + published_at/by + Pflicht-Audit + optional Outbox. |
| Direkte Published-Plan-Änderung | Lease/Expected Version prüfen → Duty/Assignments mutieren → concurrency_version erhöhen → Audit → optional Outbox. |
| Ersatz auswählen | Need OPEN + Offer OPEN + Eligibility + Duty-Version prüfen → altes Assignment entfernen → Ersatz-Assignment anlegen → Need RESOLVED → Offer SELECTED → andere OPEN Offers NOT_SELECTED → Audit → optional Outbox. |
| Absage ohne Ersatz genehmigen | Requester-Assignment entfernen → Cancellation APPROVED → ReplacementNeed bleibt OPEN → Audit → optional Outbox. |
| Absage zurückziehen | Cancellation WITHDRAWN → Need CLOSED → offene Offers INVALIDATED → Audit; Planning unverändert. |
| Employee deaktivieren | Employee DEACTIVATED + Account DEACTIVATED über Identity Contract + Audit in lokaler Transaktion; Sessionstrategie Phase 9. |

## 8. Index Strategy

PostgreSQL erzeugt für Foreign Keys nicht automatisch Indizes. Deshalb werden FK- und Query-Pfade explizit bewertet. Composite Indizes orientieren sich an tatsächlichen Gleichheits-/Range-Filtern; Partial Indizes werden für kleine offene Work-Queues und Status-Slices genutzt.

| Query Pattern | Index | Begründung |
| --- | --- | --- |
| Employee-Suche | employees(company_id, status, last_name, first_name) | Admin-Liste/Filter. |
| Project-Liste | projects(company_id, status) | Projektübersicht. |
| Monatszuordnung | project_assignments(company_id, project_id, planning_month) | Mitarbeiterpool je Project/Monat. |
| Employee-Plan | plan_assignments(company_id, employee_id) + Join duties/monthly_plans | Eigener veröffentlichter Plan. |
| Duty-Editor | duties(company_id, monthly_plan_id, duty_date) | Monatsplan je Projekt. |
| Work Queue | cancellation_requests(company_id, status, created_at) WHERE status offen | Nur offene Fälle indexieren. |
| Replacement Offers | replacement_offers(company_id, replacement_need_id, status) | Case Workspace. |
| Audit | audit_entries(company_id, resource_type, resource_id, occurred_at DESC) | Ressourcenbezogene Nachvollziehbarkeit. |
| Outbox Worker | outbox_events(available_at, created_at) WHERE status pending/failed | Schnelles Polling ohne erledigte Events. |

| Keine vorzeitige Index-Flut<br>Bei ca. 100 Nutzern ist Korrektheit wichtiger als Mikro-Optimierung. Zusätzliche Indizes werden später anhand echter Queries und EXPLAIN/ANALYZE ergänzt, nicht prophylaktisch auf jede Spalte gelegt. |
| --- |


## 9. Delete-, Deactivation- und Archivierungsstrategie

| Objekt | Strategie | Begründung |
| --- | --- | --- |
| Company | Kein normaler Hard Delete | Statusbasierter Lifecycle; abhängige Daten RESTRICT. |
| Account | Deaktivieren | Status=DEACTIVATED; Security Design invalidiert Sessions. |
| Employee | Deaktivieren | Historische Planning-/Workflow-/Audit-Referenzen bleiben erhalten. |
| Project | INACTIVE / ARCHIVED | Archiviert read-only; kein Cascade Delete. |
| ProjectAssignment | Korrektur über Update/Audit oder explizite Löschung nur wenn fachlich sicher | Vergangene Monatszuordnungen nicht pauschal löschen. |
| PlanAssignment | Operative Zeile darf bei Planmutation explizit entfernt werden | Audit hält kritische Old/New-Werte; keine vollständige Planhistorie. |
| Cancellation/Need/Offer | Nicht hard-deleten | Workflow-Historie über Status erhalten. |
| AuditEntry | Append-only | Keine normale Update/Delete-Operation. |
| EditLease/Idempotency/Outbox | Technischer Cleanup erlaubt | Retention/Cleanup folgt 7.3. |

## 10. Referenz-DDL für die kritischsten Constraints

Die folgenden Ausschnitte sind Design-Referenz und noch keine nummerierte Migration. Phase 7.3 übernimmt sie in reproduzierbare Migrationen.

-- Employee business key scoped by tenant
ALTER TABLE employees
  ADD CONSTRAINT uq_employees__company_employee_number
  UNIQUE (company_id, employee_number);

-- Exactly one project per employee and month
ALTER TABLE project_assignments
  ADD CONSTRAINT uq_project_assignments__employee_month
  UNIQUE (company_id, employee_id, planning_month);

-- One monthly plan per project/month
ALTER TABLE monthly_plans
  ADD CONSTRAINT uq_monthly_plans__project_month
  UNIQUE (company_id, project_id, planning_month);

-- Prevent duplicate simultaneously-open cancellation requests
CREATE UNIQUE INDEX uq_cancellation_requests__active_request
ON cancellation_requests (company_id, duty_id, requester_employee_id)
WHERE status IN ('OPEN', 'UNDER_REVIEW');

-- At most one open offer per employee and replacement need
CREATE UNIQUE INDEX uq_replacement_offers__active_employee_need
ON replacement_offers (company_id, replacement_need_id, employee_id)
WHERE status = 'OPEN';

-- At most one selected replacement per need
CREATE UNIQUE INDEX uq_replacement_offers__one_selected
ON replacement_offers (company_id, replacement_need_id)
WHERE status = 'SELECTED';

-- Tenant-safe relationship example
ALTER TABLE plan_assignments
  ADD CONSTRAINT fk_plan_assignments__employees
  FOREIGN KEY (company_id, employee_id)
  REFERENCES employees(company_id, id)
  ON DELETE RESTRICT;

## 11. Bewusst nicht in Phase 7.2 erfundene Entscheidungen

Konkrete Session-/Refresh-Token-Persistenz und Session-Invalidierung: Phase 9 Security Design.

API DTOs, Idempotency Header/Statuscodes und Error Payloads: Phase 8 API Design.

RLS-Policy als zusätzliche Defense-in-Depth: in Phase 9 bewerten; Composite Tenant-FKs bleiben unabhängig davon bestehen.

Konkrete gesetzliche Arbeits-/Ruhezeitgrenzen: Production Gate, nicht durch DB-Constraints erfinden.

Idempotency-Retention, Outbox-Retry-Backoff und Cleanup-Zeitpläne: Phase 7.3/Operations-Konfiguration.

Automatische Beschäftigungsende-Deaktivierung und 14-Tage-Erinnerung: nach aktueller Architektur Post-Praktikum.

Full Notifications, Billing, Tagesplan, Lohnabrechnungen, GPS/Zeiterfassung: nicht in dieses Schema hineinziehen.

## 12. Database Integrity Test Matrix

| ID | Testfall | Erwartung |
| --- | --- | --- |
| DB-01 | Zwei Employees derselben Company mit gleicher employee_number | Zweiter Insert/Update schlägt mit Unique Violation fehl. |
| DB-02 | Gleiche employee_number in zwei Companies | Erlaubt. |
| DB-03 | Employee in zwei Projects im selben planning_month | Zweite Zuordnung schlägt fehl. |
| DB-04 | Child mit company_id A referenziert Parent aus Company B | Composite FK schlägt fehl. |
| DB-05 | Zweiter MonthlyPlan für Project+Monat | Unique Violation. |
| DB-06 | Zweiter offener CancellationRequest für Employee+Duty | Partial Unique Index blockiert. |
| DB-07 | Zweites OPEN Offer desselben Employees für denselben Need | Partial Unique Index blockiert. |
| DB-08 | Zweites SELECTED Offer für denselben Need | Partial Unique Index blockiert. |
| DB-09 | Stale Duty Update mit alter concurrency_version | 0 Rows updated; Application liefert Conflict. |
| DB-10 | Ersatztransaction scheitert beim Audit | Gesamte Transaktion rollback; Plan/Workflow unverändert. |
| DB-11 | KRANK-Zeile mit Diagnosefeld | Nicht möglich, weil kein solches Feld existiert. |
| DB-12 | planning_month nicht erster Monatstag | CHECK Violation. |
| DB-13 | employment_end vor employment_start | CHECK Violation. |
| DB-14 | Hard Delete eines historisch referenzierten Employee/Project | FK RESTRICT verhindert Löschung. |

## 13. Phase-7.2 Gate Review

| Prüfpunkt | Ergebnis |
| --- | --- |
| UUID v7 + plural snake_case festgelegt | PASS |
| PostgreSQL-Datentypstrategie festgelegt | PASS |
| Alle Phase-7.1-Entities physisch abgebildet | PASS |
| Tenant-safe Composite FKs definiert | PASS |
| Business Keys und Unique Constraints definiert | PASS |
| Statuspersistenz festgelegt | PASS |
| ON DELETE / Lifecycle definiert | PASS |
| Planning Concurrency physisch definiert | PASS |
| Partial Unique Constraints für Cancellation/Replacement definiert | PASS |
| Audit / Idempotency / Outbox konkretisiert | PASS |
| Query-getriebene Indexstrategie definiert | PASS |
| Security-/API-/Operations-Grenzen respektiert | PASS |
| Blocker für Phase 7.3 | NONE |

| Gate-Entscheidung<br>PHASE 7.2 – POSTGRESQL PHYSICAL DATABASE DESIGN: FINAL / APPROVED. Das physische Schema ist konsistent mit Phase 7.1, CR-01/02/03 und der Phase-6-Architektur. Es bestehen keine Blocker für Phase 7.3 – Database Operations & Final Gate. |
| --- |


## 14. Referenzbasis und Herkunft der Entscheidungen

Source-derived: fachliche Regeln, Scope, Rollen, Status-/Workflow-Invarianten und Architekturgrenzen stammen aus den freigegebenen SecurePlan-Baselines. Phase-7.2-Designentscheidungen: konkrete Datentypen, UUID-v7-Generatorort, TEXT+CHECK, konkrete Composite/Partial-Unique-Indizes, direkte company_id-Denormalisierung und Indexnamen sind technische Entscheidungen dieses Dokuments.

SecurePlan – Phase 7.1 Conceptual & Logical Database Design v1.0.

SecurePlan – Phase 2 FINAL Requirements Baseline v1.1.

SecurePlan – Phase 3 FINAL Scope & MVP v1.1 + CR-01 Ersatzlimit-Entfernung.

SecurePlan – CR-02 B2B-SaaS Tenant Model v1.1 FINAL / APPROVED.

SecurePlan – CR-03 Direct Published Plan Updates FINAL / APPROVED.

SecurePlan – Phase 4 Systemanalyse FINAL v1.2.

SecurePlan – Phase 5 FINAL UX/UI Artifacts (insbesondere Project Stammdaten und Workflow-Zustände).

SecurePlan – Phase 6.5 Transaction / Consistency / Concurrency.

SecurePlan – Phase 6.6 Consolidated Architecture Baseline.

PostgreSQL Best Practices: geeignete Datentypen, explizite FK-Indizes, Composite/Partial Indexes und robuste Constraints.
