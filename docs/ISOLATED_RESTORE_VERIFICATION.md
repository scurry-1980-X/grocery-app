# Pre-Migration-003 isolated backup verification

This validates the known Grocery App objects in a trusted local Supabase backup.
It does not apply Migration 003 or 004, approve either migration, connect to
Supabase, or validate a complete Supabase disaster recovery procedure.

## Run

Prerequisites: Python 3.9+, a running local Colima Docker context, the already
installed `postgres:17` image, and the existing custom-format backup. No Python
packages or database credentials are required. The script will not pull images,
start Colima, or change Docker's current context.

From this repository root:

```sh
python3 scripts/validate_grocery_restore.py
```

The default backup is `~/Supabase-Backups/grocery-pre-migration-003-full.dump`.
For a different local copy or local Docker context:

```sh
python3 scripts/validate_grocery_restore.py \
  --backup "$HOME/Supabase-Backups/grocery-pre-migration-003-full.dump" \
  --context colima
```

No database URL, password, host, or production project argument is accepted.
Inherited `PG*`, `DOCKER_*`, and `COMPOSE_*` variables are removed from subprocess
environments. The chosen Docker context must resolve to a local Unix socket.
Do not point that socket at a proxy for a remote daemon.

Every run gets a unique `grocery-verify-*` container and private
`.restore-validation/run-*/` report directory. Existing containers, including
`grocery-restore-test`, are never reused, stopped, or removed. Existing report
files and backups are never overwritten. The script stops only its new container
after success or handled failure, preserving its volume and filesystem.

Exit status **0** means all isolated checks passed; **1** means validation failed.
Argument errors use argparse's status 2. Read `report.txt` or `report.json` at the
path printed at completion. A failure is never converted into a warning/pass.
Raw database errors are deliberately suppressed because they can contain IDs or
row contents. The report identifies the failing stage and failed invariant.
If interrupted ungracefully, inspect the generated container name in Docker;
a missing completed report is not a pass.

## What runs

1. Verify the custom archive header and calculate its SHA-256 fingerprint.
2. Resolve the locally installed image to its immutable ID. Create a fresh
   PostgreSQL 17 container using `--pull=never`, `--network none`, no published
   ports, no host bind mounts, no privileged mode, and no TCP listener. Database
   commands use `docker exec` and the container's Unix socket. Resource limits
   are 512 MiB, one CPU, and 256 processes.
3. Copy the backup into that container and compare the copy checksum. Read the
   archive's table of contents and require the exact 42-entry Grocery allowlist.
   Unknown public objects, changed owners, duplicate entries, or missing
   required objects fail closed. Never fix this by restoring the whole archive.
4. Create local `auth.users(id uuid primary key)`, a NULL-returning `auth.uid()`,
   and NOLOGIN/NOSUPERUSER/NOBYPASSRLS `anon`, `authenticated`, and `service_role`
   roles. Grant schema USAGE as explicit local scaffolding.
5. Restore pre-data and data in separate strict transactions. Seed the distinct
   non-NULL auth references directly from Grocery tables inside the container.
   No auth rows are extracted from the backup and no identifiers are printed.
6. Restore post-data in a strict transaction. Creating the foreign keys validates
   all restored references. No trigger disabling, constraint bypassing,
   `--clean`, `--create`, `--no-acl`, `--no-owner`, or ignored restore errors.
7. Verify counts, structure, permissions, function fidelity, and behavior below.
8. Recheck the source backup checksum, stop the new container, retain it for
   explicit cleanup, and write the report. No deletion command runs.

