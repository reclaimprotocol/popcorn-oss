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

load_public_key()

function _M.check(bypass_assets, token_arg, required_scope)
    -- bypass_assets: boolean
    -- token_arg: string (optional, from path)
    -- required_scope: string (optional, "internal" for restricted endpoints)

    if bypass_assets then
        local rest_uri = ngx.var.rest_uri
        local is_root = (rest_uri == "" or rest_uri == "/")

        local upgrade = ngx.req.get_headers()["Upgrade"]
        local is_ws = (upgrade and string.lower(upgrade) == "websocket")

        if not (is_root or is_ws) then
            return -- Bypass Auth for assets
        end
    end

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

    local jwt_obj = jwt:verify(key, token)
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

    -- Valid
end

return _M
