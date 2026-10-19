-- Emit only fixed check labels and booleans. Never emit row values or identities.
SELECT 'only intended public relations',
  (SELECT array_agg(relname::text ORDER BY relname) FROM pg_class
   WHERE relnamespace='public'::regnamespace AND relkind IN ('r','S','v','m','f','p')) =
  ARRAY['grocery_items','grocery_items_id_seq','grocery_list_create_requests',
        'grocery_list_invites','grocery_list_members'];

SELECT 'no managed schemas publications or event triggers restored',
 NOT EXISTS (SELECT FROM pg_namespace WHERE nspname NOT IN
   ('public','auth','pg_catalog','information_schema','pg_toast') AND nspname !~ '^pg_(temp|toast_temp)_')
 AND NOT EXISTS (SELECT FROM pg_publication)
 AND NOT EXISTS (SELECT FROM pg_event_trigger);

SELECT 'four RLS tables enabled and not forced',
 count(*)=4 AND bool_and(relrowsecurity AND NOT relforcerowsecurity)
 FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r';

WITH expected(t,c,typ,nn,ident) AS (VALUES
 ('grocery_items','id','bigint',true,'d'),
 ('grocery_items','created_at','timestamp with time zone',true,''),
 ('grocery_items','item_name','text',false,''),
 ('grocery_items','purchased','boolean',false,''),
 ('grocery_items','list_id','uuid',false,''),
 ('grocery_items','quantity','bigint',false,''),
 ('grocery_items','owner_id','uuid',false,''),
 ('grocery_list_members','list_id','uuid',true,''),
 ('grocery_list_members','user_id','uuid',true,''),
 ('grocery_list_members','created_at','timestamp with time zone',true,''),
 ('grocery_list_invites','token','uuid',true,''),
 ('grocery_list_invites','list_id','uuid',true,''),
 ('grocery_list_invites','created_by','uuid',true,''),
 ('grocery_list_invites','created_at','timestamp with time zone',true,''),
 ('grocery_list_invites','expires_at','timestamp with time zone',true,''),
 ('grocery_list_invites','used_at','timestamp with time zone',false,''),
 ('grocery_list_create_requests','user_id','uuid',true,''),
 ('grocery_list_create_requests','request_id','uuid',true,''),
 ('grocery_list_create_requests','list_id','uuid',true,''),
 ('grocery_list_create_requests','created_at','timestamp with time zone',true,'')
), actual AS (
 SELECT c.relname::text t,a.attname::text c,format_type(a.atttypid,a.atttypmod) typ,
 a.attnotnull nn,a.attidentity::text ident FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
 WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
)
SELECT 'all column types nullability and identity definitions match baseline',
 NOT EXISTS ((SELECT * FROM expected EXCEPT SELECT * FROM actual)
 UNION ALL (SELECT * FROM actual EXCEPT SELECT * FROM expected));

WITH expected(t,c,d) AS (VALUES
 ('grocery_items','created_at','now()'), ('grocery_items','purchased','false'),
 ('grocery_items','quantity',chr(39)||'1'||chr(39)||'::bigint'),
 ('grocery_list_members','created_at','now()'),
 ('grocery_list_invites','token','gen_random_uuid()'),
 ('grocery_list_invites','created_at','now()'),
 ('grocery_list_invites','expires_at','(now() + ''7 days''::interval)'),
 ('grocery_list_create_requests','list_id','gen_random_uuid()'),
 ('grocery_list_create_requests','created_at','now()')
), actual AS (
 SELECT c.relname::text,a.attname::text,pg_get_expr(d.adbin,d.adrelid)
 FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
 JOIN pg_class c ON c.oid=d.adrelid WHERE c.relnamespace='public'::regnamespace
)
SELECT 'all column defaults match baseline',
 NOT EXISTS ((SELECT * FROM expected EXCEPT SELECT * FROM actual)
 UNION ALL (SELECT * FROM actual EXCEPT SELECT * FROM expected));

