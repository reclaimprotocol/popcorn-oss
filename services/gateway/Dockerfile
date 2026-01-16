FROM openresty/openresty:alpine

# Install redis-lua
# perl and curl are required for opm
RUN apk add --no-cache perl curl
RUN opm get openresty/lua-resty-redis

# Copy configuration
COPY nginx.conf /usr/local/openresty/nginx/conf/nginx.conf

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Start with custom entrypoint
ENTRYPOINT ["/entrypoint.sh"]
