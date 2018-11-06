self.addEventListener('fetch', function(event) {
  // 'blank.html' resolves for all paths.
  // We use this to run scripts containing a dynamic import on a synthetic page which has the right URL to serve its depedencies.
  if (/blank\.html$/.test(event.request.url)) {
    event.respondWith(Promise.resolve(new Response(
      `<!doctype html><meta charset=utf-8><title>realm</title>`,
      {
        headers: {
          'Content-Type': 'text/html',
        }
      }
    )));
    return;
  }

  if (/\/SYNTHETIC\//.test(event.request.url)) {
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
        if (/blank.html$/.test(event.request.referrer)) {
          text += '\n;$$testFinished();'; // This is such a hack...
        }
        resolve(new Response(text, {
          headers: {
            'Content-Type': 'application/javascript',
          }
        }));
      };
      client.postMessage(event.request.url, [chan.port2]);

      return await rv;
    }());
  }
});
