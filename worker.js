self.addEventListener('fetch', function(event) {
  // console.log(event);
  if (/blank.html/.test(event.request.referrer)) {
    event.respondWith(async function() {
      const client = await clients.get(event.clientId);
      const chan = new MessageChannel();
      // console.log(client);

      let resolve, reject;
      const rv = new Promise((res, rej) => {
        resolve = res; reject = rej;
      });
      setTimeout(() => reject(), 2000);
      
      chan.port1.onmessage = ( e => {
        // console.log('messaged!');
        // console.log(e);
        if (!e.data.success) {
          reject();
          return;
        }
        const text = e.data.data + '\n;$$testFinished();'; // This is such a hack...
        resolve(new Response(text, {
          headers: {
            'Content-Type': 'application/javascript',
          }
        }));
      });
      client.postMessage(event.request.url, [chan.port2]);

      return rv;
    }());
  }
});
