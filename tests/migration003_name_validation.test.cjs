const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const historical = fs.readFileSync(path.join(root,
  'database/recovered/003_replay_safe_mutations.recovered.sql'), 'utf8');
const proposal = fs.readFileSync(path.join(root,
  'database/proposals/003_replay_safe_mutations.name_validation_v2.sql'), 'utf8');

// Independent ECMAScript trim set. Compare it with the literal in the proposal.
const trimCodes = [9, 10, 11, 12, 13, 32, 160, 5760,
  8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202,
  8232, 8233, 8239, 8287, 12288, 65279];
const cases = [
  ['ordinary', 'Milk', true], ['numeric name', '123', true],
  ['punctuation', "O'Brien's milk", true], ['non-Latin', '牛乳', true],
  ['SQL-looking text is data', "milk'; SELECT 1; --", true],
  ['empty', '', false], ['ordinary spaces', '   ', false],
  ['tab only', '\t', false], ['line breaks', '\r\n', false],
  ['mixed whitespace', '\t \u00a0\ufeff\n', false],
  ['padded valid name', ' \tMilk\u00a0 ', true],
  ['internal newline', 'Milk\nBread', true],
  ['ASCII 150', 'a'.repeat(150), true], ['ASCII 151', 'a'.repeat(151), false],
  ['padded raw 150', 'a' + ' '.repeat(149), true],
  ['padded raw 151', 'a' + ' '.repeat(150), false],
  ['BMP 150', 'é'.repeat(150), true], ['BMP 151', 'é'.repeat(151), false],
  ['75 supplementary characters', '🍎'.repeat(75), true],
  ['76 supplementary characters', '🍎'.repeat(76), false],
  ['mixed UTF16 150', 'a'.repeat(148) + '🍎', true],
  ['mixed UTF16 151', 'a'.repeat(149) + '🍎', false],
  ['combining UTF16 150', 'e\u0301'.repeat(75), true],
  ['combining UTF16 151', 'e\u0301'.repeat(75) + 'a', false],
  // JS trim does not remove these; do not silently widen the product rule.
  ['zero-width space', '\u200b', true], ['NEL', '\u0085', true],
  ['Mongolian vowel separator', '\u180e', true],
  ['JSON null', null, false], ['number', 123, false],
  ['boolean', true, false], ['array', ['Milk'], false],
  ['object', { name: 'Milk' }, false], ['missing', undefined, false],
  ...trimCodes.map(code => [`trim U+${code.toString(16)}`, String.fromCodePoint(code), false]),
  ...trimCodes.map(code => [`wrapped U+${code.toString(16)}`,
    String.fromCodePoint(code) + 'Milk' + String.fromCodePoint(code), true]),
];

// Name predicate from the recorded shared.js normalize() and receipt validator.
// Source: cloud turn 01a14edd-695a-72bb-bf7d-dabd9d1cc60e,
// command exec-62204db3-d398-4453-b8b4-e2d61a9fd9e8. This is a contract fixture,
// NOT a claim that shared.js exists in this checkout or is deployed.
function recordedClientAccepts(name) {
  return typeof name === 'string' && !!name.trim() && name.length <= 150;
}

// Offline semantic model, not a PostgreSQL interpreter. The literal whitespace
// set is read from the proposed SQL; live RPC tests are generated below.
function proposedRuleModel(name) {
  if (typeof name !== 'string') return false;
  const literal = proposal.match(/U&'((?:\\[0-9A-F]{4})+)'/)[1];
  const spaces = new Set([...literal.matchAll(/\\([0-9A-F]{4})/g)]
    .map(match => String.fromCodePoint(parseInt(match[1], 16))));
  const chars = Array.from(name);
  return chars.length <= 150 && chars.some(c => !spaces.has(c)) &&
    chars.reduce((sum, c) => sum + (c.codePointAt(0) > 65535 ? 2 : 1), 0) <= 150;
}

function historicalRuleModel(name) {
  if (typeof name !== 'string') return false;
  const count = Array.from(name.replace(/^ +| +$/g, '')).length;
  return count >= 1 && count <= 150;
}

