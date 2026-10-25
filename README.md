<div align="center">
  <h1>@cyanheads/epa-drinking-water-mcp-server</h1>
  <p><b>Search EPA drinking water systems, violations, enforcement actions, and contaminant measurements via MCP. STDIO or Streamable HTTP.</b>
  <div>6 EPA Tools • 3 Optional DataCanvas Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/epa-drinking-water-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/epa-drinking-water-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/epa-drinking-water-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/epa-drinking-water-mcp-server/releases/latest/download/epa-drinking-water-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=epa-drinking-water-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZXBhLWRyaW5raW5nLXdhdGVyLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22epa-drinking-water-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fepa-drinking-water-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

EPA drinking-water records from SDWIS DMAP and the UCMR 5 publication. Resolve water systems, inspect historical violations and enforcement, and retrieve Lead and Copper Rule summaries or unregulated-contaminant occurrence measurements. Runs over stdio or Streamable HTTP without an API key.

### Tools

| Tool | Description |
|:---|:---|
| `sdwis_list_reference` | Decode identifiers, contaminant namespaces, coverage, standards, and EPA dictionaries |
| `sdwis_search_water_systems` | Find contact-free public water-system inventory |
| `sdwis_get_system_profile` | Retrieve summary, geography, service areas, or treatment |
| `sdwis_get_violations` | Page reported historical SDWA violations |
| `sdwis_search_contaminants` | Select violations, LCR summaries, or UCMR 5 occurrence |
| `sdwis_get_enforcement_actions` | Retrieve actions or violation associations |
| `sdwis_dataframe_describe` | Inspect tables and provenance inside a supplied canvas |
| `sdwis_dataframe_query` | Run read-only SQL against staged partitions |
| `sdwis_dataframe_drop` | Optionally remove one staged table |

The dataframe tools require npm or Docker with `CANVAS_PROVIDER_TYPE=duckdb`; drop also requires `SDWIS_DATAFRAME_DROP_ENABLED=true`. The Claude Desktop bundle provides the six EPA-reading tools.

## Capability reference

### `sdwis_list_reference` <sub>tool</sub>

- Required `topic`: `identifiers`, `system_types`, `sources`, `contaminants`, `violation_types`, `enforcement_types`, `treatment`, `service_areas`, `standards`, or `coverage`; optional substring `query`
- Interpretation topics are bundled; dictionaries are live. SDWIS codes and UCMR analytes remain separate namespaces; standards explain MCL, MCLG, and action levels without classifying historical records as exceedances

---

### `sdwis_search_water_systems` <sub>tool</sub>

- At least one narrowing selector: `pwsid`, `name_contains`, `state`, `county` (requires state), `population_min` / `population_max`, `source`, `system_type`, `primacy_agency`, or `pwsid_prefix`
- `activity` defaults to `active`; choose `inactive` or `all` explicitly. State means reported legal-entity state; county means county served, and neither establishes complete physical service boundaries

---

### `sdwis_get_system_profile` <sub>tool</sub>

- Required nine-character alphanumeric `pwsid`; `section` is `summary` (default), `geography`, `service_areas`, or `treatment`, independently paged
- Summary returns `system`; child sections return `items`. `found:false` reports missing inventory, not a compliance finding; operator contacts and mailing addresses are excluded

---

### `sdwis_get_violations` <sub>tool</sub>

- Require `pwsid` or `state`; optional `county`, `contaminant`, `category`, `health_based`, and `compliance_status`
- Inclusive `date_from` / `date_to` select compliance-period overlap; unknown dates do not match. Monitoring/reporting violations may lack concentrations
- `stage:true` requests a partition; `stage_max_rows` defaults to 5,000 and clamps at 25,000. Supply a held `canvas_id` to add another partition

---

### `sdwis_search_contaminants` <sub>tool</sub>

- Require `dataset` (`violations`, `lcr`, or `ucmr5`) and `pwsid` or `state`; optional county, contaminant, and inclusive dates select compliance periods, LCR sample periods, or UCMR collection dates respectively
- LCR lead/copper select PB90/CU90 summaries, not household samples. UCMR `PFAS` covers 29 analytes; lithium is separate. `zip` and `detected_only` are UCMR-only; service ZIP is not sample location, and censored values remain unknown below reporting limits
- Supports `stage`, `canvas_id`, and `stage_max_rows` (5,000 default, 25,000 maximum). Cold UCMR calls may need a 180-second client timeout; narrow broad requests to a PWSID or county when membership resolution times out

---

### `sdwis_get_enforcement_actions` <sub>tool</sub>

- Required `pwsid`; `section` is `actions` (default) or `associations`. Optional `violation_id` selects related actions through PWSID-bound association keys
- `action_type`, `originator`, and inclusive enforcement-date filters apply only to actions. Associations page separately; source action text does not imply a federal order or monetary penalty
- Supports `stage`, `canvas_id`, and `stage_max_rows` (5,000 default, 25,000 maximum)

---

### `sdwis_dataframe_describe` <sub>tool</sub>

- Required caller-held `canvas_id`; optional exact `table_name`; `limit` defaults to 10 and clamps at 100 with `cursor` pagination
- One table-column entry per item includes types, row counts, expiry, filters, provenance, completeness, and continuation. There is no global canvas listing

---

### `sdwis_dataframe_query` <sub>tool</sub>

- Required `canvas_id` and one read-only SELECT, WITH, or FROM statement in `sql` (at most 20,000 characters); describe the canvas first
- Retains at most `CANVAS_DEFAULT_ROW_LIMIT` (framework default 10,000), bounded by 25,000. `row_count`, `truncated`, and `has_more` distinguish retained rows from omitted rows; continuations read an immutable result for up to 15 minutes
- File, network, write, and system-catalog access are refused. `source_complete` conservatively includes every live source partition, including tables the SQL does not reference

