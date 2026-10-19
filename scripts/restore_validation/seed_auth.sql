-- Read references inside the isolated server; never extract IDs to host output.
INSERT INTO auth.users(id)
SELECT owner_id FROM public.grocery_items WHERE owner_id IS NOT NULL
UNION SELECT user_id FROM public.grocery_list_members
UNION SELECT created_by FROM public.grocery_list_invites
UNION SELECT user_id FROM public.grocery_list_create_requests;