// Emit only. Never launches psql, Docker, a database driver, or a migration.
// The caller must separately authorize an isolated installation before using it.
function buildSql() {
  const rows = cases.map(([label, name, accepted]) => ({
    label, name, missing: name === undefined, accepted,
  }));
  const sqlLiteral = text => "'" + text.replaceAll("'", "''") + "'";
  return `-- GENERATED name-validation RPC regression suite. NOT RUN by Node tests.
-- Requires an already approved/applied v2 proposal in a disposable UTF8 DB.
-- Requires baseline 002, real claim-aware auth.uid(), and postgres setup access.
-- The restore validator's NULL auth.uid() stub is insufficient: preflight fails.
-- Use a network-disabled local test container; never production or a backup DB.
\\set ON_ERROR_STOP on
\\if :{?isolated_migration003_test}
\\else
  \\echo 'Refusing: explicit isolated_migration003_test flag required'
  \\quit 3
\\endif
\\if :isolated_migration003_test
\\else
  \\quit 3
\\endif
BEGIN;
SET LOCAL standard_conforming_strings = on;
SET LOCAL search_path = '';
DO $guard$
BEGIN
  IF pg_catalog.left(pg_catalog.current_database(), 13) <> 'grocery_m003_'
     OR current_user <> 'postgres'
     OR pg_catalog.current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'Requires postgres in disposable grocery_m003_* UTF8 database';
  END IF;
END;
$guard$;
CREATE TEMP TABLE name_cases AS
  SELECT c.*, pg_catalog.gen_random_uuid() AS request_id
  FROM pg_catalog.jsonb_to_recordset(${sqlLiteral(JSON.stringify(rows))}::jsonb)
    AS c(label text, name jsonb, missing boolean, accepted boolean);
CREATE TEMP TABLE name_fixture AS SELECT
  pg_catalog.gen_random_uuid() AS user_id, pg_catalog.gen_random_uuid() AS list_id,
  (-9007199254740991)::bigint AS item_id;
-- Explicit negative ID avoids nontransactional sequence changes; collisions fail.
INSERT INTO auth.users(id) SELECT user_id FROM pg_temp.name_fixture;
INSERT INTO public.grocery_list_members(user_id, list_id)
  SELECT user_id, list_id FROM pg_temp.name_fixture;
INSERT INTO public.grocery_items(id, owner_id, list_id, item_name, quantity, purchased)
  SELECT item_id, user_id, list_id, 'Seed', 1, false FROM pg_temp.name_fixture;
SELECT pg_catalog.set_config('request.jwt.claim.sub', user_id::text, true),
  pg_catalog.set_config('request.jwt.claims',
    pg_catalog.jsonb_build_object('sub', user_id, 'role', 'authenticated')::text, true)
  FROM pg_temp.name_fixture;
GRANT SELECT ON pg_temp.name_cases, pg_temp.name_fixture TO authenticated;
SET LOCAL ROLE authenticated;
DO $tests$
DECLARE
  f record;
  c record;
  p jsonb;
  response jsonb;
  replay jsonb;
  before_row record;
  after_row record;
  rejected boolean;
BEGIN
  SELECT * INTO STRICT f FROM pg_temp.name_fixture;
  IF auth.uid() IS DISTINCT FROM f.user_id THEN
    RAISE EXCEPTION 'Claim-aware auth.uid() prerequisite failed';
  END IF;
  FOR c IN SELECT * FROM pg_temp.name_cases ORDER BY label LOOP
    SELECT item_name, revision INTO STRICT before_row FROM public.grocery_items
      WHERE id = f.item_id;
    p := pg_catalog.jsonb_build_object('id', f.item_id::text,
      'revision', before_row.revision, 'quantity', 1, 'purchased', false);
    IF NOT c.missing THEN
      p := p || pg_catalog.jsonb_build_object('item_name', c.name);
    END IF;
    rejected := false;
    BEGIN
      response := public.mutate_grocery_once(c.request_id, f.list_id, 'edit', p);
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM <> 'Invalid item values' THEN RAISE; END IF;
      rejected := true;
    END;
    IF rejected = c.accepted THEN
      RAISE EXCEPTION 'Acceptance mismatch: %', c.label;
    END IF;
    SELECT item_name, revision INTO STRICT after_row FROM public.grocery_items
      WHERE id = f.item_id;
    IF c.accepted THEN
      IF response->>'status' IS DISTINCT FROM 'ok'
         OR after_row.item_name IS DISTINCT FROM (c.name #>> '{}')
         OR after_row.revision IS NOT DISTINCT FROM before_row.revision THEN
        RAISE EXCEPTION 'Stored value/revision mismatch: %', c.label;
      END IF;
      replay := public.mutate_grocery_once(c.request_id, f.list_id, 'edit', p);
      IF replay IS DISTINCT FROM response OR after_row.revision IS DISTINCT FROM
         (SELECT revision FROM public.grocery_items WHERE id = f.item_id) THEN
        RAISE EXCEPTION 'Replay changed effect or result: %', c.label;
      END IF;
    ELSIF after_row IS DISTINCT FROM before_row THEN
      RAISE EXCEPTION 'Rejected edit changed row: %', c.label;
    END IF;
  END LOOP;
END;
$tests$;
RESET ROLE;
DO $ledger$
BEGIN
  IF EXISTS (SELECT FROM pg_temp.name_cases AS c
    LEFT JOIN public.grocery_mutation_requests AS r
      ON r.user_id = (SELECT user_id FROM pg_temp.name_fixture)
      AND r.request_id = c.request_id
    WHERE (c.accepted AND (r.result IS NULL OR r.result->>'status' <> 'ok'))
       OR (NOT c.accepted AND r.request_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'Ledger acceptance/rollback mismatch';
  END IF;
  RAISE NOTICE 'PASS: ${cases.length} name cases, raw storage, revisions, replay and ledger rollback';
END;
$ledger$;
ROLLBACK;
`;
}

