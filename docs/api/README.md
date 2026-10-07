# Phase 8 – API Design

Stand: 07.10.2026. **8.11 FINAL / APPROVED gemäß bereitgestellter Designquelle vom 06.10.2026.** 47 MVP-Endpunkte unter `/api/v1`; keine implementierte Business-API behauptet.

Normativer Einstieg: [8.11 konsolidierte Baseline](../design-sources/SecurePlan_Phase_8.11_API_Design_Review_Final_Gate_FINAL_v1.0.md). DTO/Validation/Errors/Auth/Concurrency/Query/OpenAPI/Tests: [Quellenindex](../design-sources/README.md). RFC 9457 Problem Details und stabile Domaincodes sind vorgesehen; OpenAPI muss mit dem später implementierten Code übereinstimmen.

8.1 und die frühere repo-lokale 8.2-Fassung bleiben historische Zwischenschritte und dürfen 8.11 nicht übersteuern. [G0](../reviews/g0-handoff.md) verfolgt die DB/API-Handoff-Gaps, insbesondere actor-scoped idempotency, Enums und zeitliche Shiftconfiguration. Zwei technische Healthroutes der Foundation gehören nicht zur fachlichen 47-Endpunktzählung.
