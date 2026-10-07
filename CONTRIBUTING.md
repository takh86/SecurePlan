# Entwicklung und Review

Feature-Branches von `main`: `feat/<thema>`, `fix/<thema>` oder `chore/<thema>`. Kleine nachvollziehbare Commits, z. B. `feat(auth): add account activation`. Keine Secrets, personenbezogenen Kundendaten oder `.env` committen.

Vor einem PR: `npm run lint`, `npm run build`, `npm test`, `npm run test:e2e`; für Persistenzänderungen außerdem Migration + DB-Verifikation. PR beschreibt Problem, Verhalten, Scope, Akzeptanzkriterien, Testevidenz und verbleibende Grenzen. Fehlende Tests als NOT_RUN markieren. `main` wird erst nach Review und grünen relevanten Checks integriert.

Migrationen sind nach Anwendung unveränderlich. Feature-Tests aus Acceptance Criteria ableiten, insbesondere Ownership, Tenant-Isolation, parallele Writes und Rollback. Zusätzliche Schutzregeln wie verpflichtende Reviews müssen im GitHub-Repository konfiguriert werden; dieses Dokument aktiviert keine Branch Protection.
