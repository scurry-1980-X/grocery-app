-- PROPOSAL ONLY. Requires proposal 002. Do not run without production approval.
-- Additive stage: client writes/legacy RPCs remain until separate cutover 004.
BEGIN;
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
BEGIN
  IF caller_id IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF request_id IS NULL OR target_list_id IS NULL OR operation IS NULL
     OR payload IS NULL OR pg_catalog.jsonb_typeof(payload) <> 'object' THEN
    RAISE EXCEPTION 'Request ID, list, operation and object payload are required';
  END IF;
  IF operation NOT IN ('invite', 'edit', 'delete', 'clear_purchased') THEN
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

  IF operation = 'invite' THEN
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
      IF pg_catalog.jsonb_typeof(payload->'item_name') IS DISTINCT FROM 'string'
         OR pg_catalog.length(pg_catalog.btrim(payload->>'item_name')) NOT BETWEEN 1 AND 150
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
