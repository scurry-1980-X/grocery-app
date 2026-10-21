--
-- PostgreSQL database dump
--

\restrict ZFKOKrzrwx1gWGFdMnIgV2d0WQCw6Jr9UcabZxgazFDCZTdcZK1CZCjS29iiRYs

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
-- Name: create_grocery_list(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.create_grocery_list() RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  new_list_id uuid := gen_random_uuid();
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  insert into public.grocery_list_members (list_id, user_id)
  values (new_list_id, auth.uid());

  return new_list_id;
end;
$$;


ALTER FUNCTION public.create_grocery_list() OWNER TO postgres;

--
-- Name: create_grocery_list_invite(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.create_grocery_list_invite(target_list_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  new_token uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not exists (
    select 1
    from public.grocery_list_members
    where list_id = target_list_id
      and user_id = auth.uid()
  ) then
    raise exception 'You are not a member of this grocery list';
  end if;

  insert into public.grocery_list_invites (list_id, created_by)
  values (target_list_id, auth.uid())
  returning token into new_token;

  return new_token;
end;
$$;


ALTER FUNCTION public.create_grocery_list_invite(target_list_id uuid) OWNER TO postgres;

--
-- Name: redeem_grocery_list_invite(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.redeem_grocery_list_invite(invite_token uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  caller_id uuid := auth.uid();
  target_list_id uuid;
BEGIN
  IF caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- Concurrent attempts contend on the same invitation row.
  -- Only one can change an unused, unexpired invitation.
  UPDATE public.grocery_list_invites AS invitation
  SET used_at = pg_catalog.clock_timestamp()
  WHERE invitation.token = invite_token
    AND invitation.used_at IS NULL
    AND invitation.expires_at > pg_catalog.clock_timestamp()
  RETURNING invitation.list_id INTO target_list_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invite is invalid, expired, or already used';
  END IF;

  INSERT INTO public.grocery_list_members (list_id, user_id)
  VALUES (target_list_id, caller_id)
  ON CONFLICT (list_id, user_id) DO NOTHING;

  RETURN target_list_id;
END;
$$;


ALTER FUNCTION public.redeem_grocery_list_invite(invite_token uuid) OWNER TO postgres;

--
-- PostgreSQL database dump complete
--

\unrestrict ZFKOKrzrwx1gWGFdMnIgV2d0WQCw6Jr9UcabZxgazFDCZTdcZK1CZCjS29iiRYs

