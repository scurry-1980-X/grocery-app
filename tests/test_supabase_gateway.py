"""Execute only the gateway's pure Lua filter against in-memory Envoy stubs.

Uses an already-installed liblua (5.4/5.3/5.1); no images, Envoy, HTTP or SQL.
This is not a substitute for later Envoy/LuaJIT and WebSocket integration tests.
"""
import ctypes
import ctypes.util
import json
from pathlib import Path
import unittest

SOURCE = Path(__file__).resolve().parent / 'supabase_integration/stack/gateway.lua'
TOKENS = {'PUBLISHABLE_KEY':'sb_publishable_'+'a'*64, 'SECRET_KEY':'sb_secret_'+'b'*64,
          'ANON_JWT':'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.signature',
          'SERVICE_JWT':'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature'}
USER = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJsb2NhbC11c2VyIn0.usersignature'


class GatewayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        name = ctypes.util.find_library('lua5.4') or ctypes.util.find_library('lua5.3')
        if not name:
            raise RuntimeError('Offline gateway tests require an already-installed liblua5.4 or liblua5.3')
        cls.lua = ctypes.CDLL(name)
        cls.lua.luaL_newstate.restype = ctypes.c_void_p
        cls.lua.luaL_openlibs.argtypes = [ctypes.c_void_p]
        cls.lua.luaL_loadstring.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
        cls.lua.luaL_loadstring.restype = ctypes.c_int
        cls.lua.lua_pcallk.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                     ctypes.c_ssize_t, ctypes.c_void_p]
        cls.lua.lua_pcallk.restype = ctypes.c_int
        cls.lua.lua_tolstring.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
        cls.lua.lua_tolstring.restype = ctypes.c_char_p
        cls.lua.lua_close.argtypes = [ctypes.c_void_p]

    def run_filter(self, route, headers, expected, status=None):
        source = SOURCE.read_text()
        for key, value in TOKENS.items(): source = source.replace('@'+key+'@', value)
        values = '{'+','.join('['+json.dumps(k)+']='+json.dumps(v) for k,v in headers.items())+'}'
        script = source + '\nlocal values = ' + values + '''
local status = nil
local headers = {}
function headers:get(key) return values[key] end
function headers:replace(key, value) values[key] = value end
local handle = {}
function handle:headers() return headers end
function handle:streamInfo() return { routeName = function() return ROUTE end } end
function handle:respond(fields, body) status = fields[":status"] end
envoy_on_request(handle)
'''.replace('ROUTE', json.dumps(route))
        script += 'assert(status == '+('nil' if status is None else json.dumps(status))+', "response status")\n'
        for key, value in expected.items():
            script += 'assert(values['+json.dumps(key)+'] == '+('nil' if value is None else json.dumps(value))+', '+json.dumps('header '+key)+')\n'
        state = self.lua.luaL_newstate()
        self.assertTrue(state)
        try:
            self.lua.luaL_openlibs(state)
            result = self.lua.luaL_loadstring(state, script.encode())
            if not result:
                result = self.lua.lua_pcallk(state, 0, 0, 0, 0, None)
            error = self.lua.lua_tolstring(state, -1, None) if result else b''
            self.assertEqual(result, 0, error.decode() if error else 'Lua error')
        finally:
            self.lua.lua_close(state)

    def test_publishable_key_becomes_real_anon_jwt(self):
        for route in ('auth','rest'):
            with self.subTest(route=route):
                self.run_filter(route, {':path':'/'+route+'/v1/', 'apikey':TOKENS['PUBLISHABLE_KEY']},
                                {'apikey':TOKENS['ANON_JWT'], 'authorization':'Bearer '+TOKENS['ANON_JWT']})

    def test_user_jwt_preserved_for_all_protected_routes(self):
        for route in ('auth','rest','realtime'):
            with self.subTest(route=route):
                self.run_filter(route, {':path':'/resource', 'apikey':TOKENS['PUBLISHABLE_KEY'],
                                       'authorization':'Bearer '+USER},
                                {'apikey':TOKENS['ANON_JWT'], 'authorization':'Bearer '+USER})

    def test_invalid_signature_shaped_token_is_not_downgraded(self):
        self.run_filter('rest', {':path':'/rest/v1/items', 'apikey':TOKENS['PUBLISHABLE_KEY'],
                               'authorization':'Bearer bad.payload.signature'},
                        {'authorization':'Bearer bad.payload.signature'})

    def test_matching_opaque_bearer_translated_and_conflicting_bearer_rejected(self):
        self.run_filter('rest', {':path':'/rest/v1/items','apikey':TOKENS['PUBLISHABLE_KEY'],
                               'authorization':'Bearer '+TOKENS['PUBLISHABLE_KEY']},
                        {'authorization':'Bearer '+TOKENS['ANON_JWT']})
        for bearer in (TOKENS['SECRET_KEY'], 'sb_publishable_foreign', 'sb_secret_foreign'):
            with self.subTest(bearer=bearer):
                self.run_filter('rest', {':path':'/rest/v1/items','apikey':TOKENS['PUBLISHABLE_KEY'],
                                       'authorization':'Bearer '+bearer}, {}, '401')

    def test_websocket_query_key_translated_and_other_parameters_preserved(self):
        path='/realtime/v1/websocket?apikey='+TOKENS['PUBLISHABLE_KEY']+'&vsn=1.0.0'
        self.run_filter('realtime', {':path':path},
                        {':path':'/realtime/v1/websocket?apikey='+TOKENS['ANON_JWT']+'&vsn=1.0.0',
                         'apikey':TOKENS['ANON_JWT'], 'x-api-key':TOKENS['ANON_JWT'],
                         'authorization':None})

    def test_matching_header_and_query_key_translate_consistently(self):
        self.run_filter('realtime', {':path':'/realtime/v1/websocket?apikey='+TOKENS['PUBLISHABLE_KEY'],
                                    'apikey':TOKENS['PUBLISHABLE_KEY'], 'authorization':'Bearer '+USER},
                        {'apikey':TOKENS['ANON_JWT'], 'authorization':'Bearer '+USER,
                         'x-api-key':TOKENS['ANON_JWT']})

    def test_secret_and_legacy_keys_preserve_role_mapping(self):
        for key, expected in ((TOKENS['SECRET_KEY'], TOKENS['SERVICE_JWT']),
                              (TOKENS['SERVICE_JWT'], TOKENS['SERVICE_JWT']),
                              (TOKENS['ANON_JWT'], TOKENS['ANON_JWT'])):
            with self.subTest(key=key):
                self.run_filter('rest', {':path':'/rest/v1/items','apikey':key},
                                {'apikey':expected,'authorization':'Bearer '+expected})

    def test_missing_foreign_or_malformed_api_keys_rejected(self):
        for key in (None, '', 'sb_publishable_foreign', 'sb_secret_foreign', USER, '${FOREIGN}', 'a\nb'):
            with self.subTest(key=key):
                headers={':path':'/rest/v1/items'}
                if key is not None: headers['apikey']=key
                self.run_filter('rest', headers, {}, '401')

    def test_conflicting_duplicate_empty_and_encoded_query_keys_rejected(self):
        for query in ('apikey='+TOKENS['SECRET_KEY'],
                      'apikey='+TOKENS['PUBLISHABLE_KEY']+'&apikey='+TOKENS['PUBLISHABLE_KEY'],
                      'apikey=', 'apikey=%73b_publishable_foreign', '%61pikey=foreign'):
            with self.subTest(query=query):
                self.run_filter('realtime', {':path':'/realtime/v1/websocket?'+query,
                                           'apikey':TOKENS['PUBLISHABLE_KEY']}, {}, '401')

    def test_malformed_authorization_rejected_instead_of_anon_fallback(self):
        for authorization in ('Basic password', 'Bearer ', 'Bearer bad', 'Bearer a.b.c\ninjected'):
            with self.subTest(authorization=authorization):
                self.run_filter('rest', {':path':'/rest/v1/items','apikey':TOKENS['PUBLISHABLE_KEY'],
                                       'authorization':authorization}, {}, '401')

    def test_auth_mail_verification_and_health_routes_do_not_require_api_key(self):
        for route in ('auth-verify', 'auth-health'):
            self.run_filter(route, {':path':'/auth/v1/verify?token=local'}, {'apikey':None,'authorization':None})

    def test_unmatched_routes_cannot_expose_excluded_services(self):
        for path in ('/','/storage/v1/','/functions/v1/','/realtime/v1/api/tenants','/pg/'):
            with self.subTest(path=path):
                self.run_filter('unmatched', {':path':path,'apikey':TOKENS['SECRET_KEY']}, {}, '404')


if __name__ == '__main__':
    unittest.main()
