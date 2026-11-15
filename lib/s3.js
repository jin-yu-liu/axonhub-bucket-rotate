// S3 ListObjectsV2 with AWS SigV4 (works with AWS S3, Cloudflare R2, MinIO, Aliyun OSS, Tencent COS, ...).
import { hex, hmac, sha256 } from "./crypto.js";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** RFC 3986 encoding used by SigV4. */
export function awsEncode(s, keepSlash) {
  let out = encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  if (keepSlash) out = out.replace(/%2F/g, "/");
  return out;
}

function pad(n) {
  return (n < 10 ? "0" : "") + n;
}

export function amzDate(d) {
  return (
    d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + "T" +
    pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + "Z"
  );
}

/** Split an endpoint like "https://xxx.r2.cloudflarestorage.com" into scheme and host. */
export function parseEndpoint(endpoint, region) {
  let ep = String(endpoint || "").trim();
  if (!ep) ep = "https://s3." + (region || "us-east-1") + ".amazonaws.com";
  if (ep.indexOf("://") < 0) ep = "https://" + ep;
  const m = /^(https?):\/\/([^/?#]+)/i.exec(ep);
  if (!m) throw new Error("invalid S3 endpoint: " + endpoint);
  return { scheme: m[1].toLowerCase(), host: m[2].toLowerCase() };
}

/**
 * Build a signed ListObjectsV2 GET request.
 * s3: { endpoint, region, bucket, accessKeyId, secretAccessKey, pathStyle }
 * Returns { url, headers }.
 */
export function signedListRequest(s3, params, now) {
  const region = s3.region || "us-east-1";
  const ep = parseEndpoint(s3.endpoint, region);
  const pathStyle = s3.pathStyle !== false;
  const host = pathStyle ? ep.host : s3.bucket + "." + ep.host;
  const path = pathStyle ? "/" + s3.bucket : "/";
  const keys = Object.keys(params).sort();
  const query = keys.map((k) => awsEncode(k) + "=" + awsEncode(String(params[k]))).join("&");
  const date = amzDate(now);
  const day = date.slice(0, 8);
  const canonicalPath = awsEncode(path, true);
  const canonicalHeaders = "host:" + host + "\nx-amz-content-sha256:" + EMPTY_SHA256 + "\nx-amz-date:" + date + "\n";
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonical = ["GET", canonicalPath, query, canonicalHeaders, signedHeaders, EMPTY_SHA256].join("\n");
  const scope = day + "/" + region + "/s3/aws4_request";
  const toSign = ["AWS4-HMAC-SHA256", date, scope, hex(sha256(canonical))].join("\n");
  let k = hmac("AWS4" + s3.secretAccessKey, day);
  k = hmac(k, region);
  k = hmac(k, "s3");
  k = hmac(k, "aws4_request");
  const signature = hex(hmac(k, toSign));
  return {
    url: ep.scheme + "://" + host + canonicalPath + "?" + query,
    headers: {
      Authorization:
        "AWS4-HMAC-SHA256 Credential=" + s3.accessKeyId + "/" + scope +
        ", SignedHeaders=" + signedHeaders + ", Signature=" + signature,
      "x-amz-date": date,
      "x-amz-content-sha256": EMPTY_SHA256,
    },
  };
}

function xmlUnescape(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

/** Parse one ListObjectsV2 page: { bytes, objects, truncated, token }. */
export function parseListPage(xml) {
  let bytes = 0;
  let objects = 0;
  const contents = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m;
  while ((m = contents.exec(xml)) !== null) {
    const size = /<Size>(\d+)<\/Size>/.exec(m[1]);
    bytes += size ? Number(size[1]) : 0;
    objects++;
  }
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
  const tok = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
  return { bytes, objects, truncated, token: tok ? xmlUnescape(tok[1]) : null };
}

/** Short error text from an S3 XML error body; never includes credentials. */
export function s3ErrorText(status, body) {
  const code = /<Code>([^<]*)<\/Code>/.exec(body || "");
  return "HTTP " + status + (code ? " " + code[1] : "");
}
