import net from 'node:net';
import tls from 'node:tls';

const [hostname, expected, requestPath = '/'] = process.argv.slice(2);
if (!hostname || !['allow', 'deny'].includes(expected)) process.exit(2);

const proxy = net.connect({ host: 'egress-proxy', port: 3128 });
proxy.setTimeout(15_000, () => proxy.destroy(new Error('proxy timeout')));
proxy.once('connect', () => {
  proxy.write(`CONNECT ${hostname}:443 HTTP/1.1\r\nHost: ${hostname}:443\r\nConnection: close\r\n\r\n`);
});

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
  if (expected === 'deny') process.exit(status === 403 ? 0 : 1);
  if (status !== 200) process.exit(1);
  const secure = tls.connect({ socket: proxy, servername: hostname });
  secure.setTimeout(15_000, () => secure.destroy(new Error('tls timeout')));
  secure.once('secureConnect', () => {
    secure.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`);
  });
  let response = '';
  secure.on('data', (value) => { if (response.length < 4096) response += value.toString('utf8'); });
  secure.once('end', () => {
    const code = Number(response.split('\r\n')[0]?.split(' ')[1]);
    process.exit(code >= 200 && code < 500 ? 0 : 1);
  });
  secure.once('error', fail);
}

function fail() {
  process.exit(1);
}
