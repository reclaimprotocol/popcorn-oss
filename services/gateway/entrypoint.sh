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

# Use same-namespace cluster-local services by default, but allow Helm/env overrides.
POD_NAMESPACE="${POD_NAMESPACE:-default}"
GATEWAY_REDIS_HOST="${GATEWAY_REDIS_HOST:-redis.${POD_NAMESPACE}.svc.cluster.local}"
GATEWAY_POOL_MANAGER_HOST="${GATEWAY_POOL_MANAGER_HOST:-pool-manager.${POD_NAMESPACE}.svc.cluster.local}"

# Inject into nginx.conf
sed -i \
    -e "s|RESOLVER_IP|$RESOLVER_IP|g" \
    -e "s|GATEWAY_REDIS_HOST|$GATEWAY_REDIS_HOST|g" \
    -e "s|GATEWAY_POOL_MANAGER_HOST|$GATEWAY_POOL_MANAGER_HOST|g" \
    /usr/local/openresty/nginx/conf/nginx.conf

# Start OpenResty
exec /usr/local/openresty/bin/openresty -g "daemon off;"
