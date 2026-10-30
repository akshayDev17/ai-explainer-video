import net from 'node:net';

export function ping(host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, host, () => { s.end(); resolve(true); });
    s.on('error', reject);
  });
}
