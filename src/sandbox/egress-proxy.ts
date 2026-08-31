import { BlockList, isIP } from 'node:net';

// 代理按“全球可路由”做 deny 为默认的黑名单：覆盖私网、loopback、链路本地、CGNAT、文档与测试网段、
// 组播及保留地址（RFC 1918/5735/5737/4193 等），并包含 IPv4/IPv6 映射、NAT64、Teredo/6to4 特殊前缀，
// 避免借映射地址绕过对私网回环的封锁。
const RESERVED_IPV4_SUBNETS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const;

const RESERVED_IPV6_SUBNETS = [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const;

export function isPublicEgressAddress(value: string): boolean {
  const family = isIP(value);
  if (!family) return false;
  const blocked = egressBlockLists();
  return family === 4
    ? !blocked.ipv4.check(value, 'ipv4')
    : !blocked.ipv6.check(value, 'ipv6');
}

function egressBlockLists(): { ipv4: BlockList; ipv6: BlockList } {
  const ipv4 = new BlockList();
  const ipv6 = new BlockList();
  for (const [address, prefix] of RESERVED_IPV4_SUBNETS) ipv4.addSubnet(address, prefix, 'ipv4');
  for (const [address, prefix] of RESERVED_IPV6_SUBNETS) ipv6.addSubnet(address, prefix, 'ipv6');
  return { ipv4, ipv6 };
}

// 这段代理源码以 sidecar 方式挂载进容器运行（见 prepareAllowedNetwork），是工作负载唯一的出口。
// 默认 deny：只有 hostname 命中 allowlist、端口命中且解析结果非私网才放行，其余请求统一返回 403 并断开连接。
export const EGRESS_PROXY_SOURCE = String.raw`
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { domainToASCII } from 'node:url';

const policy = JSON.parse(await readFile(process.argv[2], 'utf8'));
const domains = new Set(policy.allowedDomains.map(normalizeDomain));
const ports = new Set(policy.allowedPorts.map(Number));
const blockedIpv4 = new net.BlockList();
const blockedIpv6 = new net.BlockList();
for (const [address, prefix] of ${JSON.stringify(RESERVED_IPV4_SUBNETS)}) blockedIpv4.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of ${JSON.stringify(RESERVED_IPV6_SUBNETS)}) blockedIpv6.addSubnet(address, prefix, 'ipv6');

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

// hostname 必须命中 allowlist 且端口在 allowlist 内，二者同时满足才可能放行。
  // 再对域名做 DNS 解析并只接受“存在一个非私网解析结果”：若域名同时解析回内网/私网地址则整体拒绝，
  // 防止 DNS 重绑定或“域名在 allowlist 但实际解析回内网”绕过私网封锁。
async function authorize(rawHostname, port) {
  const hostname = normalizeDomain(rawHostname);
  if (!domains.has(hostname) || !ports.has(port)) throw new Error('target denied');
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  const allowed = addresses.find((entry) => !isPrivateAddress(entry.address));
  if (!allowed) throw new Error('address denied');
  return allowed.address;
}

// CONNECT 请求的 authority 为 host:port；从最后一个冒号拆分，兼容 [ipv6]:port 的方括号写法。
function parseAuthority(value) {
  const separator = value.lastIndexOf(':');
  if (separator <= 0) throw new Error('invalid authority');
  const hostname = value.slice(0, separator).replace(/^\[/u, '').replace(/\]$/u, '');
  const port = Number(value.slice(separator + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
  return { hostname, port };
}

function normalizeDomain(value) {
  // 域名先做 ASCII/punycode 规范化并去末尾点；拒绝纯 IP 字面量，否则请求方可用 IP 形式绕过域名 allowlist。
  const normalized = domainToASCII(String(value).trim().toLowerCase().replace(/\.$/u, ''));
  if (!normalized || net.isIP(normalized)) throw new Error('invalid domain');
  return normalized;
}

function isPrivateAddress(value) {
  // 与主机的 isPublicEgressAddress 共用一个保留网段表；非 IP 字面量视为不可路由（拒绝）。
  const family = net.isIP(value);
  if (!family) return true;
  return family === 4
    ? blockedIpv4.check(value, 'ipv4')
    : blockedIpv6.check(value, 'ipv6');
}
`;