WITH expected(t,n,d) AS (VALUES
 ('grocery_items','grocery_items_pkey','PRIMARY KEY (id)'),
 ('grocery_list_members','grocery_list_members_pkey','PRIMARY KEY (list_id, user_id)'),
 ('grocery_list_invites','grocery_list_invites_pkey','PRIMARY KEY (token)'),
 ('grocery_list_create_requests','grocery_list_create_requests_pkey','PRIMARY KEY (user_id, request_id)'),
 ('grocery_items','grocery_items_owner_id_fkey','FOREIGN KEY (owner_id) REFERENCES auth.users(id)'),
 ('grocery_list_members','grocery_list_members_user_id_fkey','FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE'),
 ('grocery_list_invites','grocery_list_invites_created_by_fkey','FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE CASCADE'),
 ('grocery_list_create_requests','grocery_list_create_requests_user_id_fkey','FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE')
), actual AS (
 SELECT conrelid::regclass::text,conname::text,pg_get_constraintdef(oid)
 FROM pg_constraint WHERE connamespace='public'::regnamespace
)
SELECT 'exact primary and foreign key definitions including delete actions',
 NOT EXISTS ((SELECT * FROM expected EXCEPT SELECT * FROM actual)
 UNION ALL (SELECT * FROM actual EXCEPT SELECT * FROM expected));

SELECT 'all constraints validated and indexes valid',
 NOT EXISTS (SELECT FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated)
 AND NOT EXISTS (SELECT FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid
 WHERE c.relnamespace='public'::regnamespace AND (NOT i.indisvalid OR NOT i.indisready));

WITH expected(n,args) AS (VALUES ('create_grocery_list',''),('create_grocery_list_invite','uuid'),
 ('create_grocery_list_once','uuid'),('redeem_grocery_list_invite','uuid')),
actual AS (
 SELECT p.proname::text n,oidvectortypes(p.proargtypes) args
 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
 AND p.prorettype='uuid'::regtype AND p.prosecdef AND NOT p.proisstrict
 AND p.provolatile='v' AND p.prokind='f' AND p.proconfig=ARRAY['search_path=""']
 AND p.proowner='postgres'::regrole AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
)
SELECT 'four function signatures owners security definers and empty search paths',
 NOT EXISTS ((SELECT * FROM expected EXCEPT SELECT * FROM actual)
 UNION ALL (SELECT * FROM actual EXCEPT SELECT * FROM expected))
 AND (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace)=4;

WITH expressions AS (
 SELECT 'EXISTS ( SELECT 1 FROM grocery_list_members WHERE ((grocery_list_members.list_id = grocery_items.list_id) AND (grocery_list_members.user_id = auth.uid())))'::text member
), expected(t,n,cmd,q,w) AS (
 SELECT 'grocery_items','Members can add grocery items','a',NULL::text,member FROM expressions
 UNION ALL SELECT 'grocery_items','Members can delete grocery items','d',member,NULL FROM expressions
 UNION ALL SELECT 'grocery_items','Members can read grocery items','r',member,NULL FROM expressions
 UNION ALL SELECT 'grocery_items','Members can update grocery items','w',member,member FROM expressions
 UNION ALL SELECT 'grocery_list_members','Users can view their own list memberships','r','user_id = auth.uid()',NULL
), actual AS (
 SELECT p.polrelid::regclass::text t,p.polname::text n,p.polcmd::text cmd,
 pg_get_expr(p.polqual,p.polrelid) q,pg_get_expr(p.polwithcheck,p.polrelid) w
 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
 WHERE c.relnamespace='public'::regnamespace
 AND p.polpermissive AND p.polroles=ARRAY['authenticated'::regrole::oid]
), e AS (SELECT t,n,cmd,regexp_replace(q,'[[:space:]()]','','g') q,
 regexp_replace(w,'[[:space:]()]','','g') w FROM expected),
a AS (SELECT t,n,cmd,regexp_replace(q,'[[:space:]()]','','g') q,
 regexp_replace(w,'[[:space:]()]','','g') w FROM actual)
SELECT 'exact five policy names commands roles USING and WITH CHECK expressions',
 NOT EXISTS ((SELECT * FROM e EXCEPT SELECT * FROM a) UNION ALL (SELECT * FROM a EXCEPT SELECT * FROM e))
 AND (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
 WHERE c.relnamespace='public'::regnamespace)=5;

