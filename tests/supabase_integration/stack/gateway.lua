-- Adapted from the pinned Supabase Envoy key filters; see PROVENANCE.md.
-- Signature/expiry/issuer verification remains Auth/PostgREST/Realtime's job.
local publishable = "@PUBLISHABLE_KEY@"
local secret = "@SECRET_KEY@"
local anon = "@ANON_JWT@"
local service = "@SERVICE_JWT@"
local public_routes = { ["auth-verify"] = true, ["auth-health"] = true }
local protected_routes = { auth = true, rest = true, realtime = true }

local function translate(key)
  if key == publishable then return anon end
  if key == secret then return service end
  if key == anon or key == service then return key end
  return nil
end

local function reject(handle, status)
  handle:respond({ [":status"] = status, ["content-type"] = "text/plain" }, "Rejected")
end

function envoy_on_request(handle)
  local route = handle:streamInfo():routeName()
  if public_routes[route] then return end
  if not protected_routes[route] then reject(handle, "404"); return end
  local headers = handle:headers()
  local path = headers:get(":path") or ""
  local start = string.find(path, "?", 1, true)
  local parts, query_key = {}, nil
  if start then
    for part in string.gmatch(string.sub(path, start + 1), "[^&]+") do
      local key, value = string.match(part, "^([^=]+)=(.*)$")
      if key == "apikey" then
        -- Duplicate/encoded/empty keys fail closed. Valid generated keys are URL safe.
        if query_key ~= nil or value == "" or string.find(value, "%%") then
          reject(handle, "401"); return
        end
        query_key = value
      elseif string.find(part, "%%") and string.find(part, "=", 1, true) then
        -- Do not let an encoded parameter name become another apikey downstream.
        local name = string.match(part, "^([^=]+)=")
        if string.find(name, "%%") then reject(handle, "401"); return end
      end
      table.insert(parts, part)
    end
  end
  local header_key = headers:get("apikey")
  if header_key and query_key and header_key ~= query_key then
    reject(handle, "401"); return
  end
  local key = header_key or query_key
  local translated = translate(key)
  if not translated then reject(handle, "401"); return end
  local authorization = headers:get("authorization")
  if authorization then
    local bearer = string.match(authorization, "^Bearer (.+)$")
    if not bearer then reject(handle, "401"); return end
    if string.sub(bearer, 1, 3) == "sb_" then
      if bearer ~= key then reject(handle, "401"); return end
      headers:replace("authorization", "Bearer " .. translated)
    else
      -- Preserve the caller's JWT, including a bad signature: the backend must
      -- reject it, never silently downgrade an invalid user JWT to anonymous.
      if not string.match(bearer, "^[%w_-]+%.[%w_-]+%.[%w_-]+$") then
        reject(handle, "401"); return
      end
    end
  elseif route ~= "realtime" then
    headers:replace("authorization", "Bearer " .. translated)
  end
  headers:replace("apikey", translated)
  if query_key then
    for i, part in ipairs(parts) do
      if string.sub(part, 1, 7) == "apikey=" then parts[i] = "apikey=" .. translated end
    end
    headers:replace(":path", string.sub(path, 1, start) .. table.concat(parts, "&"))
  end
  if route == "realtime" then headers:replace("x-api-key", translated) end
end
