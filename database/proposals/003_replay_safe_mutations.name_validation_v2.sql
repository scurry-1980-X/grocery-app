-- NEW REVIEW PROPOSAL: name-validation v2 plus additive add_items, 2026-10-19.
-- Derived from ../recovered/003_replay_safe_mutations.recovered.sql; not historical SQL.
-- Requires deployed 002 and its baseline objects. NOT approved for deployment.
-- Fresh 003 installation only, not rerunnable or an upgrade for an installed 003.
-- See 003_NAME_VALIDATION_REVIEW.md and 003_ADD_ITEMS_REVIEW.md for review/test scope.
-- Additive stage: client writes/legacy RPCs remain until separate cutover 004.
BEGIN;
-- ascii(text) must return Unicode code points for the UTF-16 length calculation.
DO $encoding$
BEGIN
  IF pg_catalog.current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'Migration 003 requires UTF8 server encoding';
  END IF;
END;
$encoding$;
ALTER TABLE public.grocery_items
  ADD COLUMN revision uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid();

CREATE FUNCTION public.assign_grocery_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path TO '' AS $function$
BEGIN
  -- Fresh opaque version even for INSERT with a reused ID or an ABA update.
  NEW.revision := pg_catalog.gen_random_uuid();
  RETURN NEW;
END;
$function$;
CREATE TRIGGER assign_grocery_revision BEFORE INSERT OR UPDATE
ON public.grocery_items FOR EACH ROW EXECUTE FUNCTION public.assign_grocery_revision();
REVOKE ALL ON FUNCTION public.assign_grocery_revision() FROM PUBLIC, anon, authenticated;

