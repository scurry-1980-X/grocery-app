"""Offline source/catalog checks only. No SQL engine, subprocess or network calls.

The deliberately narrow scanner accepts this fixture format, not arbitrary SQL.
Unknown statements fail closed; PostgreSQL compilation remains a separate gate.
"""
import hashlib
import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / 'tests/supabase_integration/fixtures'
CATALOG = (ROOT / 'scripts/restore_validation/catalog_checks.sql').read_text()
RECOVERED = (ROOT / 'database/recovered/002_deployed_objects.reconstructed.sql').read_text()
RAW = FIXTURES / 'sources/grocery-three-functions.sql'
FUNCTION = re.compile(r'CREATE FUNCTION public\.\w+\([^;]*?\n    AS \$\$.*?\n\$\$;', re.S)
TABLE_PRIVS = set('SELECT INSERT UPDATE DELETE TRUNCATE REFERENCES TRIGGER MAINTAIN'.split())
SEQUENCE_PRIVS = set('SELECT UPDATE USAGE'.split())
ROLES = {'PUBLIC', 'postgres', 'anon', 'authenticated', 'service_role'}
TABLES = {'grocery_items', 'grocery_list_members', 'grocery_list_invites', 'grocery_list_create_requests'}
SIGNATURES = {'create_grocery_list()', 'create_grocery_list_invite(uuid)',
              'redeem_grocery_list_invite(uuid)', 'create_grocery_list_once(uuid)'}


def compact(text):
    return re.sub(r'\s+', ' ', text).strip()


def statements(text):
    # Dollar bodies, string literals, identifiers, comments, and semicolon delimiters.
    token = re.compile(r'\$\$.*?\$\$|\'(?:\'\'|[^\'])*\'|"(?:""|[^"])*"|--[^\n]*|[^\'"$;-]+|[-;]', re.S)
    parts, current, position = [], [], 0
    for match in token.finditer(text):
        if match.start() != position:
            raise ValueError('Unrecognized SQL token')
        position = match.end()
        value = match[0]
        if value.startswith('--'):
            current.append('\n')
        elif value == ';':
            if ''.join(current).strip():
                parts.append(''.join(current).strip())
            current = []
        else:
            current.append(value)
    if position != len(text) or ''.join(current).strip():
        raise ValueError('Unterminated or unrecognized SQL')
    return parts


def signature(text):
    return re.sub(r'\(\w+ uuid\)', '(uuid)', text)


def require_supported(sql):
    allowed = [
        r'BEGIN', r'COMMIT', r'SET LOCAL ROLE postgres', r"SET LOCAL search_path = ''",
        r'SET LOCAL check_function_bodies = true', r"SET LOCAL default_tablespace = ''",
        r'SET LOCAL default_table_access_method = heap',
        r'CREATE TABLE public\.grocery_\w+ \(.+\)',
        r'ALTER TABLE public\.grocery_\w+ OWNER TO postgres',
        r'ALTER TABLE ONLY public\.grocery_\w+ ADD CONSTRAINT grocery_\w+ (?:PRIMARY KEY|FOREIGN KEY) .+',
        r'ALTER TABLE public\.grocery_\w+ ENABLE ROW LEVEL SECURITY',
        r'CREATE POLICY "[^"]+" ON public\.grocery_\w+ AS PERMISSIVE FOR (?:INSERT|SELECT|UPDATE|DELETE) TO authenticated .+',
        r'ALTER FUNCTION public\.\w+\([^)]*\) OWNER TO postgres',
        r'(?:REVOKE ALL|GRANT [A-Z, ]+) ON (?:TABLE|FUNCTION|SEQUENCE) public\.[\w(), ]+ (?:FROM|TO) [\w, ]+',
        r'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public (?:REVOKE ALL|GRANT [A-Z, ]+) ON (?:TABLES|FUNCTIONS|SEQUENCES) (?:FROM|TO) [\w, ]+',
    ]
    for stmt in statements(sql):
        if FUNCTION.fullmatch(stmt + ';'):
            continue
        if not any(re.fullmatch(pattern, compact(stmt)) for pattern in allowed):
            raise ValueError('Unexpected fixture statement: ' + compact(stmt)[:100])


