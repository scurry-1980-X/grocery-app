-- HISTORICALLY GROUNDED TEST FIXTURE, NOT AN ORIGINAL MIGRATION.
-- Disposable Supabase only; no production use. See README.md and provenance.json.
-- Requires native auth.users, auth.uid(), and existing Supabase roles on PG 17+.
-- Fresh application namespace; no IF NOT EXISTS, replacements, data, or cleanup.
BEGIN;
SET LOCAL ROLE postgres;
SET LOCAL search_path = '';
SET LOCAL check_function_bodies = true;
SET LOCAL default_tablespace = '';
SET LOCAL default_table_access_method = heap;

-- Exact recovered ledger DDL; installed before its function instead of dump order.
CREATE TABLE public.grocery_list_create_requests (
    user_id uuid NOT NULL,
    request_id uuid NOT NULL,
    list_id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.grocery_list_create_requests OWNER TO postgres;

ALTER TABLE ONLY public.grocery_list_create_requests
    ADD CONSTRAINT grocery_list_create_requests_pkey PRIMARY KEY (user_id, request_id);

ALTER TABLE ONLY public.grocery_list_create_requests
    ADD CONSTRAINT grocery_list_create_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.grocery_list_create_requests ENABLE ROW LEVEL SECURITY;

-- Exact recovered create-once definition; no replay or membership behavior changes.
CREATE FUNCTION public.create_grocery_list_once(request_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  caller_id uuid := auth.uid();
  result_list_id uuid;
BEGIN
  IF caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF request_id IS NULL THEN
    RAISE EXCEPTION 'A request ID is required';
  END IF;

  INSERT INTO public.grocery_list_create_requests AS requests (
    user_id,
    request_id
  )
  VALUES (
    caller_id,
    create_grocery_list_once.request_id
  )
  ON CONFLICT ON CONSTRAINT grocery_list_create_requests_pkey
    DO NOTHING
  RETURNING requests.list_id INTO result_list_id;

  IF FOUND THEN
    INSERT INTO public.grocery_list_members (list_id, user_id)
    VALUES (result_list_id, caller_id);

    RETURN result_list_id;
  END IF;

  -- A separate statement sees the committed winner at READ COMMITTED.
  SELECT requests.list_id INTO result_list_id
  FROM public.grocery_list_create_requests AS requests
  WHERE requests.user_id = caller_id
    AND requests.request_id = create_grocery_list_once.request_id;

  IF result_list_id IS NULL THEN
    RAISE EXCEPTION
      'Creation result unavailable; retry with the same request ID';
  END IF;

  -- Replaying a request must not restore revoked membership.
  IF NOT EXISTS (
    SELECT 1
    FROM public.grocery_list_members AS members
    WHERE members.list_id = result_list_id
      AND members.user_id = caller_id
  ) THEN
    RAISE EXCEPTION
      'Access to the previously created list is no longer available';
  END IF;

  RETURN result_list_id;
END;
$$;

ALTER FUNCTION public.create_grocery_list_once(request_id uuid) OWNER TO postgres;

-- Explicit catalog-equivalent ACLs, including removal of inherited API grants.
REVOKE ALL ON TABLE public.grocery_list_create_requests FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.grocery_list_create_requests TO postgres;
GRANT REFERENCES, TRIGGER, TRUNCATE, MAINTAIN ON TABLE public.grocery_list_create_requests TO service_role;
REVOKE ALL ON FUNCTION public.create_grocery_list_once(request_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_grocery_list_once(request_id uuid) TO postgres, authenticated;
COMMIT;
