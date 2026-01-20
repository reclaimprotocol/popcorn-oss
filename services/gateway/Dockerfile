FROM openresty/openresty:alpine

# Install redis-lua
# perl and curl are required for opm
RUN apk add --no-cache perl curl
RUN opm get openresty/lua-resty-redis
RUN opm get SkyLothar/lua-resty-jwt
RUN sed -i 's/EVP_MD_CTX_create/EVP_MD_CTX_new/g' /usr/local/openresty/site/lualib/resty/evp.lua && \
    sed -i 's/EVP_MD_CTX_destroy/EVP_MD_CTX_free/g' /usr/local/openresty/site/lualib/resty/evp.lua

# Copy Public Key for Auth
COPY keys/public.pem /etc/nginx/certs/public.pem

# Copy Auth Lib
COPY auth.lua /usr/local/openresty/lualib/auth.lua

# Copy configuration
COPY nginx.conf /usr/local/openresty/nginx/conf/nginx.conf

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Start with custom entrypoint
ENTRYPOINT ["/entrypoint.sh"]
