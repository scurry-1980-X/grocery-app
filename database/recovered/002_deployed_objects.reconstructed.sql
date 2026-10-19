-- RECONSTRUCTED DEPLOYED-OBJECT RECORD; NOT THE ORIGINAL MIGRATION FILE.
-- Source: verified pre-Migration-003 local custom-format backup.
-- Seven schema-only archive entries; no data, identities, or credentials.
-- Do not apply to production or run as a pending migration: 002 is already deployed.
-- This records backup-time state, not independently verified present production.
-- See MIGRATION_SOURCE_RECOVERY.md and provenance.json in this directory.
-- Generated psql restrict/unrestrict guards and trailing empty footer lines were removed.

--
-- PostgreSQL database dump
--


-- Dumped from database version 17.11
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: create_grocery_list_once(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

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

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: grocery_list_create_requests; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.grocery_list_create_requests (
    user_id uuid NOT NULL,
    request_id uuid NOT NULL,
    list_id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.grocery_list_create_requests OWNER TO postgres;

--
-- Name: grocery_list_create_requests grocery_list_create_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.grocery_list_create_requests
    ADD CONSTRAINT grocery_list_create_requests_pkey PRIMARY KEY (user_id, request_id);


--
-- Name: grocery_list_create_requests grocery_list_create_requests_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.grocery_list_create_requests
    ADD CONSTRAINT grocery_list_create_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: grocery_list_create_requests; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.grocery_list_create_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: FUNCTION create_grocery_list_once(request_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.create_grocery_list_once(request_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_grocery_list_once(request_id uuid) TO authenticated;


--
-- Name: TABLE grocery_list_create_requests; Type: ACL; Schema: public; Owner: postgres
--

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.grocery_list_create_requests TO service_role;


--
-- PostgreSQL database dump complete
--
