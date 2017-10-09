self.addEventListener('fetch', function(event) {
  // TODO also intercept blank.html to serve the right thing without hitting the network
  const isInitial = /blank.html$/.test(event.request.referrer);
  const isSubsequent = /\/test\/.*\.js$/.test(event.request.referrer);
  if (isInitial || isSubsequent) {
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
        if (isInitial) {
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
