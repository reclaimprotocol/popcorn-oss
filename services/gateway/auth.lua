local jwt = require "resty.jwt"
local _M = {}

-- Load Public Key
local public_key_path = "/etc/nginx/certs/public.pem"
local f = io.open(public_key_path, "rb")
local public_key = ""
if f then
    public_key = f:read("*all")
    f:close()
else
    ngx.log(ngx.ERR, "Failed to load public key from " .. public_key_path)
end

function _M.check(bypass_assets, token_arg)
    -- bypass_assets: boolean
    -- token_arg: string (optional, from path)

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

    local jwt_obj = jwt:verify(public_key, token)
    if not jwt_obj.verified then
        ngx.log(ngx.WARN, "Auth: Invalid token: " .. (jwt_obj.reason or "unknown"))
        return ngx.exit(403)
    end
    
    -- Valid
end

return _M
