# CR-03 – Direkte Änderungen am veröffentlichten Monatsplan

**Status:** FINAL / APPROVED gemäß Quelle, 23.09.2026.\
**Quelle:** [CR-03 v1.0](../sources/change-requests/SecurePlan_CR-03_Direct_Published_Plan_Updates_APPROVED_v1.0.docx).

CR-03 hat Vorrang vor älteren Draft-/Re-Publish-Formulierungen. Nach der Erstveröffentlichung wirken autorisierte Änderungen nach Revalidierung und erfolgreichem Commit unmittelbar im aktuellen Plan.

## SecurePlan – Change Request CR-03

Direkte Wirksamkeit veröffentlichter Monatsplanänderungen

Version 1.0 · FINAL / APPROVED · Normative Baseline-Änderung

| Feld | Wert |
| --- | --- |
| Dokument | SecurePlan – CR-03 Direkte Published-Plan-Mutation |
| Version | v1.0 |
| Stand | 23.09.2026 |
| Status | FINAL / APPROVED |
| Entscheider | Product Owner / Projektverantwortlicher |
| Betroffene Baselines | Phase 2 Requirements v1.1; Phase 4 Systemanalyse; Phase 5 UX/UI; Phase 6.1; Phase 6.3 |
| Auslöser | Fachliche Klarstellung: Nach der erstmaligen Veröffentlichung sollen genehmigte Änderungen unmittelbar im aktuellen Monatsplan wirksam werden; kein Draft-/Re-Publish-Workflow. |

## 1. Entscheidung

| Normative Entscheidung<br>Der Monatsplan wird vor der ersten Veröffentlichung erstellt und ist bis dahin nicht für Mitarbeiter bzw. Folgeprozesse verbindlich. Nach der erstmaligen Veröffentlichung existiert kein paralleler Draft-Zustand. Jede durch Büro/Admin autorisierte Planänderung wird nach serverseitiger Revalidierung und erfolgreichem Commit unmittelbar im aktuell veröffentlichten Monatsplan wirksam. Eine zusätzliche Re-Publish-Aktion entfällt. |
| --- |

## 2. Begründung

- Der fachliche Ist-Prozess sieht Büro/Admin als finale Entscheidungsinstanz vor; eine zweite Bestätigung derselben Änderung besitzt keinen zusätzlichen Business-Wert.

- Der Monatsplan bleibt die stabile Planungseinheit für Projekt + Kalendermonat. Operative Änderungen betreffen einzelne Dienste/Planungseinheiten, nicht eine neue vollständige Monatsplan-Kopie.

- Absage/Ersatz wird dadurch konsistenter: Die finale Admin-Entscheidung und die wirksame Planänderung bilden einen einzigen fachlichen Vorgang.

- Audit, Optimistic Concurrency und atomare Transaktionen sichern Nachvollziehbarkeit und Datenintegrität ohne fachliche Monatsplan-Versionierung.

## 3. Normative Änderungen an Phase 2

| Referenz | Neuer normativer Zustand |
| --- | --- |
| BR-MP-04 | ERSETZT: Vor der erstmaligen Veröffentlichung ist der Plan nicht für Mitarbeiter oder Folgeprozesse verbindlich. Nach der erstmaligen Veröffentlichung wird kein paralleler Draft geführt. |
| BR-MP-05 | BLEIBT: Folgeprozesse basieren auf dem aktuell veröffentlichten Monatsplan. |
| BR-MP-06 | ENTFÄLLT: Ein Re-Publish unveränderter Versionen ist nicht mehr Teil des fachlichen Modells. |
| BR-MP-07 | ERSETZT: Autorisierte Änderungen an einem bereits veröffentlichten Monatsplan werden nach erfolgreicher Revalidierung und Transaktion unmittelbar verbindlich. |
| BR-MP-08 | ERSETZT: Jede wirksame Planänderung wird unmittelbar vor Commit erneut gegen die relevanten Projekt-, Schicht-, Zuordnungs- und Eligibility-Regeln validiert. |
| BR-NOT-04 | ERSETZT: Doppelte Benachrichtigungen werden durch Ereignis-/Idempotenzregeln verhindert; Re-Publish ist kein Auslöser mehr. |

## 4. Auswirkungen auf nachgelagerte Baselines

| Dokument | Auswirkung |
| --- | --- |
| Phase 3 Scope/MVP | Kein Scope-Zuwachs. Der Kernflow bleibt Monatsplan → Publish → Absage/Ersatz → Büroentscheidung → aktualisierter veröffentlichter Plan. |
| Phase 4 Systemanalyse | UC-05 beschreibt die erstmalige Veröffentlichung. UC-04 bearbeitet einen veröffentlichten Plan direkt wirksam nach Validierung. UC-12 bleibt atomare Ersatzentscheidung + Planänderung. |
| Phase 5 UX/UI | Kein separater Re-Publish-Schritt nach operativen Änderungen. Konflikt-/Stale-Data-State bleibt bestehen. |
| Phase 6.1 G6 | ERSETZT: Published Monatsplan ist Source of Truth. Vor der ersten Veröffentlichung ist der Plan unveröffentlicht; danach gibt es keinen parallelen Draft. |
| Phase 6.3 Planning Ownership | ERSETZT: Planning besitzt MonthlyPlan, Plan Entries, Erstveröffentlichung, direkte wirksame Planmutation, Validierung und Concurrency Control. Draft/Re-Publish entfällt. |
| Phase 6.4 Public Contracts | BLEIBT: Absage & Ersatz mutiert Planning nicht direkt, sondern nutzt den öffentlichen Planning-Contract. |

## 5. Unveränderte Kernregeln

- Nur autorisierte Büro/Admin-Aktionen dürfen produktive Planänderungen auslösen.

- Der aktuell veröffentlichte Monatsplan bleibt die fachliche Source of Truth.

- Absage ist zunächst ein Antrag und verändert den Plan nicht automatisch.

- Genehmigte Ersatzübernahmen werden atomar umgesetzt.

- Kritische Änderungen bleiben auditierbar, idempotent und gegen konkurrierende Lost Updates geschützt.

- Mitarbeiter sehen ausschließlich den für sie relevanten aktuellen Planstand.

Gate: APPROVED. Diese Änderung ist ab 23.09.2026 normativ und hat bei widersprechenden älteren Formulierungen Vorrang. Sie ist verbindlicher Input für Phase 6.5.