CREATE TABLE public.grocery_mutation_requests (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  list_id uuid NOT NULL,
  operation text NOT NULL,
  payload jsonb NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (user_id, request_id)
);
ALTER TABLE public.grocery_mutation_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.grocery_mutation_requests FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.mutate_grocery_once(
  request_id uuid, target_list_id uuid, operation text, payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE
  caller_id uuid := auth.uid();
  existing public.grocery_mutation_requests%ROWTYPE;
  answer jsonb;
  token_id uuid;
  new_revision uuid;
  changed_id bigint;
  changed_ids jsonb;
  targets jsonb;
  item_name_text text;
  item_name_units bigint;
  -- add_items locals
  additions jsonb;
  addition jsonb;
  added_items jsonb;
BEGIN
  IF caller_id IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF request_id IS NULL OR target_list_id IS NULL OR operation IS NULL
     OR payload IS NULL OR pg_catalog.jsonb_typeof(payload) <> 'object' THEN
    RAISE EXCEPTION 'Request ID, list, operation and object payload are required';
  END IF;
  IF operation NOT IN ('invite', 'edit', 'delete', 'clear_purchased', 'add_items') THEN
    RAISE EXCEPTION 'Unsupported mutation';
  END IF;
  -- Check access even on replay. This also serializes membership revocation.
  PERFORM 1 FROM public.grocery_list_members AS m
    WHERE m.list_id = target_list_id AND m.user_id = caller_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'You are not a member of this grocery list'; END IF;

  INSERT INTO public.grocery_mutation_requests(user_id, request_id, list_id, operation, payload)
    VALUES(caller_id, mutate_grocery_once.request_id, target_list_id,
           mutate_grocery_once.operation, mutate_grocery_once.payload)
    ON CONFLICT ON CONSTRAINT grocery_mutation_requests_pkey DO NOTHING;
  IF NOT FOUND THEN
    SELECT r.* INTO existing FROM public.grocery_mutation_requests AS r
      WHERE r.user_id = caller_id AND r.request_id = mutate_grocery_once.request_id;
    IF existing.user_id IS NULL THEN
      RAISE EXCEPTION 'Result unavailable; retry the same request';
    END IF;
    IF existing.list_id <> target_list_id OR existing.operation <> operation
       OR existing.payload <> payload THEN
      RAISE EXCEPTION 'Request ID already used with a different operation or payload';
    END IF;
    IF existing.result IS NULL THEN RAISE EXCEPTION 'Incomplete mutation result'; END IF;
    RETURN existing.result;
  END IF;

  -- BEGIN additive add_items branch
  IF operation = 'add_items' THEN
    -- New intents only: never promote uncertain legacy INSERT receipts.
    -- Ownership/list/revision/timestamps are server-derived; reject extra keys.
    additions := payload->'items';
    IF payload - 'items' <> '{}'::jsonb
       OR pg_catalog.jsonb_typeof(additions) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Add requires an items array';
    END IF;
    IF pg_catalog.jsonb_array_length(additions) NOT BETWEEN 1 AND 200 THEN
      RAISE EXCEPTION 'Add batch must contain 1 to 200 items';
    END IF;
    -- Validate the ENTIRE batch before inserting any items. All failures also
    -- roll back the ledger reservation in this statement's transaction.
    FOR addition IN SELECT value FROM pg_catalog.jsonb_array_elements(additions) LOOP
      IF pg_catalog.jsonb_typeof(addition) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'Invalid add item';
      END IF;
      IF addition - ARRAY['id', 'item_name', 'quantity', 'purchased'] <> '{}'::jsonb
         OR pg_catalog.jsonb_typeof(addition->'id') IS DISTINCT FROM 'number'
         OR pg_catalog.jsonb_typeof(addition->'quantity') IS DISTINCT FROM 'number'
         OR pg_catalog.jsonb_typeof(addition->'purchased') IS DISTINCT FROM 'boolean' THEN
        RAISE EXCEPTION 'Invalid add item';
      END IF;
      -- Match recovered newId()/receipt(): negative JS-safe integers, avoiding
      -- the positive identity sequence. Do not round fractions via bigint casts.
      IF (addition->>'id')::numeric NOT BETWEEN -9007199254740991 AND -1
         OR (addition->>'id')::numeric <> pg_catalog.trunc((addition->>'id')::numeric)
         OR (addition->>'quantity')::numeric NOT BETWEEN 1 AND 999
         OR (addition->>'quantity')::numeric <> pg_catalog.trunc((addition->>'quantity')::numeric) THEN
        RAISE EXCEPTION 'Invalid add item';
      END IF;
      -- Same raw-name/ECMAScript trim/UTF-16 contract as edit below.
      IF pg_catalog.jsonb_typeof(addition->'item_name') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'Invalid item values';
      END IF;
      item_name_text := addition->>'item_name';
      -- This cheap upper bound also bounds the subsequent per-character scan.
      -- Explicit ECMAScript WhiteSpace + LineTerminator set, not locale \s.
      IF pg_catalog.length(item_name_text) > 150
         OR pg_catalog.btrim(item_name_text,
           U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') = '' THEN
        RAISE EXCEPTION 'Invalid item values';
      END IF;
      SELECT COALESCE(pg_catalog.sum(
        CASE WHEN pg_catalog.ascii(ch.c) > 65535 THEN 2 ELSE 1 END), 0)
        INTO item_name_units
        FROM pg_catalog.regexp_split_to_table(item_name_text, '') AS ch(c);
      IF item_name_units NOT BETWEEN 1 AND 150 THEN
        RAISE EXCEPTION 'Invalid item values';
      END IF;
    END LOOP;
    IF (SELECT pg_catalog.count(DISTINCT (value->>'id')::numeric::bigint)
        FROM pg_catalog.jsonb_array_elements(additions)) <> pg_catalog.jsonb_array_length(additions) THEN
      RAISE EXCEPTION 'Duplicate add item ID';
    END IF;
    -- Stable insertion order limits overlapping-batch deadlocks. A global ID
    -- collision is an error, never an upsert or proof of a legacy receipt.
    WITH inserted AS (
      INSERT INTO public.grocery_items(id, item_name, quantity, purchased, list_id, owner_id)
        SELECT (value->>'id')::numeric::bigint, value->>'item_name', (value->>'quantity')::numeric::bigint,
          (value->>'purchased')::boolean, target_list_id, caller_id
        FROM pg_catalog.jsonb_array_elements(additions)
        ORDER BY (value->>'id')::numeric::bigint
        RETURNING id, item_name, quantity, purchased, list_id, owner_id, created_at, revision
    )
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', i.id::text, 'item_name', i.item_name, 'quantity', i.quantity,
      'purchased', i.purchased, 'list_id', i.list_id, 'owner_id', i.owner_id,
      'created_at', i.created_at, 'revision', i.revision) ORDER BY a.ordinality)
      INTO added_items FROM inserted AS i
      JOIN pg_catalog.jsonb_array_elements(additions) WITH ORDINALITY AS a(value, ordinality)
        ON i.id = (a.value->>'id')::numeric::bigint;
    -- Immutable creation snapshot, independent of the current item rows.
    answer := pg_catalog.jsonb_build_object('status', 'ok', 'items', added_items);

  ELSIF operation = 'invite' THEN
  -- END additive add_items branch
    IF payload <> '{}'::jsonb THEN RAISE EXCEPTION 'Invite payload must be empty'; END IF;
    -- Reuse the existing invitation architecture and membership check.
    token_id := public.create_grocery_list_invite(target_list_id);
    SELECT pg_catalog.jsonb_build_object('status', 'ok', 'token', i.token,
      'expires_at', i.expires_at) INTO answer
      FROM public.grocery_list_invites AS i WHERE i.token = token_id;

  ELSIF operation IN ('edit', 'delete') THEN
    IF payload->>'id' IS NULL OR payload->>'revision' IS NULL THEN
      RAISE EXCEPTION 'Item ID and revision required';
    END IF;
    IF operation = 'edit' THEN
      -- Match the recorded shared loader: a string, nonblank under JS trim(),
      -- and at most 150 UTF-16 code units in the ORIGINAL value. Do not normalize
      -- either the stored name or the request payload used for replay matching.
      IF pg_catalog.jsonb_typeof(payload->'item_name') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'Invalid item values';
      END IF;
      item_name_text := payload->>'item_name';
      -- This cheap upper bound also bounds the subsequent per-character scan.
      -- Explicit ECMAScript WhiteSpace + LineTerminator set, not locale \s.
      IF pg_catalog.length(item_name_text) > 150
         OR pg_catalog.btrim(item_name_text,
           U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') = '' THEN
        RAISE EXCEPTION 'Invalid item values';
      END IF;
      SELECT COALESCE(pg_catalog.sum(
        CASE WHEN pg_catalog.ascii(ch.c) > 65535 THEN 2 ELSE 1 END), 0)
        INTO item_name_units
        FROM pg_catalog.regexp_split_to_table(item_name_text, '') AS ch(c);
      IF item_name_units NOT BETWEEN 1 AND 150
         OR (payload->>'quantity') IS NULL
         OR (payload->>'quantity')::bigint NOT BETWEEN 1 AND 999
         OR pg_catalog.jsonb_typeof(payload->'purchased') IS DISTINCT FROM 'boolean' THEN
        RAISE EXCEPTION 'Invalid item values';
      END IF;
      UPDATE public.grocery_items AS i
        SET item_name = payload->>'item_name', quantity = (payload->>'quantity')::bigint,
            purchased = (payload->>'purchased')::boolean
        WHERE i.list_id = target_list_id AND i.id = (payload->>'id')::bigint
          AND i.revision = (payload->>'revision')::uuid
        RETURNING i.id, i.revision INTO changed_id, new_revision;
    ELSE
      DELETE FROM public.grocery_items AS i
        WHERE i.list_id = target_list_id AND i.id = (payload->>'id')::bigint
          AND i.revision = (payload->>'revision')::uuid
        RETURNING i.id INTO changed_id;
    END IF;
    answer := CASE WHEN changed_id IS NULL
      THEN pg_catalog.jsonb_build_object('status', 'conflict')
      ELSE pg_catalog.jsonb_build_object('status', 'ok', 'id', changed_id::text,
                                        'revision', new_revision) END;

  ELSE
    -- Caller captures ONLY purchased rows' IDs and revisions at the click.
    targets := payload->'targets';
    IF pg_catalog.jsonb_typeof(targets) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Clear requires frozen targets';
    END IF;
    IF pg_catalog.jsonb_array_length(targets) > 10000 THEN
      RAISE EXCEPTION 'Clear target limit exceeded';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(targets) AS t(value)
       WHERE pg_catalog.jsonb_typeof(t.value) <> 'object'
         OR t.value->>'id' IS NULL OR t.value->>'revision' IS NULL) THEN
      RAISE EXCEPTION 'Invalid clear target';
    END IF;
    -- Deduplicate targets, lock in stable ID order, and recheck revision/state.
    -- Unlike DELETE WHERE purchased, this cannot expand after the first send.
    WITH selected AS MATERIALIZED (
      SELECT i.id FROM public.grocery_items AS i
      WHERE i.list_id = target_list_id AND i.purchased = true
        AND EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(targets) AS t(value)
          WHERE i.id = (t.value->>'id')::bigint
            AND i.revision = (t.value->>'revision')::uuid)
      ORDER BY i.id FOR UPDATE OF i
    ), removed AS (
      DELETE FROM public.grocery_items AS i USING selected AS s
        WHERE i.id = s.id RETURNING i.id
    ) SELECT COALESCE(pg_catalog.jsonb_agg(id::text ORDER BY id), '[]'::jsonb)
      INTO changed_ids FROM removed;
    answer := pg_catalog.jsonb_build_object('status', 'ok', 'deleted_ids', changed_ids);
  END IF;

  UPDATE public.grocery_mutation_requests AS r SET result = answer
    WHERE r.user_id = caller_id AND r.request_id = mutate_grocery_once.request_id;
  RETURN answer;
END;
$function$;
ALTER FUNCTION public.mutate_grocery_once(uuid, uuid, text, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mutate_grocery_once(uuid, uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mutate_grocery_once(uuid, uuid, text, jsonb) TO authenticated;
COMMIT;
