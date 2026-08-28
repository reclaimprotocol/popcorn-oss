import crypto from 'crypto';

/**
 * Minimal AWS SESv2 SendEmail client (SigV4, no SDK).
 *
 * Credentials are resolved through the standard chain, so this works on a
 * developer laptop and on EKS with IRSA:
 *   1. AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (+ optional session token)
 *   2. IRSA: AWS_WEB_IDENTITY_TOKEN_FILE + AWS_ROLE_ARN via
 *      sts:AssumeRoleWithWebIdentity
 *   3. ECS/EKS container credentials endpoint
 * Resolved temporary credentials are cached until shortly before expiry.
 */

export type SesConfig = {
  region: string;
  fromAddress: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  endpoint?: string;
};

export type ResolvedCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiresAt: number | null;
};

let cachedCredentials: ResolvedCredentials | null = null;

export function __resetCredentialCache(): void {
  cachedCredentials = null;
}

/** Parse an STS AssumeRoleWithWebIdentity XML response. */
export function parseStsResponse(xml: string): ResolvedCredentials {
  const pick = (tag: string) => xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? '';
  const accessKeyId = pick('AccessKeyId');
  const secretAccessKey = pick('SecretAccessKey');
  const sessionToken = pick('SessionToken');
  const expiration = pick('Expiration');
  if (!accessKeyId || !secretAccessKey) throw new Error('STS response did not contain credentials');
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken,
    expiresAt: expiration ? Date.parse(expiration) : null,
  };
}

async function assumeRoleWithWebIdentity(env: NodeJS.ProcessEnv): Promise<ResolvedCredentials> {
  const tokenFile = env.AWS_WEB_IDENTITY_TOKEN_FILE!;
  const roleArn = env.AWS_ROLE_ARN!;
  const token = (await Bun.file(tokenFile).text()).trim();
  const params = new URLSearchParams({
    Action: 'AssumeRoleWithWebIdentity',
    Version: '2011-06-15',
    RoleArn: roleArn,
    RoleSessionName: (env.AWS_ROLE_SESSION_NAME ?? 'popcorn-mcp-server').slice(0, 64),
    WebIdentityToken: token,
  });
  const region = (env.AWS_REGION ?? 'us-east-1').trim();
  const response = await fetch(`https://sts.${region}.amazonaws.com/?${params.toString()}`, { method: 'GET' });
  const body = await response.text();
  if (!response.ok) throw new Error(`sts:AssumeRoleWithWebIdentity failed (${response.status}): ${body.slice(0, 200)}`);
  return parseStsResponse(body);
}

async function containerCredentials(env: NodeJS.ProcessEnv): Promise<ResolvedCredentials> {
  const relative = env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  const full = env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  const url = full ?? `http://169.254.170.2${relative}`;
  const response = await fetch(url, {
    headers: env.AWS_CONTAINER_AUTHORIZATION_TOKEN ? { authorization: env.AWS_CONTAINER_AUTHORIZATION_TOKEN } : {},
  });
  if (!response.ok) throw new Error(`container credential endpoint failed (${response.status})`);
  const body = (await response.json()) as any;
  return {
    accessKeyId: body.AccessKeyId,
    secretAccessKey: body.SecretAccessKey,
    sessionToken: body.Token,
    expiresAt: body.Expiration ? Date.parse(body.Expiration) : null,
  };
}

/** Resolve credentials through the chain, caching temporary ones. */
export async function resolveCredentials(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): Promise<ResolvedCredentials> {
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: env.AWS_ACCESS_KEY_ID.trim(),
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY.trim(),
      sessionToken: env.AWS_SESSION_TOKEN?.trim() || undefined,
      expiresAt: null,
    };
  }
  if (cachedCredentials && (cachedCredentials.expiresAt === null || cachedCredentials.expiresAt - 60_000 > now)) {
    return cachedCredentials;
  }
  if (env.AWS_WEB_IDENTITY_TOKEN_FILE && env.AWS_ROLE_ARN) {
    cachedCredentials = await assumeRoleWithWebIdentity(env);
    return cachedCredentials;
  }
  if (env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_CONTAINER_CREDENTIALS_FULL_URI) {
    cachedCredentials = await containerCredentials(env);
    return cachedCredentials;
  }
  throw new Error('no AWS credentials found (static keys, IRSA web identity, or container endpoint)');
}

export function readSesConfig(env: NodeJS.ProcessEnv = process.env): SesConfig {
  return {
    region: (env.AWS_REGION ?? 'us-east-1').trim(),
    fromAddress: (env.OTP_FROM_ADDRESS ?? 'noreply@reclaimprotocol.org').trim(),
    accessKeyId: (env.AWS_ACCESS_KEY_ID ?? '').trim(),
    secretAccessKey: (env.AWS_SECRET_ACCESS_KEY ?? '').trim(),
    sessionToken: env.AWS_SESSION_TOKEN?.trim() || undefined,
    endpoint: env.SES_ENDPOINT?.trim() || undefined,
  };
}

function hmac(key: crypto.BinaryLike | Buffer, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string): string {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

/** Exported for tests: builds the Authorization header for a signed request. */
export function signRequest(params: {
  config: SesConfig;
  method: string;
  host: string;
  path: string;
  payload: string;
  now: Date;
}): { authorization: string; amzDate: string } {
  const { config, method, host, path, payload, now } = params;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(payload);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (config.sessionToken) headers['x-amz-security-token'] = config.sessionToken;

  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name]}\n`)
    .join('');
  const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${config.region}/ses/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region), 'ses'), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return {
    amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export async function sendEmail(params: {
  config: SesConfig;
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  const { config } = params;
  const credentials = await resolveCredentials();
  const signingConfig: SesConfig = { ...config, ...credentials };
  const host = new URL(config.endpoint ?? `https://email.${config.region}.amazonaws.com`).host;
  const path = '/v2/email/outbound-emails';
  const payload = JSON.stringify({
    FromEmailAddress: config.fromAddress,
    Destination: { ToAddresses: [params.to] },
    Content: {
      Simple: {
        Subject: { Data: params.subject, Charset: 'UTF-8' },
        Body: {
          Text: { Data: params.text, Charset: 'UTF-8' },
          Html: { Data: params.html, Charset: 'UTF-8' },
        },
      },
    },
  });

  const signed = signRequest({ config: signingConfig, method: 'POST', host, path, payload, now: new Date() });
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    host,
    'x-amz-content-sha256': sha256Hex(payload),
    'x-amz-date': signed.amzDate,
    authorization: signed.authorization,
  };
  if (signingConfig.sessionToken) headers['x-amz-security-token'] = signingConfig.sessionToken;

  const response = await fetch(`https://${host}${path}`, { method: 'POST', headers, body: payload });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`SES send failed (${response.status}): ${detail.slice(0, 300)}`);
  }
}
