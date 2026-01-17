#!/bin/sh

# If RESOLVER_IP is not passed as env var, try to detect it
if [ -z "$RESOLVER_IP" ]; then
    # Extract the nameserver IP from /etc/resolv.conf
    # It typically looks like "nameserver 10.96.0.10"
    NS=$(grep nameserver /etc/resolv.conf | head -n 1 | awk '{print $2}')

    if [ -z "$NS" ]; then
        echo "⚠️  Could not detect nameserver from /etc/resolv.conf, using fallback 10.96.0.10"
        RESOLVER_IP="10.96.0.10"
    else
        echo "🌍 Detected K8s DNS Resolver from /etc/resolv.conf: $NS"
        RESOLVER_IP="$NS"
    fi
else
    echo "🔧 Using provided RESOLVER_IP: $RESOLVER_IP"
fi

# Use RESOLVER_IP variable in sed
NS=$RESOLVER_IP

# Inject into nginx.conf
sed -i "s/RESOLVER_IP/$NS/g" /usr/local/openresty/nginx/conf/nginx.conf

# Start OpenResty
exec /usr/local/openresty/bin/openresty -g "daemon off;"
