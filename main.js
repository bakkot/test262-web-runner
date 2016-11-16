var runningTasks = [];
var backlogTasks = [];
var maxRunningTasks = 4;

var cache = {};

var ref = '';
var repo = 'https://api.github.com/repos/tc39/test262/contents/';

function enqueue(task) {
  if (runningTasks.length < maxRunningTasks) {
    runningTasks.push(task);
    task();
  } else {
    backlogTasks.push(task);
  }
}

function complete(task) {
  var index = runningTasks.indexOf(task);
  if (index !== -1) {
    runningTasks.splice(index, 1);
    if (backlogTasks.length > 0) {
      var next = backlogTasks.shift();
      runningTasks.push(next);
      next();
    }
  } else {
    console.log('task not found', task)
  }
}

function load(url, then, error, noCache) {
  // 'then' takes 'task' as its first parameter and calls complete(task) when done.
  // it takes the loaded data as its second parameter.
  // 'error' takes as 'task' as its first parameter and calls complete(task) when done.

  enqueue(function task() {
    if (!noCache && cache.hasOwnProperty(url)) {
      if (cache[url].pending) {
        cache[url].pending.push({ task: task, then: then, error: error });
      } else {
        then(task, cache[url].data);        
      }
    } else {
      if (!noCache) cache[url] = {pending: []}; // This will contain any other tasks which are waiting on the same URL while this request is pending.
      var req = new XMLHttpRequest;
      req.addEventListener('load', function() {
        var data = this.responseText;
        if (noCache) {
          then(task, data);
        } else {
          var waiting = cache[url].pending;
          cache[url] = {data: data};
          then(task, data);
          waiting.forEach(function(obj) { obj.then(obj.task, data); });          
        }
      });
      req.addEventListener('error', function() {
        if (noCache) {
          error(task);
        } else {
          var waiting = cache[url].pending;
          delete cache[url];
          error(task);
          waiting.forEach(function(obj) { obj.error(obj.task); });
        }
      });
      req.open('GET', url);
      req.send();
    }
  });
}

// end cache/fetch primitives

var wait = 50; // ms
function runTest262Test(src, pass, fail) {
  var err, timeout;
  var iframe = document.createElement('iframe');
  iframe.src = './blank.html';
  document.body.appendChild(iframe);
  var w = iframe.contentWindow;
  // w.addEventListener('error', function(e) { err = e; });
  // w.onerror = function(e, b, c, d, f, g) { err = e; console.log(b, c, d, f, g)};
  w.done = function() {
    console.log(err, typeof err);
    err = true;
    clearTimeout(timeout);
    //document.body.removeChild(iframe);
  };
  w.error = function(e) {
    console.log('hit', e);
    err = e;
  }

  function append(src) {
    var script = w.document.createElement('script');
    script.setAttribute('crossorogin', 'anonymous');
    script.text = src;
    w.document.body.appendChild(script);
  }
  append('window.onerror = function(e, b, c, d, f, g) { error(e); console.log(b, c, d, f, g)};')
  append(src);
  append('done();');

  if (err === undefined) {
    timeout = setTimeout(wait, function() {
      console.err('done not invoked!');
      document.body.removeChild(iframe);
    });
  }
}


// end runner primitive

window.addEventListener('load', function() {
  (function renderTree(tree, container, hide) {
    var list = container.appendChild(document.createElement('ul'));
    tree.forEach(function(item) {
      var li = document.createElement('li');
      item.element = li; // mutating cached data, woo
      if (item.type === 'dir') {
        li.innerText = '[+] ' + item.name;
        renderTree(item.files, li, true);
        li.addEventListener('click', function(e) {
          if (e.target !== li) return;
          e.stopPropagation();
          var subtree = li.querySelector('ul');
          if (subtree.style.display === 'none') {
            subtree.style.display = '';
          } else {
            subtree.style.display = 'none';
          }
        });
      } else {
        li.innerText = item.name;
      }
      list.appendChild(li);
    });
    if (hide) list.style.display = 'none';
  })(files, document.getElementById('tree'), false);

  runTest262Test('1 1');
});

// load('https://api.github.com/repos/bakkot/test262-web-runner/git/refs/heads/', function then(task, data) {
//   data = JSON.parse(data);
//   var sha = data.filter(function(o) {
//     return o.ref === "refs/heads/master";
//   })[0].object.sha;

//   load('https://api.github.com/repos/bakkot/test262-web-runner/git/trees/' + sha + '?recursive=1', function then(task, data) {
//     console.log(JSON.parse(data));
//     complete(task);
//   }, complete, true);

//   complete(task);
// }, complete)


// function recur(path, container) {
//   function handleSubtree(task, data) {
//     data.forEach(function(item) {
//       loadSubtree(item.path, item.element, handleSubtree);
//     });
//     complete(task);
//   }

//   loadSubtree(path, container, handleSubtree);
// }
// // recur('test/annexB/built-ins', document.getElementById('tree'));
