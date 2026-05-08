const coiHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

addEventListener('install', () => skipWaiting());
addEventListener('activate', e => e.waitUntil(clients.claim()));

addEventListener('fetch', function(event) {
  let { request } = event;
  // 'blank.html' resolves for all paths.
  // We use this to run scripts containing a dynamic import on a synthetic page which has the right URL to serve its depedencies.
  if (/blank\.html$/.test(request.url)) {
    event.respondWith(Promise.resolve(new Response(
      `<!doctype html><meta charset=utf-8><title>realm</title>`,
      {
        headers: {
          'Content-Type': 'text/html',
          ...coiHeaders,
        }
      }
    )));
    return;
  }

  if (/\/SYNTHETIC\//.test(request.url)) {
    event.respondWith(async function() {
      const client = await clients.get(event.clientId);
      const chan = new MessageChannel();

      let resolve, reject;
      const rv = new Promise((res, rej) => {
        resolve = res; reject = rej;
      });
      setTimeout(() => reject('timed out'), 2000);

      chan.port1.onmessage = e => {
        if (!e.data.success) {
          reject('not found');
          return;
        }
        let text = e.data.data;
        if (/blank.html$/.test(request.referrer)) {
          text += '\n;$$testFinished();'; // This is such a hack...
        }
        resolve(new Response(text, {
          headers: {
            'Content-Type': 'application/javascript',
            ...coiHeaders,
          }
        }));
      };
      client.postMessage(request.url, [chan.port2]);

      return await rv;
    }());
  }

  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  event.respondWith(fetch(request).then(res => {
    let { body, status, statusText } = res;
    if (!status || status > 399) return res;
    let headers = new Headers(res.headers);
    for (let [k, v] of Object.entries(coiHeaders)) {
      headers.set(k, v);
    }
    return new Response(body, { status, statusText, headers });
  }));
});
