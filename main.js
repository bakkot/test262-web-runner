var runningTasks = [];
var backlogTasks = [];
var maxRunningTasks = 4;

var cache = {};

var ref = '';
var repo = 'https://api.github.com/repos/tc39/test262/contents/';

function enqueue(task) {
  if (runningTasks.length < maxRunningTasks) {
    runningTasks.push(task);
    task(task);
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
      next(next);
    }
  } else {
    console.log('task not found', task)
  }
}

function delay(task, wait) {
  return function(me) {
    setTimeout(function() { task(me); }, wait);
  };
}


function load(url, then, error, noCache) {
  // 'then' takes 'task' as its first parameter and calls complete(task) when done.
  // it takes the loaded data as its second parameter.
  // 'error' takes as 'task' as its first parameter and calls complete(task) when done.

  enqueue(delay(function(task) {
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
  }, 10));
}

// end cache/fetch primitives

function parseFrontmatter(src) {
  var start = src.indexOf('/*---');
  var end = src.indexOf('---*/');
  if (start === -1 || end === -1) return null;

  var match, includes = [], flags = {}, negative = null;
  var frontmatter = src.substring(start+5, end);

  match = frontmatter.match(/(?:^|\n)includes:\s*\[([^\]]*)\]/);
  if (match) {
    includes = match[1].split(',').map(function f(s){return s.replace(/^\s+|\s+$/g, '');});
  }

  match = frontmatter.match(/(?:^|\n)flags:\s*\[([^\]]*)\]/);
  if (match) {
    match[1].split(',').map(function f(s){return s.replace(/^\s+|\s+$/g, '');}).forEach(function(flag) {
      switch (flag) {
        case 'onlyStrict':
          if (flags.strict) {
            console.error('flag conflict', src);
          }
          flags.strict = 'always';
          break;
        case 'noStrict':
          if (flags.strict) {
            console.error('flag conflict');
          }
          flags.strict = 'never';
          break;
        case 'module':
          flags.module = true;
          break;
        case 'raw':
          flags.raw = true;
          break;
        case 'async':
          flags.async = true;
          break;
        case 'generated':
          break;
        default:
          console.error('unrecocognized flag: ' + flag, frontmatter);
          break;
      }
    });
  }

  match = frontmatter.match(/(?:^|\n)negative:/);
  if (match) {
    var phase, type;
    frontmatter.substr(match.index + 9).split('\n').forEach(function(line) {
      var match = line.match(/\s+phase:\s*(\S+)/);
      if (match) {
        phase = match[1];
      }
      match = line.match(/\s+type:\s*(\S+)/);
      if (match) {
        type = match[1];
      }
    });
    if (!phase || !type) return null;
    negative = {phase: phase, type: type};
  }
  return {includes: includes, flags: flags, negative: negative};
}


var wait = 50; // ms
function runTest262Test(src, pass, fail) {
  var iframe = document.createElement('iframe');

  iframe.addEventListener('load', function(){
    var err, timeout;
    var w = iframe.contentWindow;
    w.addEventListener('error', function(e) { err = e; });
    w.done = function() {
      console.log(err, err.message, err.error);
      err = true;
      clearTimeout(timeout);
      document.body.removeChild(iframe);
    };

    function append(src) {
      var script = w.document.createElement('script');
      script.text = src;
      w.document.body.appendChild(script);
    }
    append(src);
    append('done();');

    if (err === undefined) {
      timeout = setTimeout(wait, function() {
        console.err('done not invoked!');
        document.body.removeChild(iframe);
      });
    }
  });

  iframe.src = './blank.html';
  iframe.style.display = 'none';
  document.body.appendChild(iframe);
}


// end runner primitive


function walk(list, path, file, dir) {
  // functions are called on children before parents
  list.forEach(function(item) {
    if (item.type === 'file') {
      file(path + item.name);
    } else {
      walk(item.files, path + item.name + '/', file, dir);
      dir(path + item.name + '/');
    }
  });
}

walk(files, './test262/test/', function(path) {
  load(path, function then(task, data) {
    var matter = parseFrontmatter(data);
    // console.log(path);
    if (matter === null) {
      console.error(path);
      backlogTasks = [];
    }
    complete(task);
  }, function error(task) {
    console.error('oh no!', path);
    backlogTasks = [];
    complete(task);
  });
}, function(){})

// load('./test262/test/built-ins/RegExp/prototype/exec/u-lastindex-adv.js', function then(task, data) {
//   var matter = parseFrontmatter(data);
//   console.log('a');
//   if (matter === null) {
//     console.error('a');
//     backlogTasks = [];
//   }
//   console.log(matter)
//   complete(task);
// }, function error(task) {
//   console.error('oh no!', 'a');
//   backlogTasks = [];
//   complete(task);
// });


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

  //runTest262Test('1 1');
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
