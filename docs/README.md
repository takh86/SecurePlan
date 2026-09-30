# SecurePlan – Projektdokumentation

**Stand:** 30.09.2026

Die Dokumentation konsolidiert die wirksamen Designentscheidungen und verweist auf die technischen Quelldokumente. Die Statusangaben unterscheiden Analyse, Design, Prototyp und ausführbare Implementierung.

## Aktueller Stand

- Phase 2/3: Frozen Requirements / Praktikums-MVP.
- CR-01/02/03: dokumentierte genehmigte Änderungen haben Vorrang vor älteren widersprechenden Aussagen.
- Phase 4: FINAL v1.2; Phase 5: PASS FOR PHASE 6, reale Usability-Sessions weiterhin offen.
- Phase 6.1–6.11: FINAL / APPROVED / CLOSED gemäß Final-Gate 6.11.
- Phase 7.1–7.3: FINAL / APPROVED / COMPLETE gemäß Final-Gate 7.3.
- Phase 8.1: v0.1 Working Draft; Baseline-Abgleich offen, danach 8.2 REST Endpoint Design.
- Production Feature Code, ausführbare Migrationen und Feature-Tests: nicht nachgewiesen.

[Projektstatus](project-status.md) und [aktueller Arbeitsabschnitt](planung/aktuelle-woche.md).

## Dokumentationsbereiche

| Bereich | Inhalt |
|---|---|
| [Requirements](requirements/README.md) | Effective MVP, Traceability, CR-01/02/03 |
| [Systemanalyse](systemanalyse/phase-4-final-v1.2.md) | Phase 4 FINAL v1.2 |
| [UX/UI](ux-ui/phase-5-baseline.md) | Phase-5-Handoff, kontrollierte Follow-ups |
| [Architektur](architektur/ueberblick.md) | Öffentliche Modulübersichten und Phase-6-Gate-Status |
| [Datenbank](datenbank/README.md) | Phase-7-Status und fachlicher Domain-Überblick |
| [API](api/README.md) | Phase 8.1 Working Draft und nächster Designschritt |
| [Planung](planung/aktuelle-woche.md) | Arbeitsabschnitt, Backlog, Roadmap, Fortschritt |
| [Technische Quellen](sources/README.md) | geprüfte DOCX- und PDF-Dokumente |
| [Betreuungsvorlagen](betreuung/vorlagen.md) | Check-in, Check-out, Wochenbericht |

## Architekturteilphasen

- [Phase 6.1 – Architecture Goals & Quality Attributes](architektur/phase-6-1-architecture-goals.md)
- [Phase 6.2 – System Context & Container View](architektur/phase-6-2-system-context-container.md)
- [Phase 6.3 – Backend Building Blocks](architektur/phase-6-3-backend-building-blocks.md)
- [Phase 6.4 – Module Dependencies & Public Contracts](architektur/phase-6-4-module-dependencies-public-contracts.md)
- [Phase 6.5 – Transactions, Consistency & Concurrency](architektur/ueberblick.md)
- [Phase 6.6 – Security Architecture & RBAC](architektur/ueberblick.md)
- [Phase 6.7 – API & Integration Architecture](architektur/ueberblick.md)
- [Phase 6.8 – Deployment & Runtime Architecture](architektur/ueberblick.md)
- [Phase 6.9 – Observability & Operations Architecture](architektur/ueberblick.md)
- [Phase 6.10 – Risks, Trade-offs & ADRs](architektur/ueberblick.md)
- [Phase 6.11 – Architecture Review & Final Baseline](architektur/phase-6-11-final-baseline-gate.md)

## Source of Truth

1. Genehmigte Change Requests / Amendments: CR-01, CR-02 v1.1 und CR-03.
2. Phase 2 Requirements und Phase 3 Scope & MVP, soweit nicht wirksam geändert.
3. Phase 4 FINAL v1.2 und Phase-5-Baseline; Research allein ändert keinen Frozen Scope.
4. Phase-6-Final-Baseline 6.11 und spätere freigegebene Präzisierungen.
5. Phase 7.1–7.3 für das konkretisierte Datenbankdesign.
6. API-Arbeitsstände bleiben Draft, bis sie abgeglichen und freigegeben wurden.

Historische Quellen dürfen superseded Wording enthalten. CR-01 entfernt das 3er-Ersatzlimit; CR-02 legt Company = Tenant fest; CR-03 entfernt parallelen Draft / Re-Publish nach der ersten Veröffentlichung. Supervisor-Reviewfassungen sind Feedbackartefakte, kein Nachweis einer erfolgten Betreuerfreigabe.

## Nachweisregel

- **DOCUMENTED:** Analyse-/Designartefakt vorhanden.
- **PROTOTYPED:** visueller oder interaktiver Prototyp vorhanden.
- **IMPLEMENTED:** Anwendungscode mit passendem Test-/Build-Nachweis vorhanden.
