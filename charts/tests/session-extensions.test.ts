import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const fixture = Bun.YAML.parse(readFileSync(resolve(root, "services/gateway/tests/fixtures/session-extension-values.yaml"), "utf8")) as any;

function render(chart: string, values = structuredClone(fixture)) {
  const result = Bun.spawnSync(["helm", "template", "test", `charts/${chart}`, "--values", "-"], {
    cwd: root, stdin: Buffer.from(JSON.stringify(values)), stdout: "pipe", stderr: "pipe",
  });
  return { code: result.exitCode, error: result.stderr.toString(), output: result.stdout.toString() };
}

function documents(chart: string, values = structuredClone(fixture)) {
  const result = render(chart, values);
  expect(result.code, result.error).toBe(0);
  return result.output.split(/^---\s*$/m).filter(value => value.trim()).map(value => Bun.YAML.parse(value) as any);
}

function routes(values: any) {
  return documents("platform", values).find(doc => doc.kind === "ConfigMap" && doc.data?.["session-extension-routes.conf"]).data["session-extension-routes.conf"] as string;
}

describe("extension gateway routes", () => {
  for (const key of ["browser_events", "BrowserEvents", "123events", "_events"]) {
    for (const enabled of [false, true]) {
      test(`preserves route key ${key}, gateway identity ${enabled}`, () => {
        const values = structuredClone(fixture);
        const routing = values.sessionExtensions.test.routing;
        routing.routeKey = key;
        routing.gatewayIdentity = enabled;
        for (const route of routing.gatewayRoutes) route.routeKey = key;
        const config = routes(values);
        expect(config).toContain(`local route_key = "${key}"`);
        expect(config.includes("auth.forward_identity(identity)")).toBe(enabled);
      });
    }
  }

  for (const prefix of ["browser", "browser-events", "events.*"]) {
    test(`rejects unsafe URL prefix ${prefix}`, () => {
      const values = structuredClone(fixture);
      values.sessionExtensions.test.routing.gatewayRoutes[0].pathPrefix = prefix;
      const result = render("platform", values);
      expect(result.code).not.toBe(0);
      expect(result.error).toContain(prefix.startsWith("browser") ? "extension pathPrefix conflicts" : "extension gateway pathPrefix must");
    });
  }

  test("requires an explicit scope for forwarded identity", () => {
    const values = structuredClone(fixture);
    delete values.sessionExtensions.test.routing.gatewayRoutes[0].tokenScope;
    const result = render("platform", values);
    expect(result.code).not.toBe(0);
    expect(result.error).toContain("gatewayIdentity routes must require restricted or internal tokenScope");
  });
});

describe("extension ingress", () => {
  test("selects browser pods and allows only the gateway to reach identity-enabled ports", () => {
    const docs = documents("browser-fleet");
    const fleet = docs.find(doc => doc.kind === "Fleet");
    expect(fleet.spec.template.spec.template.metadata.labels.app).toBe("browser-runtime");
    const policy = docs.find(doc => doc.kind === "NetworkPolicy" && doc.metadata.name === "browser-runtime-ingress");
    const base = policy.spec.ingress.find((rule: any) => rule.from.some((peer: any) => peer.podSelector.matchLabels.app === "pool-manager"));
    expect(base.ports.some((port: any) => port.port === 4310)).toBe(false);
    expect(base.ports.some((port: any) => port.port === 9222)).toBe(true);
    const events = policy.spec.ingress.find((rule: any) => rule.ports.some((port: any) => port.port === 4310));
    expect(events.from).toHaveLength(1);
    expect(events.from[0].podSelector.matchLabels.app).toBe("gateway");
  });

  for (const mode of ["disabled policy", "host port", "built-in port"]) {
    test(`rejects ${mode} with gateway identity`, () => {
      const values = structuredClone(fixture);
      if (mode === "disabled policy") values.networkPolicy = { ingressEnabled: false };
      else if (mode === "host port") values.sessionExtensions.test.browser.ports[0].portPolicy = "Dynamic";
      else values.sessionExtensions.test.browser.ports[0].containerPort = 9222;
      const result = render("browser-fleet", values);
      expect(result.code).not.toBe(0);
      expect(result.error).toContain(mode === "disabled policy" ? "gatewayIdentity requires networkPolicy.ingressEnabled" : "gatewayIdentity extension ports must use portPolicy None");
    });
  }
});