`pg_restore --table` alone omits subsidiary objects. This script instead uses a
reviewed `--use-list` across all three restore sections, retaining ACL entries.
See the [PostgreSQL 17 pg_restore documentation](https://www.postgresql.org/docs/17/app-pgrestore.html).
Archives can execute SQL code; use only a trusted backup. Isolation limits the
scope of execution and is not a substitute for trusting the archive.

## Included objects and checks

| Objects | Expected checks |
| --- | --- |
| `grocery_items` | 2 rows |
| `grocery_list_members` | 1 row |
| `grocery_list_invites` | 0 rows |
| `grocery_list_create_requests` | 0 rows |
| All four tables | Exact columns, types, nullability, identity, defaults; four primary keys and four validated auth foreign keys, including delete actions; valid indexes |
| `grocery_items_id_seq` | Ownership, increment, minimum, noncycling behavior, exact archived state, next value above existing IDs |
| Four RPC functions | Exact bodies against archive; UUID signatures, PostgreSQL owner, PL/pgSQL, SECURITY DEFINER, empty search path, volatility and execute ACLs |
| RLS | Enabled on all four tables; exact five policy names, commands, roles, USING and WITH CHECK expressions |
| Permissions | Exact table and function ACLs, including PUBLIC and grant-option checks; three `postgres` public default-privilege entries |

The functions are `create_grocery_list()`, `create_grocery_list_once(uuid)`,
`create_grocery_list_invite(uuid)`, and `redeem_grocery_list_invite(uuid)`.

Behavior checks first verify that anonymous/NULL identities cannot see Grocery
rows, each callable RPC rejects missing authentication, and `anon` lacks execute
permission on `create_grocery_list_once`. Then, in a transaction, replace only
the **local** auth stub with a simulated identity function and add three synthetic
users. Verify list creation, sequential request replay, NULL request rejection,
member read/insert/update/delete, unrelated-user read/write denial, forbidden
direct membership insertion, nonmember invitation denial, invitation redemption,
and invitation reuse rejection. Roll back the transaction and verify that
restored counts, sequence state, and the original NULL auth stub remain intact.
Explicit synthetic item IDs avoid nontransactional sequence advancement.

Counts are deliberately fixed to this known pre-Migration-003 backup. Different
data or schema requires a reviewed baseline change, not an option to ignore a
mismatch. A PASS verifies the listed structure and row counts; it is not an
independent row-by-row checksum comparison against the original live database.

## Supabase exclusions and limits

- Managed schemas (`auth`, `storage`, `realtime`, extension infrastructure,
  Supabase migration tracking, and others) are not restored. The local `auth`
  schema contains only the two stubs described above. Referenced user IDs exist
  locally solely to prove referential integrity; no emails, passwords, sessions,
  JWTs, or auth accounts are restored.
- `public.rls_auto_enable()` and its managed event trigger are excluded. Archived
  RLS flags are restored explicitly instead.
- `supabase_realtime` and its Grocery publication membership are excluded.
  Realtime delivery, replica identity requirements, and subscriptions are not
  established by this test.
- The shared `public` schema ACL and `supabase_admin` default privileges are
  excluded; they are platform configuration rather than Grocery-owned objects.
  The three `postgres` public default ACLs are restored and checked only in the
  disposable database. These affect future objects there, not production.
- `service_role` is intentionally a NOLOGIN role without BYPASSRLS; this test
  checks its object grants, not the production role's elevated behavior.
- No GoTrue, PostgREST API, JWT verification, actual login, browser, iPhone, or
  network-based integration test runs. Synthetic identities test PostgreSQL RLS
  mechanics only. Concurrent requests and race conditions need separate tests.
- The observed archive was produced by pg_dump **18.6** from PostgreSQL **17.11**
  and restored successfully with PostgreSQL **17.11** tools. Versions and image
  ID are captured in each report. That successful run does not guarantee other
  future-client archives will work with older restore tools. Any incompatibility
  is a failure requiring review, never a reason to ignore restore errors.
- Restoring existing grants is not an endorsement of their security design.
  Broad archived grants are preserved so this is a fidelity check, not an
  unrequested permissions migration.

## Privacy and retained artifacts

`.restore-validation/` is ignored by Git. Its directories are created with a
private umask. Reports contain fixed labels, counts, versions, checksums, and the
generated container name. `selected.list` contains only allowlisted object names.
Raw SQL, row data, identifiers, and database error text are not written to host
reports or terminal output. Function bodies and the selected data stream are
temporarily processed in memory for fidelity checks. PostgreSQL statement/error
logging is suppressed in the new container to avoid recording row values.

**The retained container contains the full backup copy and the restored data;
its anonymous Docker volume also contains database data.** Treat both as private
local artifacts. Stopping the container is reversible and retains that data.
The validator never removes containers, volumes, databases, or backup files.
After reviewing the report, explicitly approve cleanup of the generated
`grocery-verify-*` container(s) and their volumes before asking an agent to remove
them. Do not remove `grocery-restore-test` or the source backup as part of this
workflow. Repeated runs consume local disk until that explicit cleanup.

Do not commit `.restore-validation`, backups, private logs, auth references, or
credentials. Additional ignore rules cover `.dump`, `.backup`, `.sql.gz`, and
`.env` files; these rules do not replace reviewing staged changes.

## Tests and remaining release checks

Run safety regression tests without Docker or a backup:

```sh
python3 -m unittest discover -s tests -p 'test_restore_validation.py' -v
```

The actual backup run is the integration test. See
[the execution record](RESTORE_VERIFICATION_RESULTS.md) for the tested branch,
results, and deliberate negative test.

Before any migration decision, separately review Migration 003/004 SQL, its
rollback/recovery plan and dependencies; neither migration is present on the
development branch used for this work. Verify Supabase-managed dependencies,
Auth/API/Realtime behavior, and multi-user/concurrency scenarios in a separately
authorized disposable Supabase environment. Confirm actual iPhone behavior if
the change affects the application. These are remaining release checks, not
unfinished steps in this isolated restore. Migration approval remains an
explicit human decision regardless of this report.
