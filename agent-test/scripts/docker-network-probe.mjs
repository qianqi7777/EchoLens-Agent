// Docker 沙箱网络探测：验证容器内请求经 egress-proxy 的放行/拒绝行为。
// 用法：node docker-network-probe.mjs <hostname> allow|deny [path]
// allow 模式要求 CONNECT 200 且 TLS 后 HTTP 请求返回 4xx 以下状态（说明真的打通了）；
// deny 模式只要求代理返回 403（说明规则确实拦住了目标域名）。
import net from 'node:net';
import tls from 'node:tls';

const [hostname, expected, requestPath = '/'] = process.argv.slice(2);
if (!hostname || !['allow', 'deny'].includes(expected)) process.exit(2);

// 直连代理端口发送明文 CONNECT：这是代理协议的隧道协商，不是目标站点的 TLS 流量。
const proxy = net.connect({ host: 'egress-proxy', port: 3128 });
proxy.setTimeout(15_000, () => proxy.destroy(new Error('proxy timeout')));
proxy.once('connect', () => {
  proxy.write(`CONNECT ${hostname}:443 HTTP/1.1\r\nHost: ${hostname}:443\r\nConnection: close\r\n\r\n`);
});

// 只缓冲到代理响应头结束（\r\n\r\n），后续字节都归 TLS 层处理，不能混进 HTTP 头解析。
let header = Buffer.alloc(0);
proxy.on('data', onProxyData);
proxy.once('error', fail);

function onProxyData(chunk) {
  header = Buffer.concat([header, chunk]);
  const boundary = header.indexOf('\r\n\r\n');
  if (boundary < 0) return;
  proxy.off('data', onProxyData);
  const statusLine = header.subarray(0, boundary).toString('ascii').split('\r\n')[0] ?? '';
  const status = Number(statusLine.split(' ')[1]);
  // deny 用例只关心代理拒绝；任何非 403 结果都说明拒绝规则失效，直接失败退出。
  if (expected === 'deny') process.exit(status === 403 ? 0 : 1);
  if (status !== 200) process.exit(1);
  // CONNECT 成功后在已有 socket 之上建立 TLS：servername 必须保留，SNI 是代理按域名放行的依据。
  const secure = tls.connect({ socket: proxy, servername: hostname });
  secure.setTimeout(15_000, () => secure.destroy(new Error('tls timeout')));
  secure.once('secureConnect', () => {
    secure.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`);
  });
  let response = '';
  // 只保留前 4096 字节：探针只需状态行，防止大响应耗尽容器内存。
  secure.on('data', (value) => { if (response.length < 4096) response += value.toString('utf8'); });
  secure.once('end', () => {
    const code = Number(response.split('\r\n')[0]?.split(' ')[1]);
    // 4xx/5xx 也算连通成功：探针验证的是“能到达目标”，不是目标返回了 200。
    process.exit(code >= 200 && code < 500 ? 0 : 1);
  });
  secure.once('error', fail);
}

function fail() {
  process.exit(1);
}