if (process.argv.includes('--emit-sql')) {
  process.stdout.write(buildSql());
} else {
  test('historical recovered SQL retains its recorded SHA-256', () => {
    assert.equal(crypto.createHash('sha256').update(historical).digest('hex'),
      'a527c250905838d166b203b608a914f39345a5c93c1e9744868dc08b09aea531');
  });

  test('proposal preserves all historical mutation behavior outside name validation', () => {
    const mutationTail = text => text.slice(text.indexOf('      UPDATE public.grocery_items'));
    assert.equal(mutationTail(proposal), mutationTail(historical));
    const mutationPrefix = text => text.slice(text.indexOf('ALTER TABLE public.grocery_items'),
      text.indexOf("      IF pg_catalog.jsonb_typeof(payload->'item_name')"))
      .replace('  item_name_text text;\n  item_name_units bigint;\n', '')
      .replace(/      -- Match the recorded shared loader:[\s\S]*$/, '');
    assert.equal(mutationPrefix(proposal), mutationPrefix(historical));
    assert.match(proposal, /current_setting\('server_encoding'\) <> 'UTF8'/);
    assert.match(proposal, /length\(item_name_text\) > 150/);
    assert.match(proposal, /CASE WHEN pg_catalog\.ascii\(ch\.c\) > 65535 THEN 2 ELSE 1 END/);
    assert.match(proposal, /item_name_units NOT BETWEEN 1 AND 150/);
    assert.match(proposal, /regexp_split_to_table\(item_name_text, ''\)/);
    assert.doesNotMatch(proposal, /length\(pg_catalog\.btrim/);
    const otherValueChecks = text => text.slice(text.indexOf("         OR (payload->>'quantity')"),
      text.indexOf('      UPDATE public.grocery_items'));
    assert.equal(otherValueChecks(proposal), otherValueChecks(historical));
  });

  test('proposal trim set exactly matches the ECMAScript whitespace contract', () => {
    const literal = proposal.match(/U&'((?:\\[0-9A-F]{4})+)'/)[1];
    assert.deepEqual([...literal.matchAll(/\\([0-9A-F]{4})/g)]
      .map(m => parseInt(m[1], 16)), trimCodes);
    for (const code of trimCodes) assert.equal(String.fromCodePoint(code).trim(), '');
  });

  for (const [label, name, expected] of cases) {
    test(`offline contract: ${label}`, () => {
      assert.equal(recordedClientAccepts(name), expected, 'recorded client contract');
      assert.equal(proposedRuleModel(name), expected, 'proposed SQL semantic model');
    });
  }

  test('historical rule reproduces each documented incompatibility', () => {
    for (const name of ['\t', '\u00a0', '\ufeff', 'a' + ' '.repeat(150), '🍎'.repeat(76)]) {
      assert.equal(historicalRuleModel(name), true);
      assert.equal(recordedClientAccepts(name), false);
      assert.equal(proposedRuleModel(name), false);
    }
  });

  test('PostgreSQL representation limits are an explicit client difference', () => {
    // JS can represent these strings; PostgreSQL text/jsonb cannot. No live SQL
    // is executed here. These must fail before/while jsonb is decoded by PostgreSQL.
    for (const name of ['\0', '\ud800', '\udc00']) {
      assert.equal(recordedClientAccepts(name), true);
      assert.ok(name.includes('\0') || !name.isWellFormed());
    }
  });

  test('actual local client trims input but its parser lacks a raw length guard', () => {
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const elements = new Map();
    const context = vm.createContext({
      document: { querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, {
          addEventListener() {}, replaceChildren() {},
        });
        return elements.get(selector);
      } },
      localStorage: { getItem: () => null },
    });
    vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
    assert.equal(context.parseGroceryList(' \tMilk\u00a0 ')[0].name, 'Milk');
    for (const name of ['', ' ', '\t\r\n', '\u00a0\ufeff']) {
      assert.throws(() => context.parseGroceryList(name), /at least one/);
    }
    for (const name of ['a'.repeat(151), '🍎'.repeat(76)]) {
      assert.equal(context.parseGroceryList(name)[0].name, name);
      assert.equal(recordedClientAccepts(name), false);
    }
    assert.match(html, /id="name"[\s\S]*?maxlength="150"/);
  });

  test('generated live suite covers the same corpus and never installs a migration', () => {
    const sql = buildSql();
    assert.match(sql, /SET LOCAL ROLE authenticated/);
    assert.match(sql, /Claim-aware auth.uid\(\) prerequisite failed/);
    assert.match(sql, /Ledger acceptance\/rollback mismatch/);
    assert.ok(sql.includes(`PASS: ${cases.length} name cases`));
    assert.match(sql, /ROLLBACK;\n$/);
    assert.doesNotMatch(sql, /CREATE FUNCTION|ALTER TABLE|\\ir?\s/);
  });
}
