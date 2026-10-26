<div align="center">
  <h1>@cyanheads/epa-drinking-water-mcp-server</h1>
  <p><b>Search EPA drinking water systems, violations, enforcement actions, and contaminant measurements via MCP. STDIO or Streamable HTTP.</b>
  <div>9 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/epa-drinking-water-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/epa-drinking-water-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/epa-drinking-water-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

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
- Inclusive `date_from` / `date_to` select compliance-period overlap; a known endpoint can prove overlap despite a missing endpoint. Indeterminate periods are excluded with a count of affected rows examined during the call. Monitoring/reporting violations may lack concentrations
- `contaminant:lead` selects `1030` and Lead and Copper Rule code `5000`, including copper and monitoring records; either exact code selects only itself
- `stage:true` requests a partition; `stage_max_rows` defaults to 5,000 and clamps at 25,000. Supply a held `canvas_id` to add another partition

---

### `sdwis_search_contaminants` <sub>tool</sub>

- Require `dataset` (`violations`, `lcr`, or `ucmr5`) and `pwsid` or `state`; optional county, contaminant, and inclusive dates select compliance periods, LCR sample periods, or UCMR collection dates respectively
- LCR lead/copper select PB90/CU90 summaries, not household samples. UCMR `PFAS` covers 29 analytes; lithium is separate. `zip` and `detected_only` are UCMR-only; service ZIP is not sample location, and censored values remain unknown below reporting limits
- Supports `stage`, `canvas_id`, and `stage_max_rows` (5,000 default, 25,000 maximum). Cold UCMR calls may need a 180-second client timeout; broad `state`/`county` scopes resolve reported-state membership through resumable pages before returning occurrence rows

---

### `sdwis_get_enforcement_actions` <sub>tool</sub>

- Required `pwsid`; `section` is `actions` (default) or `associations`. Optional `violation_id` selects related actions through PWSID-bound association keys
- `action_type`, `originator`, and inclusive enforcement-date filters apply only to actions. Associations page separately; source action text does not imply a federal order or monetary penalty
- Supports `stage`, `canvas_id`, and `stage_max_rows` (5,000 default, 25,000 maximum)

---

### `sdwis_dataframe_describe` <sub>tool</sub>

- Required caller-held `canvas_id`; optional exact `table_name`; `limit` defaults to 10 and clamps at 100 with `cursor` pagination
- One whole table per item includes its `columns` array, row count, expiry, filters, provenance, completeness, and continuation; counts and limits are in tables. There is no global canvas listing
- Oversized table metadata returns `record_cursor` for lossless `view:text` chunks. Describe continuations expire after 15 minutes or table expiry, and reject changed metadata
- `selection_coverage` reports which source partitions and required companion relations remain staged, separately from SQL results

---

### `sdwis_dataframe_query` <sub>tool</sub>

- Required `canvas_id` and one read-only SELECT, WITH, or FROM statement in `sql` (at most 20,000 characters); describe the canvas first
- Retains at most `CANVAS_DEFAULT_ROW_LIMIT` (framework default 10,000), bounded by 25,000. `row_count`, `truncated`, and `has_more` distinguish retained rows from omitted rows; continuations read an immutable result for up to 15 minutes
- File, network, write, and system-catalog access are refused. `source_complete` conservatively includes every live source partition, including tables the SQL does not reference
- `selection_coverage.chain_complete` confirms the canvas holds a complete source retrieval chain; it does not establish which tables the SQL uses or override `truncated`. Query continuations retain the original coverage snapshot

---

### `sdwis_dataframe_drop` <sub>tool</sub>

- Required `canvas_id` and exact `table_name`; requires `CANVAS_PROVIDER_TYPE=duckdb` and `SDWIS_DATAFRAME_DROP_ENABLED=true`
- Idempotent: missing tables or expired canvases return `dropped:false`; other staged partitions remain available

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

EPA-specific:

- Keyless SDWIS reads over EPA DMAP, paced at one request per second, with every returned row rechecked against the requested predicates
- Contact-free inventory and service membership; source codes kept alongside EPA dictionary labels, which stay null when EPA has none
- Quarterly SDWIS records, LCR summaries, and limited-participation UCMR 5 monitoring kept distinct; empty results establish neither current compliance, tap-water safety, nor contaminant absence
- UCMR 5 archive downloaded and indexed once per published revision on first use; censored results keep a null value with the reporting limit

Agent-friendly output:

- Provenance — `effective_filters`, source URL, `retrieved_at`, publication/HTTP validators when available, and interpretation caveats; source dates keep their calendar day, with non-midnight timestamps in a `_raw` field
- Completeness — `source_complete:false` can stay false with `has_more:false` once earlier rows went to other pages or partitions; aggregation does not restore it
- Source coverage — `selection_partition` identifies a retrieval and its delivered partition; canvas `selection_coverage` distinguishes a fully staged chain from missing, dropped, or expired partitions and companions
- Whole-record paging — `limit` defaults to 10 and clamps at 100; the ~23 KB response budget can return fewer rows. Follow `next_cursor` with unchanged selectors, including empty `phase:membership` pages; cursors expire after 15 idle minutes
- Oversized records — `item_too_large` supplies `record_cursor` for `view:text` JSON chunks. `content[]` and `structuredContent` carry the same values

## Getting started

No EPA account or API key is required. Add the server to Claude Code:

```sh
claude mcp add epa-drinking-water-mcp-server -- npx -y @cyanheads/epa-drinking-water-mcp-server
```

For other MCP clients, add this stdio configuration:

```json
{
  "mcpServers": {
    "epa-drinking-water-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/epa-drinking-water-mcp-server"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio"
      }
    }
  }
}
```

For SQL staging, add `"CANVAS_PROVIDER_TYPE": "duckdb"` to `env` (Docker: `-e CANVAS_PROVIDER_TYPE=duckdb`), call a source tool with `stage:true`, and pass the returned `dataset.canvas_id` to `sdwis_dataframe_describe` and `sdwis_dataframe_query`. The Claude Desktop bundle fixes `CANVAS_PROVIDER_TYPE=none`; staging there returns `canvas_disabled`.

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- Network access to `data.epa.gov` and `www.epa.gov`; allow a 180-second client timeout for the first UCMR call, which downloads and indexes the archive.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/epa-drinking-water-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd epa-drinking-water-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment (optional):**

```sh
cp .env.example .env
# set CANVAS_PROVIDER_TYPE=duckdb to enable SQL staging
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

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging; source results never go to `ctx.state` or user storage
- Register new tools in the `createApp()` array in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields, and never infer compliance, household exposure, or exceedances

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
