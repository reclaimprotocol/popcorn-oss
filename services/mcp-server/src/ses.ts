import crypto from 'crypto';

/**
 * Minimal AWS SESv2 SendEmail client (SigV4, no SDK).
 *
 * Credentials come from the standard environment: AWS_ACCESS_KEY_ID,
 * AWS_SECRET_ACCESS_KEY, optional AWS_SESSION_TOKEN — so IRSA / instance roles
 * work unchanged in the cluster.
 */

export type SesConfig = {
  region: string;
  fromAddress: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  endpoint?: string;
};

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
  if (!config.accessKeyId || !config.secretAccessKey) {
    throw new Error('AWS credentials are not configured; cannot send the sign-in code');
  }
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

  const signed = signRequest({ config, method: 'POST', host, path, payload, now: new Date() });
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    host,
    'x-amz-content-sha256': sha256Hex(payload),
    'x-amz-date': signed.amzDate,
    authorization: signed.authorization,
  };
  if (config.sessionToken) headers['x-amz-security-token'] = config.sessionToken;

  const response = await fetch(`https://${host}${path}`, { method: 'POST', headers, body: payload });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`SES send failed (${response.status}): ${detail.slice(0, 300)}`);
  }
}
