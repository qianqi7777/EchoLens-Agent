export const EGRESS_PROXY_SOURCE = String.raw`
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { domainToASCII } from 'node:url';

const policy = JSON.parse(await readFile(process.argv[2], 'utf8'));
const domains = new Set(policy.allowedDomains.map(normalizeDomain));
const ports = new Set(policy.allowedPorts.map(Number));

const server = http.createServer(async (request, response) => {
  try {
    if (!request.url) throw new Error('missing url');
    const target = new URL(request.url);
    if (target.protocol !== 'http:') throw new Error('unsupported protocol');
    const port = Number(target.port || 80);
    const resolved = await authorize(target.hostname, port);
    const upstream = http.request({
      host: resolved,
      port,
      method: request.method,
      path: target.pathname + target.search,
      headers: { ...request.headers, host: target.host, 'proxy-authorization': undefined },
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on('error', () => response.destroy());
    request.pipe(upstream);
  } catch {
    response.writeHead(403, { connection: 'close' });
    response.end('proxy denied');
  }
});

server.on('connect', async (request, client, head) => {
  try {
    const parsed = parseAuthority(request.url || '');
    const resolved = await authorize(parsed.hostname, parsed.port);
    const upstream = net.connect({ host: resolved, port: parsed.port });
    upstream.setTimeout(30_000, () => upstream.destroy());
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on('error', () => client.destroy());
  } catch {
    client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  }
});

server.maxConnections = 64;
server.listen(3128, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));

async function authorize(rawHostname, port) {
  const hostname = normalizeDomain(rawHostname);
  if (!domains.has(hostname) || !ports.has(port)) throw new Error('target denied');
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  const allowed = addresses.find((entry) => !isPrivateAddress(entry.address));
  if (!allowed) throw new Error('address denied');
  return allowed.address;
}

function parseAuthority(value) {
  const separator = value.lastIndexOf(':');
  if (separator <= 0) throw new Error('invalid authority');
  const hostname = value.slice(0, separator).replace(/^\[/u, '').replace(/\]$/u, '');
  const port = Number(value.slice(separator + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
  return { hostname, port };
}

function normalizeDomain(value) {
  const normalized = domainToASCII(String(value).trim().toLowerCase().replace(/\.$/u, ''));
  if (!normalized || net.isIP(normalized)) throw new Error('invalid domain');
  return normalized;
}

function isPrivateAddress(value) {
  if (net.isIPv4(value)) {
    const octets = value.split('.').map(Number);
    const first = octets[0];
    const second = octets[1];
    return first === 0 || first === 10 || first === 127 || first >= 224
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && (second === 0 || second === 168))
      || (first === 198 && (second === 18 || second === 19));
  }
  if (net.isIPv6(value)) {
    const lower = value.toLowerCase();
    if (lower === '::' || lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (/^fe[89ab]/u.test(lower)) return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
    return mapped ? isPrivateAddress(mapped) : false;
  }
  return true;
}
`;
