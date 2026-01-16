#!/bin/sh

# Extract the nameserver IP from /etc/resolv.conf
# It typically looks like "nameserver 10.96.0.10"
NS=$(grep nameserver /etc/resolv.conf | head -n 1 | awk '{print $2}')

if [ -z "$NS" ]; then
    echo "⚠️  Could not detect nameserver from /etc/resolv.conf, using fallback 10.96.0.10"
    NS="10.96.0.10"
else
    echo "🌍 Detected K8s DNS Resolver: $NS"
fi

# Inject into nginx.conf
sed -i "s/RESOLVER_IP/$NS/g" /usr/local/openresty/nginx/conf/nginx.conf

# Start OpenResty
exec /usr/local/openresty/bin/openresty -g "daemon off;"