-- Compare all explicit ACL entries, including owner, PUBLIC and grant options.
WITH expected AS (
 SELECT t,r,p FROM (VALUES ('grocery_items'),('grocery_list_members')) tables(t)
 CROSS JOIN (VALUES ('anon'),('authenticated')) roles(r)
 CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','REFERENCES','TRIGGER','MAINTAIN']) p
 UNION ALL SELECT t,'service_role',p FROM (VALUES ('grocery_items'),('grocery_list_members')) tables(t)
 CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p
 UNION ALL SELECT 'grocery_list_invites',r,p FROM (VALUES ('anon'),('authenticated')) roles(r)
 CROSS JOIN unnest(ARRAY['REFERENCES','TRIGGER','MAINTAIN']) p
 UNION ALL SELECT t,'service_role',p FROM (VALUES ('grocery_list_invites'),('grocery_list_create_requests')) tables(t)
 CROSS JOIN unnest(ARRAY['REFERENCES','TRIGGER','TRUNCATE','MAINTAIN']) p
 UNION ALL SELECT t,'postgres',p FROM (VALUES ('grocery_items'),('grocery_list_members'),
 ('grocery_list_invites'),('grocery_list_create_requests')) tables(t)
 CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p
), actual AS (
 SELECT c.relname::text t,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END r,a.privilege_type p
 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
 WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'
 AND NOT a.is_grantable AND a.grantor='postgres'::regrole
)
SELECT 'exact table ACLs including PUBLIC and grant options',
 NOT EXISTS ((SELECT * FROM expected EXCEPT SELECT * FROM actual)
 UNION ALL (SELECT * FROM actual EXCEPT SELECT * FROM expected))
 AND NOT EXISTS (SELECT FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
 WHERE c.relnamespace='public'::regnamespace AND (a.is_grantable OR a.grantor<>'postgres'::regrole));

WITH expected(n,r) AS (
 SELECT n,r FROM (VALUES ('create_grocery_list'),('create_grocery_list_invite'),('redeem_grocery_list_invite')) f(n)
 CROSS JOIN (VALUES ('postgres'),('anon'),('authenticated'),('service_role')) roles(r)
 UNION ALL VALUES ('create_grocery_list_once','postgres'),('create_grocery_list_once','authenticated')
), actual AS (
 SELECT p.proname::text n,pg_get_userbyid(a.grantee)::text r
 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
 WHERE p.pronamespace='public'::regnamespace AND a.privilege_type='EXECUTE'
 AND NOT a.is_grantable AND a.grantor='postgres'::regrole
)
SELECT 'exact function execute ACLs and no PUBLIC execution',
 NOT EXISTS ((SELECT * FROM expected EXCEPT SELECT * FROM actual)
 UNION ALL (SELECT * FROM actual EXCEPT SELECT * FROM expected))
 AND NOT EXISTS (SELECT FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
 WHERE p.pronamespace='public'::regnamespace AND (a.is_grantable OR a.grantor<>'postgres'::regrole));

WITH expected(k,r,p) AS (
 SELECT 'r',r,p FROM (VALUES ('anon'),('authenticated'),('service_role')) roles(r)
 CROSS JOIN unnest(ARRAY['REFERENCES','TRIGGER','TRUNCATE','MAINTAIN']) p
 UNION ALL SELECT 'r','postgres',p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p
 UNION ALL SELECT 'S','postgres',p FROM unnest(ARRAY['SELECT','UPDATE','USAGE']) p
 UNION ALL VALUES ('f','postgres','EXECUTE')
), actual AS (
 SELECT d.defaclobjtype::text k,pg_get_userbyid(a.grantee)::text r,a.privilege_type p
 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
 WHERE d.defaclnamespace='public'::regnamespace AND d.defaclrole='postgres'::regrole
 AND NOT a.is_grantable AND a.grantor='postgres'::regrole
)
SELECT 'postgres public default privileges restored exactly; managed owner excluded',
 NOT EXISTS ((SELECT * FROM expected EXCEPT SELECT * FROM actual)
 UNION ALL (SELECT * FROM actual EXCEPT SELECT * FROM expected))
 AND (SELECT count(*) FROM pg_default_acl)=3
 AND NOT EXISTS (SELECT FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
 WHERE a.is_grantable OR a.grantor<>'postgres'::regrole);

SELECT 'all referenced auth IDs resolved without extras',
 (SELECT count(*) FROM auth.users) =
 (SELECT count(*) FROM (SELECT owner_id FROM grocery_items WHERE owner_id IS NOT NULL
 UNION SELECT user_id FROM grocery_list_members UNION SELECT created_by FROM grocery_list_invites
 UNION SELECT user_id FROM grocery_list_create_requests) refs);

SELECT 'identity sequence ownership and next value valid',
 pg_get_serial_sequence('public.grocery_items','id')='public.grocery_items_id_seq'
 AND (SELECT last_value + CASE WHEN is_called THEN 1 ELSE 0 END FROM grocery_items_id_seq) >
 coalesce((SELECT max(id) FROM grocery_items),0)
 AND (SELECT seqincrement=1 AND seqmin=1 AND NOT seqcycle FROM pg_sequence
 WHERE seqrelid='public.grocery_items_id_seq'::regclass);

SELECT 'scaffold roles cannot log in or bypass RLS',
 count(*)=3 AND bool_and(NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls)
 FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role');