def acl_state(sql, defaults=False):
    prefix = r'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public ' if defaults else ''
    obj = r'(TABLES|FUNCTIONS|SEQUENCES)' if defaults else r'(TABLE|FUNCTION|SEQUENCE) public\.([\w(), ]+?)'
    pattern = re.compile(prefix + r'(GRANT|REVOKE) (.+?) ON ' + obj + r' (TO|FROM) ([\w, ]+)')
    state = {}
    for stmt in statements(sql):
        match = pattern.fullmatch(compact(stmt))
        if not match:
            continue
        if defaults:
            verb, privileges, kind, direction, roles = match.groups()
            key = kind
        else:
            verb, privileges, kind, name, direction, roles = match.groups()
            key = (kind, signature(name))
        all_privs = TABLE_PRIVS if kind.startswith('TABLE') else SEQUENCE_PRIVS if kind.startswith('SEQUENCE') else {'EXECUTE'}
        if key not in state:
            # Deliberately begin with overly broad platform defaults for every known role.
            state[key] = {role: set(all_privs) for role in ROLES}
        rights = all_privs if privileges == 'ALL' else set(privileges.split(', '))
        if not rights <= all_privs or direction != ('TO' if verb == 'GRANT' else 'FROM'):
            raise ValueError('Invalid privileges or direction')
        for role in roles.split(', '):
            if role not in ROLES:
                raise ValueError('Unexpected grantee')
            if verb == 'GRANT':
                state[key][role] |= rights
            else:
                state[key][role] -= rights
    return {key: {role: rights for role, rights in roles.items() if rights} for key, roles in state.items()}


class HistoricalBaselineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.one = (FIXTURES / '001_grocery_prerequisites.sql').read_text()
        cls.two = (FIXTURES / '002_create_once.sql').read_text()
        cls.sql = cls.one + cls.two
        cls.manifest = json.loads((FIXTURES / 'provenance.json').read_text())

    def test_provenance_hashes_and_complete_fixture_inventory(self):
        manifest = self.manifest
        self.assertEqual(manifest['base_commit'], 'e92e307f0db65dbd6d74b3eb2f74e96f2ea0f5a5')
        actual = {str(path.relative_to(ROOT)) for path in FIXTURES.rglob('*') if path.is_file()}
        pinned = {entry['path'] for entry in manifest['files']}
        self.assertEqual(actual - {'tests/supabase_integration/fixtures/provenance.json'},
                         {path for path in pinned if path.startswith('tests/supabase_integration/fixtures/')})
        for entry in manifest['files']:
            with self.subTest(path=entry['path']):
                self.assertEqual(hashlib.sha256((ROOT / entry['path']).read_bytes()).hexdigest(), entry['sha256'])
        previous = json.loads((ROOT / 'database/recovered/provenance.json').read_text())
        self.assertEqual(manifest['archive']['sha256'], previous['artifacts'][0]['source']['backup_sha256'])
        self.assertEqual(manifest['attachment']['sha256'], '2fb39626f2928fd3a77084e8c00da01247d06e3126d160c202a29a2fa01c697d')
        self.assertFalse(manifest['verification']['archive_independently_reopened'])
        self.assertFalse(manifest['verification']['sql_executed'])
        self.assertEqual(manifest['attachment']['function_entry_ids_user_attested'], [484, 485, 486])

    def test_raw_attachment_integrity_and_line_ending_preservation(self):
        raw = RAW.read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), self.manifest['attachment']['sha256'])
        self.assertEqual(raw.count(b'\r\n'), 28)
        self.assertIn('-text', (RAW.parent / '.gitattributes').read_text())
        for name in ('001_grocery_prerequisites.sql', '002_create_once.sql'):
            self.assertNotIn(b'\r', (FIXTURES / name).read_bytes())

    def test_exact_function_definitions_owners_and_metadata(self):
        self.assertEqual(FUNCTION.findall(self.one), FUNCTION.findall(RAW.read_text()))
        self.assertEqual(FUNCTION.findall(self.two), FUNCTION.findall(RECOVERED))
        owners = r'ALTER FUNCTION public\.[^;]+;'
        self.assertEqual(re.findall(owners, self.one), re.findall(owners, RAW.read_text()))
        self.assertEqual(re.findall(owners, self.two), re.findall(owners, RECOVERED))
        names = set()
        for function in FUNCTION.findall(self.sql):
            header = function.split('    AS $$')[0]
            self.assertRegex(header, r"RETURNS uuid\s+LANGUAGE plpgsql SECURITY DEFINER\s+SET search_path TO ''")
            names.add(signature(re.search(r'public\.(\w+\([^)]*\))', header)[1]))
        self.assertEqual(names, SIGNATURES)

    def test_exact_recovered_002_table_constraints_and_rls(self):
        for pattern in (r'CREATE TABLE public.grocery_list_create_requests \([\s\S]*?\n\);',
                        r'ALTER TABLE ONLY public.grocery_list_create_requests\s+ADD CONSTRAINT [^;]+;',
                        r'ALTER TABLE public.grocery_list_create_requests (?:OWNER TO postgres|ENABLE ROW LEVEL SECURITY);'):
            self.assertEqual(re.findall(pattern, self.two), re.findall(pattern, RECOVERED))

    def test_tables_columns_nullability_identity_and_defaults_match_catalog(self):
        expected_rows = re.findall(r"\('([a-z_]+)','([a-z_]+)','([a-z ]+)',(true|false),'([a-z]?)'\)", CATALOG)
        expected = {(t, c): (typ, nn == 'true', ident) for t, c, typ, nn, ident in expected_rows}
        actual, defaults = {}, {}
        for table, body in re.findall(r'CREATE TABLE public\.(\w+) \((.*?)\n\);', self.sql, re.S):
            body = re.sub(r'GENERATED BY DEFAULT AS IDENTITY \(.*?\)', 'IDENTITY', body, flags=re.S)
            for line in body.strip().splitlines():
                line = line.strip().rstrip(',')
                m = re.fullmatch(r'(\w+) (timestamp with time zone|bigint|uuid|text|boolean)(.*)', line)
                self.assertIsNotNone(m, line)
                column, typ, suffix = m.groups()
                actual[table, column] = (typ, 'NOT NULL' in suffix, 'd' if 'IDENTITY' in suffix else '')
                suffix = suffix.replace('NOT NULL', '').replace('IDENTITY', '').strip()
                if suffix:
                    self.assertTrue(suffix.startswith('DEFAULT '), suffix)
                    defaults[table, column] = suffix.removeprefix('DEFAULT ')
        self.assertEqual(actual, expected)
        catalog_defaults = CATALOG.split('WITH expected(t,c,d) AS (VALUES', 1)[1].split('), actual AS', 1)[0]
        pairs = re.findall(r"\('([^']+)','([^']+)','((?:''|[^'])*)'\)", catalog_defaults)
        expected_defaults = {(t, c): value.replace("''", "'") for t, c, value in pairs}
        self.assertIn("chr(39)||'1'||chr(39)||'::bigint'", catalog_defaults)
        expected_defaults['grocery_items', 'quantity'] = "'1'::bigint"
        self.assertEqual(defaults, expected_defaults)

    def test_constraints_match_catalog_and_no_additional_constraints(self):
        section = CATALOG.split('WITH expected(t,n,d) AS (VALUES', 1)[1].split('), actual AS', 1)[0]
        expected = set(re.findall(r"\('([^']+)','([^']+)','([^']+)'\)", section))
        actual = {(t, n, compact(d)) for t, n, d in re.findall(
            r'ALTER TABLE ONLY public\.(\w+)\s+ADD CONSTRAINT (\w+) ([^;]+);', self.sql)}
        self.assertEqual(actual, expected)
        self.assertEqual(len(actual), 8)

    def test_rls_policy_names_commands_roles_and_expressions(self):
        self.assertEqual(set(re.findall(r'ALTER TABLE public\.(\w+) ENABLE ROW LEVEL SECURITY;', self.sql)), TABLES)
        member = 'EXISTS ( SELECT 1 FROM grocery_list_members WHERE ((grocery_list_members.list_id = grocery_items.list_id) AND (grocery_list_members.user_id = auth.uid())))'
        self.assertIn(member, CATALOG)
        expected = {
            ('grocery_items', 'Members can add grocery items'): ('INSERT', None, member),
            ('grocery_items', 'Members can delete grocery items'): ('DELETE', member, None),
            ('grocery_items', 'Members can read grocery items'): ('SELECT', member, None),
            ('grocery_items', 'Members can update grocery items'): ('UPDATE', member, member),
            ('grocery_list_members', 'Users can view their own list memberships'): ('SELECT', 'user_id = auth.uid()', None),
        }
        norm = lambda s: re.sub(r'[\s()]', '', s.replace('public.', '')) if s else None
        actual = {}
        for stmt in statements(self.sql):
            if not stmt.startswith('CREATE POLICY'):
                continue
            m = re.fullmatch(r'CREATE POLICY "([^"]+)" ON public\.(\w+) AS PERMISSIVE FOR (\w+) TO authenticated (.+)', compact(stmt))
            self.assertIsNotNone(m)
            name, table, command, rest = m.groups()
            using, check = None, None
            if 'WITH CHECK ' in rest:
                rest, check = rest.split('WITH CHECK ', 1)
            if rest.strip():
                self.assertTrue(rest.startswith('USING '))
                using = rest.removeprefix('USING ').strip()
            self.assertNotIn((table, name), actual)
            actual[table, name] = (command, norm(using), norm(check))
            self.assertIn("'" + name + "'", CATALOG)
        self.assertEqual(actual, {key: (cmd, norm(q), norm(w)) for key, (cmd, q, w) in expected.items()})

    def test_exact_object_acls_even_with_broad_known_role_defaults(self):
        expected = {}
        for table in TABLES:
            rights = {'postgres': TABLE_PRIVS}
            if table in ('grocery_items', 'grocery_list_members'):
                rights.update(anon=TABLE_PRIVS - {'TRUNCATE'}, authenticated=TABLE_PRIVS - {'TRUNCATE'}, service_role=TABLE_PRIVS)
            else:
                rights['service_role'] = {'REFERENCES', 'TRIGGER', 'TRUNCATE', 'MAINTAIN'}
                if table == 'grocery_list_invites':
                    rights.update(anon={'REFERENCES', 'TRIGGER', 'MAINTAIN'}, authenticated={'REFERENCES', 'TRIGGER', 'MAINTAIN'})
            expected['TABLE', table] = rights
        expected['SEQUENCE', 'grocery_items_id_seq'] = {'postgres': SEQUENCE_PRIVS}
        for sig in SIGNATURES:
            roles = {'postgres', 'authenticated'} if sig.startswith('create_grocery_list_once(') else ROLES - {'PUBLIC'}
            expected['FUNCTION', sig] = {role: {'EXECUTE'} for role in roles}
        self.assertEqual(acl_state(self.sql), expected)
        # The committed catalog's explicit sets are also hash-pinned as provenance.
        self.assertIn("ARRAY['REFERENCES','TRIGGER','TRUNCATE','MAINTAIN']", CATALOG)
        self.assertIn("('create_grocery_list_once','postgres'),('create_grocery_list_once','authenticated')", CATALOG)

    def test_per_schema_default_acls(self):
        expected = {
            'TABLES': {'postgres': TABLE_PRIVS, **{r: {'REFERENCES', 'TRIGGER', 'TRUNCATE', 'MAINTAIN'} for r in ('anon', 'authenticated', 'service_role')}},
            'SEQUENCES': {'postgres': SEQUENCE_PRIVS},
            'FUNCTIONS': {'postgres': {'EXECUTE'}},
        }
        self.assertEqual(acl_state(self.sql, defaults=True), expected)
        self.assertNotIn('ALTER DEFAULT PRIVILEGES', self.two)

    def test_ownership_identity_and_installation_order(self):
        owners = re.findall(r'ALTER TABLE public\.(\w+) OWNER TO postgres;', self.sql)
        self.assertEqual(set(owners), TABLES)
        self.assertEqual(len(owners), 4)
        self.assertIn('SEQUENCE NAME public.grocery_items_id_seq INCREMENT BY 1 MINVALUE 1 NO CYCLE', self.one)
        for sql in (self.one, self.two):
            stmts = statements(sql)
            self.assertEqual(stmts[0], 'BEGIN')
            self.assertEqual(stmts[-1], 'COMMIT')
            self.assertEqual(stmts.count('BEGIN'), 1)
            self.assertEqual(stmts.count('COMMIT'), 1)
            self.assertLess(sql.rindex('CREATE TABLE'), sql.index('CREATE FUNCTION'))
            self.assertIn('SET LOCAL ROLE postgres', stmts)
            self.assertIn('SET LOCAL check_function_bodies = true', stmts)
        self.assertNotIn('create_grocery_list_once', self.one)

    def test_supported_sql_only_and_no_platform_or_migration003_objects(self):
        require_supported(self.sql)
        outside_functions = '\n'.join(stmt for stmt in statements(self.sql)
                                      if not FUNCTION.fullmatch(stmt + ';'))
        self.assertNotRegex(outside_functions, r'(?im)^\s*(?:INSERT|UPDATE|DELETE|COPY|SELECT|DO|CREATE (?:ROLE|SCHEMA|TRIGGER|PUBLICATION)|ALTER (?:ROLE|PUBLICATION))\b')
        for forbidden in ('grocery_lists', 'grocery_mutation_requests', 'revision', 'mutate_grocery_once', 'CREATE OR REPLACE', 'IF NOT EXISTS', 'GRANT USAGE', 'FORCE ROW', 'WITH GRANT OPTION', '\\restrict', 'row_security = off'):
            self.assertNotIn(forbidden, outside_functions)
        self.assertEqual(len(re.findall('CREATE TABLE ', self.sql)), 4)

    def test_negative_extra_sql_and_unsupported_tokens_rejected(self):
        for extra in ('SELECT 1;', 'CREATE ROLE stranger;', 'ALTER TABLE public.grocery_items FORCE ROW LEVEL SECURITY;', '\\connect production\n', 'DO $$ BEGIN NULL; END $$;', '/* hidden */ SELECT 1;', 'COMMIT'):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                require_supported(self.sql + '\n' + extra)

    def test_negative_function_and_acl_drift_detectable(self):
        changed = self.one.replace("'Authentication required'", "'Changed authentication'", 1)
        self.assertNotEqual(FUNCTION.findall(changed), FUNCTION.findall(RAW.read_text()))
        extra_grant = '\nGRANT SELECT ON TABLE public.grocery_list_create_requests TO authenticated;\n'
        self.assertNotEqual(acl_state(self.sql), acl_state(self.sql + extra_grant))
        removed_revoke = self.two.replace('REVOKE ALL ON TABLE public.grocery_list_create_requests FROM PUBLIC, anon, authenticated, service_role;', '')
        self.assertNotEqual(acl_state(self.sql), acl_state(self.one + removed_revoke))
        self.assertNotEqual(hashlib.sha256(changed.encode()).hexdigest(), hashlib.sha256(self.one.encode()).hexdigest())


if __name__ == '__main__':
    unittest.main()