---

### `sdwis_dataframe_drop` <sub>tool</sub>

- Required `canvas_id` and exact `table_name`; requires `CANVAS_PROVIDER_TYPE=duckdb` and `SDWIS_DATAFRAME_DROP_ENABLED=true`
- Idempotent: missing tables or expired canvases return `dropped:false`; other staged partitions remain available

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

EPA-specific:

- Contact-free inventory and service membership, with source codes retained when labels are unavailable
- Historical quarterly SDWIS records, LCR summaries, and limited-participation UCMR 5 monitoring kept distinct; empty results establish neither current compliance nor tap-water safety or contaminant absence
- Source dates retain calendar meaning; non-midnight source timestamps retain a `_raw` field
- Lazy process-local UCMR acquisition; statewide requests can exceed the 45-second membership budget even after archive acquisition. Narrow by PWSID/county rather than treating the server as a complete national warehouse

Agent-friendly output:

- Provenance — `effective_filters`, source URL, `retrieved_at`, publication/HTTP validators when available, and interpretation caveats
- Completeness — `source_complete:false` can remain false with `has_more:false` after earlier rows were delivered in other pages or partitions; aggregation does not restore completeness
- Whole-record paging — `limit` defaults to 10 and clamps at 100; byte limits can return fewer rows. Follow `next_cursor` with unchanged selectors, including empty `phase:membership` pages; source cursors expire after 15 minutes of inactivity
- Oversized records — `item_too_large` supplies `record_cursor`; use `view:text` and concatenate JSON chunks, then follow the records continuation. Both MCP content surfaces carry the same values

## Getting started

Add one of these configurations to your MCP client. No EPA account or API key is required.

```json
{
  "mcpServers": {
    "epa-drinking-water-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/epa-drinking-water-mcp-server@latest"]
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "epa-drinking-water-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/epa-drinking-water-mcp-server@latest"]
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "epa-drinking-water-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/epa-drinking-water-mcp-server:latest"
      ]
    }
  }
}
```

For SQL staging, set `CANVAS_PROVIDER_TYPE=duckdb` in the npm process environment (Docker: `-e CANVAS_PROVIDER_TYPE=duckdb`). Call a source tool with `stage:true`, retain `dataset.canvas_id`, then call `sdwis_dataframe_describe` before querying. Retain every source-partition continuation. The Claude Desktop bundle fixes `CANVAS_PROVIDER_TYPE=none`; staging there returns `canvas_disabled`.

For Streamable HTTP from a local checkout:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# http://localhost:3010/mcp
```

### Prerequisites

- [Bun ≥1.4.0](https://bun.sh/) or Node.js ≥24.0.0
- Network access to EPA services; allow a 180-second client timeout for cold UCMR calls

### Installation

```sh
git clone https://github.com/cyanheads/epa-drinking-water-mcp-server.git
cd epa-drinking-water-mcp-server
bun install
cp .env.example .env
bun run rebuild
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `SDWIS_DATAFRAME_DROP_ENABLED` | Enable early removal of staged tables when canvas is enabled | `false` |
| `CANVAS_PROVIDER_TYPE` | `none` or `duckdb`; npm/Docker supports DuckDB, MCPB fixes `none` | `none` |
| `CANVAS_DEFAULT_ROW_LIMIT` | SQL row ceiling, bounded by server maximum 25,000 | `10000` |
| `CANVAS_DEFAULT_MEMORY_LIMIT_MB` | Per-engine budget, at most 512 MiB | `512` |
| `MCP_TRANSPORT_TYPE` | `stdio` or `http` | `stdio` |
| `MCP_HTTP_HOST` | HTTP bind address; Docker binds `0.0.0.0` | `127.0.0.1` |
| `MCP_HTTP_PORT` | HTTP port | `3010` |
| `MCP_AUTH_MODE` | `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Minimum log level | `info` |
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |

See [`.env.example`](./.env.example) for the full overrides.

## Running the server

### Local development

```sh
bun run rebuild
bun run start:stdio
# or bun run start:http
bun run devcheck
bun run test
```

### Docker

```sh
docker build -t epa-drinking-water-mcp-server .
docker run --rm -p 3010:3010 epa-drinking-water-mcp-server
```

The image defaults to Streamable HTTP on port 3010 with stateless sessions. Add `-e CANVAS_PROVIDER_TYPE=duckdb` for SQL staging.

## Project structure

| Path | Purpose |
|:---|:---|
| `src/index.ts` | Registration, source initialization, and optional canvas |
| `src/config` | Dataframe-drop configuration |
| `src/domain` | Selectors, reference data, schemas, and dual-surface formatting |
| `src/mcp-server/tools/definitions` | Six EPA tools and three optional dataframe tools |
| `src/services/sdwis` | Validated DMAP reads, membership, paging, and joins |
| `src/services/ucmr5` | Archive acquisition, parsing, indexing, and occurrence |
| `src/services/dataframe` | Capability-scoped staging, SQL, expiry, and removal |
| `tests` | Domain, service, tool, and integration tests |
| `scripts` | Build, checks, packaging, and release tooling |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) and [`AGENTS.md`](./AGENTS.md).

- Handlers throw typed failures; the framework renders errors
- Register directly in `src/index.ts`; validate upstream data before normalization
- Preserve uncertainty, provenance, dates, and completeness; never infer compliance, household exposure, or exceedances
- Keep `content[]` and `structuredContent` equivalent; never write source results to user storage

## Contributing

Issues are welcome. Run `bun run devcheck` and `bun run test` before submitting.

## License

[Apache-2.0](./LICENSE).
