# Isolated restore verification execution record

Executed October 18, 2026 (America/Chicago) on the existing Mac/Colima setup.

Repository: `scurry-1980-X/grocery-app`. Base: `ai-managed-development` at
`a01bd5a45954848e8c7e99116400c433e0214ec2`. Implementation branch:
`codex/isolated-restore-verification`, in a separate local clone. The existing
working copy and its uncommitted changes were not modified.

## Results

| Test | Result |
| --- | --- |
| Actual pre-Migration-003 backup, initial full restore | PASS: 29 checks |
| Actual backup, final full restore with post-test sequence check | PASS: 29 checks |
| Safety regression suite | PASS: 13 tests, including multiple missing-object and unexpected-object cases |
| Deliberately incorrect expected item count (3 instead of 2) | Expected FAIL at data-count verification; validator returned status 1 |
| Source backup checksum before/after successful runs | Identical |
| Original `grocery-restore-test` container | Still running; not modified by validator |

The deliberate negative test changed `TABLES['grocery_items']` only in a separate
Python process's memory, invoked the normal validator, and asserted return code
1. The committed baseline remains 2. This did not alter the archive or the
implementation file. Its FAIL report is expected test evidence, not a failed
backup recovery.

The four restored table counts were:

| Table | Rows |
| --- | ---: |
| `grocery_items` | 2 |
| `grocery_list_members` | 1 |
| `grocery_list_invites` | 0 |
| `grocery_list_create_requests` | 0 |

Both full runs verified the four function bodies against the archive, column
definitions/defaults, primary and foreign keys, valid indexes, RLS, all five
policy definitions, table/function ACLs, PostgreSQL-owned default privileges,
sequence state, and rollback-only RLS/RPC behavior. PostgreSQL and restore tools
were version 17.11; the archive header identifies pg_dump 18.6 and source server
17.11. Each private report records the exact local image ID and backup checksum.

Reports and allowlists are under the ignored `.restore-validation/` directory.
Three new test containers were stopped and retained with their data. No
container, volume, database, or backup was removed. Cleanup requires explicit
approval and should target only those generated validation containers and their
volumes. The full backup copy inside each retained container is private data.

## Scope of the result

**The remaining isolated Grocery-object restore verification passed. Migration
approval is NO.** No Migration 003 or 004 was applied, no production database was
contacted, and no application files other than README documentation changed.

Remaining release checks are Supabase Auth/JWT/API and Realtime integration,
managed platform dependencies/privileges, concurrent RPC behavior, and review of
the actual migration and recovery plan in a separately authorized test
environment. iPhone behavior remains an application acceptance check. These
limits and rerun instructions are in the
[runbook](ISOLATED_RESTORE_VERIFICATION.md).
