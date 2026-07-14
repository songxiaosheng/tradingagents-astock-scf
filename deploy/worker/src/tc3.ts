const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function hmac(key: BufferSource, value: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value));
}

export interface TencentRequest {
  authorization: string;
  body: string;
  headers: Record<string, string>;
}

export async function signTencentRequest(options: {
  action: string;
  payload: Record<string, unknown>;
  region: string;
  secretId: string;
  secretKey: string;
  timestamp?: number;
}): Promise<TencentRequest> {
  const service = "scf";
  const host = "scf.tencentcloudapi.com";
  const contentType = "application/json; charset=utf-8";
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const body = JSON.stringify(options.payload);

  const canonicalHeaders = [
    `content-type:${contentType}`,
    `host:${host}`,
    `x-tc-action:${options.action.toLowerCase()}`,
    "",
  ].join("\n");
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    await sha256Hex(body),
  ].join("\n");

  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    "TC3-HMAC-SHA256",
    String(timestamp),
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const secretDate = await hmac(encoder.encode(`TC3${options.secretKey}`), date);
  const secretService = await hmac(secretDate, service);
  const secretSigning = await hmac(secretService, "tc3_request");
  const signature = toHex(await hmac(secretSigning, stringToSign));
  const authorization = [
    `TC3-HMAC-SHA256 Credential=${options.secretId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(", ");

  return {
    authorization,
    body,
    headers: {
      Authorization: authorization,
      "Content-Type": contentType,
      Host: host,
      "X-TC-Action": options.action,
      "X-TC-Region": options.region,
      "X-TC-Timestamp": String(timestamp),
      "X-TC-Version": "2018-04-16",
    },
  };
}
