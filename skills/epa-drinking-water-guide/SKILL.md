---
name: epa-drinking-water-guide
description: Investigate EPA water-system records and analyze contaminant evidence with sdwis_* tools. Use when tracing violations to enforcement or facilities, comparing scoped measurements, or joining staged partitions and UCMR companion tables without overstating coverage.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use this keyless server for public-system research and historical EPA evidence. A household tap-safety assessment, present compliance verdict, or inferred exceedance requires evidence this server does not supply.

## Identifiers

- Resolve a utility name through `sdwis_search_water_systems`; retain the returned PWSID for profile and evidence calls.
- Take `violation_id` from `sdwis_get_violations`, then keep its PWSID when retrieving related enforcement. Association rows connect composite PWSID/violation/action keys; bare IDs are not global keys.
- Resolve a SDWIS `facility_id` from treatment or violation rows through the facilities section of `sdwis_get_system_profile` for the same PWSID. SDWIS and UCMR facility identifiers are separate namespaces.
- Take canvas capabilities from explicit staging results and table names from `sdwis_dataframe_describe`. Retain the selection identity and partition metadata with each table.

## Gates

1. Establish the geographic meaning before selecting a cohort: reported legal-entity state, administrative jurisdiction and service membership answer different questions. None establishes a complete physical service boundary. Do not infer a utility serving an address from a ZIP match alone.
2. Before reporting a complete count or an absent record, follow every source continuation with unchanged selectors, including empty membership checkpoints. Retrieval exhaustion and the current response's `source_complete` are different facts. Describe missing evidence as missing from the acquired EPA selection.
3. For a staged comparison, verify `selection_coverage.chain_complete` for each intended selection and check SQL truncation separately. Coverage requires every source partition and required companion relation; it does not prove the query used them or that EPA paging was an atomic snapshot.
4. Do not replace a missing partition with an independent retrieval that happens to use the same filters. A new retrieval has its own selection identity. If a continuation expires or the source changes, restart the selection and keep the analyses separate.
5. Choose the denominator before filtering measurements. Detected-only results cannot provide a detection fraction over all measurements. Keep censored observations distinct from measured concentrations; never substitute zero or half the reporting limit in an average.
6. Inspect relation keys before joining. ZIP and additional-element relations can multiply occurrence rows; do not repair that multiplication with `DISTINCT`, which can discard genuine analytical replicates.

## Core chain

For a utility investigation, resolve the system, inspect its profile, and retrieve the relevant historical evidence. To trace a violation, pass its PWSID and violation ID to `sdwis_get_enforcement_actions`. Retrieve association rows separately when reconstructing action-to-violation links; an action date filter does not define the association selection.

When a treatment or violation references a facility, inspect that system's facilities section before attributing the record to a named source or treatment plant. A UCMR facility with a similar name or ID is not a verified cross-dataset match.

## Workflows

### Acquire an analytical selection

Staging is explicit: use `stage:true` on an analytical source call when DataCanvas is enabled. Inline results never spill automatically. Retain the returned `canvas_id`, then call `sdwis_dataframe_describe` for exact tables and columns before `sdwis_dataframe_query`. Pass the held capability when staging subsequent source partitions beside the first. Tables expire; MCPB supports inline EPA reads but cannot enable DataCanvas.

Follow source continuations to acquire further partitions. Inline previews can show only part of a staged table; read its other rows through SQL and query continuations. `phase:preview` has no preview cursor and does not indicate more source acquisition. Combine primary partition tables with `UNION ALL`, using the names from describe. A short preview does not measure the staged partition's size. Inspect selection coverage after acquisition and retain provenance with the result. If capacity prevents completing the selection, split the research question into narrower, separately completed cohorts rather than presenting the partial aggregate as complete.

### Join UCMR companion evidence

Combine occurrence partitions before calculating measurement statistics. ZIP membership joins by PWSID and describes service membership, not sample location. Use a membership test such as `EXISTS` when filtering occurrences by ZIP so multiple memberships do not increase the measurement count.

Additional elements join on `(pwsid, facility_id, sample_point_id, sample_event_code)` and remain one-to-many. Inspect or aggregate those elements separately before attaching them to measurement summaries. Preserve distinct occurrence rows, including replicates; source identity includes more than the companion join key.

Use one read-only SQL statement over described tables. Follow query continuations to read retained results; those continuations do not acquire missing source partitions or recover rows omitted by query truncation. Narrow the SQL when truncation is reported.
