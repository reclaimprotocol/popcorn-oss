local jwt = require "resty.jwt"
local _M = {}

local public_key_path = "/etc/nginx/certs/public.pem"
local public_key = ""

local function load_public_key()
    if public_key ~= "" then
        return public_key
    end

    local f = io.open(public_key_path, "rb")
    if not f then
        ngx.log(ngx.ERR, "Failed to load public key from " .. public_key_path)
        return ""
    end

    public_key = f:read("*all") or ""
    f:close()

    if public_key == "" then
        ngx.log(ngx.ERR, "Public key file is empty at " .. public_key_path)
    end

    return public_key
end

local function is_supported_algorithm(jwt_obj)
    return jwt_obj ~= nil
        and jwt_obj.valid == true
        and jwt_obj.header ~= nil
        and jwt_obj.header.alg == "RS256"
end

local function check_route_bound_deadline(jwt_obj, expected_session_id)
    if jwt_obj.payload.routeBound ~= true then
        return true
    end
    if not expected_session_id then
        ngx.log(ngx.WARN, "Auth: Route-bound token used without a session")
        return false
    end

    local redis = require "resty.redis"
    local red = redis:new()
    red:set_timeout(1000)
    local ok, err = red:connect(ngx.var.gateway_redis_host, 6379)
    if not ok then
        ngx.log(ngx.ERR, "Auth: Failed to connect to route-bound access store: ", err)
        return nil
    end
    local deadline, read_err = red:get("auth:route-bound:" .. expected_session_id)
    red:set_keepalive(10000, 100)
    if read_err then
        ngx.log(ngx.ERR, "Auth: Failed to read route-bound deadline: ", read_err)
        return nil
    end
    if not deadline or deadline == ngx.null or tonumber(deadline) == nil then
        ngx.log(ngx.WARN, "Auth: Missing route-bound deadline")
        return false
    end
    return _M.is_route_bound_deadline_active(deadline, ngx.now() * 1000)
end

function _M.is_route_bound_deadline_active(deadline, now_ms)
    return tonumber(deadline) ~= nil and tonumber(deadline) > now_ms
end

_M.is_supported_algorithm = is_supported_algorithm

function _M.check(bypass_assets, token_arg, required_scope, expected_session_id)
    -- bypass_assets: boolean
    -- token_arg: string (optional, from path)
    -- required_scope: string (optional, "internal" for restricted endpoints)


    local token = token_arg
    if not token then
        token = ngx.req.get_uri_args()["token"]
    end

    if not token then
        ngx.log(ngx.WARN, "Auth: Missing token")
        return ngx.exit(403)
    end

    local key = load_public_key()
    if key == "" then
        ngx.log(ngx.ERR, "Auth: Missing public key")
        return ngx.exit(503)
    end

    -- Parse first and pin the asymmetric algorithm before the library sees the
    -- RSA public key. Without this check an HS256 token could treat that public
    -- key text as an HMAC secret (RS256 -> HS256 algorithm confusion).
    local jwt_obj = jwt:load_jwt(token)
    if not is_supported_algorithm(jwt_obj) then
        ngx.log(ngx.WARN, "Auth: Unsupported JWT algorithm")
        return ngx.exit(403)
    end

    jwt_obj = jwt:verify_jwt_obj(key, jwt_obj)
    if not jwt_obj.verified then
        ngx.log(ngx.WARN, "Auth: Invalid token: " .. (jwt_obj.reason or "unknown"))
        return ngx.exit(403)
    end

    -- Check scope if required
    if required_scope then
        local payload_scope = jwt_obj.payload.scope
        if not payload_scope or payload_scope ~= required_scope then
            ngx.log(ngx.WARN, "Auth: Insufficient scope - required: " .. required_scope .. ", got: " .. (payload_scope or "none"))
            return ngx.exit(403)
        end
    end

    if expected_session_id then
        local payload_sub = jwt_obj.payload.sub
        if tostring(payload_sub or "") ~= tostring(expected_session_id) then
            ngx.log(ngx.WARN, "Auth: Session mismatch - token sub: " .. (payload_sub or "none") .. ", expected: " .. expected_session_id)
            return ngx.exit(403)
        end
    end

    local route_bound_active = check_route_bound_deadline(jwt_obj, expected_session_id)
    if route_bound_active == nil then
        return ngx.exit(503)
    end
    if not route_bound_active then
        ngx.log(ngx.WARN, "Auth: Route-bound access expired")
        return ngx.exit(403)
    end

    if bypass_assets then
        local rest_uri = ngx.var.rest_uri
        local is_root = (rest_uri == "" or rest_uri == "/")

        local upgrade = ngx.req.get_headers()["Upgrade"]
        local is_ws = (upgrade and string.lower(upgrade) == "websocket")

        if not (is_root or is_ws) then
            return -- Bypass additional browser root/WebSocket auth checks for assets after token/session validation
        end
    end

    -- Valid
end

return _M
