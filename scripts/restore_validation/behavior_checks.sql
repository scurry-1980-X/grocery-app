-- All changes, including the simulated auth.uid definition, roll back.
-- Use explicit synthetic item IDs: sequence nextval is NOT transactional.
BEGIN;
SET LOCAL ROLE anon;
DO $$ BEGIN
 IF EXISTS (SELECT FROM public.grocery_items) OR EXISTS (SELECT FROM public.grocery_list_members)
 THEN RAISE check_violation USING MESSAGE='anonymous visibility'; END IF;
 BEGIN
  PERFORM public.create_grocery_list();
  RAISE check_violation USING MESSAGE='expected auth guard';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'Authentication required' THEN RAISE; END IF;
 END;
 BEGIN
  PERFORM public.create_grocery_list_once(gen_random_uuid());
  RAISE check_violation USING MESSAGE='expected execute denial';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;

SET LOCAL ROLE authenticated;
DO $$ BEGIN
 IF EXISTS (SELECT FROM public.grocery_items) OR EXISTS (SELECT FROM public.grocery_list_members)
 THEN RAISE check_violation USING MESSAGE='NULL identity visibility'; END IF;
 BEGIN
  PERFORM public.create_grocery_list();
  RAISE check_violation USING MESSAGE='expected auth guard';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'Authentication required' THEN RAISE; END IF;
 END;
 BEGIN
  PERFORM public.create_grocery_list_once(gen_random_uuid());
  RAISE check_violation USING MESSAGE='expected auth guard';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'Authentication required' THEN RAISE; END IF;
 END;
 BEGIN
  PERFORM public.create_grocery_list_invite(gen_random_uuid());
  RAISE check_violation USING MESSAGE='expected auth guard';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'Authentication required' THEN RAISE; END IF;
 END;
 BEGIN
  PERFORM public.redeem_grocery_list_invite(gen_random_uuid());
  RAISE check_violation USING MESSAGE='expected auth guard';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'Authentication required' THEN RAISE; END IF;
 END;
END $$;

RESET ROLE;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
 AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
DO $$ DECLARE u uuid; BEGIN
 u := gen_random_uuid(); INSERT INTO auth.users VALUES(u);
 PERFORM set_config('test.member',u::text,true);
 u := gen_random_uuid(); INSERT INTO auth.users VALUES(u);
 PERFORM set_config('test.invitee',u::text,true);
 u := gen_random_uuid(); INSERT INTO auth.users VALUES(u);
 PERFORM set_config('test.outsider',u::text,true);
END $$;

SET LOCAL ROLE authenticated;
DO $$ DECLARE l uuid; req uuid := gen_random_uuid(); token uuid; affected integer;
BEGIN
 PERFORM set_config('request.jwt.claim.sub',current_setting('test.member'),true);
 l := public.create_grocery_list();
 IF NOT EXISTS (SELECT FROM public.grocery_list_members WHERE list_id=l AND user_id=auth.uid())
 THEN RAISE check_violation USING MESSAGE='create membership missing'; END IF;
 l := public.create_grocery_list_once(req);
 IF public.create_grocery_list_once(req) IS DISTINCT FROM l
 THEN RAISE check_violation USING MESSAGE='idempotent replay failed'; END IF;
 PERFORM set_config('test.list',l::text,true);
 BEGIN
  PERFORM public.create_grocery_list_once(NULL);
  RAISE check_violation USING MESSAGE='expected request guard';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'A request ID is required' THEN RAISE; END IF;
 END;
 INSERT INTO public.grocery_items(id,item_name,list_id,owner_id,quantity)
 VALUES(-9223372036854775807,'isolated-validation',l,auth.uid(),1);
 IF (SELECT count(*) FROM public.grocery_items WHERE list_id=l) <> 1
 THEN RAISE check_violation USING MESSAGE='member read failed'; END IF;
 UPDATE public.grocery_items SET purchased=true,quantity=2 WHERE list_id=l;
 GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>1 THEN RAISE check_violation USING MESSAGE='member update failed'; END IF;
 token := public.create_grocery_list_invite(l);
 PERFORM set_config('test.token',token::text,true);

 PERFORM set_config('request.jwt.claim.sub',current_setting('test.outsider'),true);
 IF EXISTS (SELECT FROM public.grocery_items WHERE list_id=l)
 OR EXISTS (SELECT FROM public.grocery_list_members WHERE list_id=l)
 THEN RAISE check_violation USING MESSAGE='outsider visibility'; END IF;
 UPDATE public.grocery_items SET purchased=false WHERE list_id=l;
 GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>0 THEN RAISE check_violation USING MESSAGE='outsider update'; END IF;
 DELETE FROM public.grocery_items WHERE list_id=l;
 GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>0 THEN RAISE check_violation USING MESSAGE='outsider delete'; END IF;
 BEGIN
  INSERT INTO public.grocery_items(id,item_name,list_id,owner_id)
  VALUES(-9223372036854775806,'denied',l,auth.uid());
  RAISE check_violation USING MESSAGE='outsider insert';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  INSERT INTO public.grocery_list_members(list_id,user_id) VALUES(l,auth.uid());
  RAISE check_violation USING MESSAGE='direct membership insert';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  PERFORM public.create_grocery_list_invite(l);
  RAISE check_violation USING MESSAGE='outsider invitation';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'You are not a member of this grocery list' THEN RAISE; END IF;
 END;

 PERFORM set_config('request.jwt.claim.sub',current_setting('test.invitee'),true);
 IF public.redeem_grocery_list_invite(token) IS DISTINCT FROM l
 THEN RAISE check_violation USING MESSAGE='invite redemption'; END IF;
 IF (SELECT count(*) FROM public.grocery_items WHERE list_id=l)<>1
 THEN RAISE check_violation USING MESSAGE='invitee read'; END IF;
 BEGIN
  PERFORM public.redeem_grocery_list_invite(token);
  RAISE check_violation USING MESSAGE='invite reused';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'Invite is invalid, expired, or already used' THEN RAISE; END IF;
 END;
 DELETE FROM public.grocery_items WHERE list_id=l;
 GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>1 THEN RAISE check_violation USING MESSAGE='member delete failed'; END IF;
END $$;
ROLLBACK;
