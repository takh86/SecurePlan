# SecurePlan – fachlicher Domain-Überblick

Ein Projekt besitzt Monatspläne. Ein Monatsplan enthält Dienste; Mitarbeiter werden diesen Diensten zugeordnet. Absageanträge und Ersatzangebote bilden den fachlichen Workflow zur Änderung einer Besetzung.

```mermaid
flowchart TD
    Projekt --> Monatsplan
    Monatsplan --> Dienst
    Mitarbeiter --> Dienst
    Mitarbeiter --> Absageantrag
    Dienst --> Absageantrag
    Absageantrag --> Ersatzbedarf
    Ersatzbedarf --> Ersatzangebot
    Mitarbeiter --> Ersatzangebot
    Ersatzangebot --> Büroentscheidung
    Büroentscheidung --> Dienst
```

Diese Übersicht beschreibt fachliche Beziehungen. Sie ist kein physisches Datenbankschema und definiert keine technischen Tabellenfelder oder Implementierungsdetails.
