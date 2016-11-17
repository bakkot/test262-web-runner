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

function delay(wait, task) {
  return function(me) {
    setTimeout(function() { task(me); }, wait);
  };
}

function enqueueSimple(fn) {
  enqueue(function(task) {
    fn();
    complete(task);
  });
}

function loadUnit(url, noCache) {
  return function(then, error) {
    return function(task) {
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
    };
  };
}

function loadTask(url, then, error, noCache) {
  return loadUnit(url, noCache)(then, error);
}

function load(url, then, error, noCache) {
  // 'then' takes 'task' as its first parameter and calls complete(task) when done.
  // it takes the loaded data as its second parameter.
  // 'error' takes as 'task' as its first parameter and calls complete(task) when done.

  enqueue(loadTask(url, then, error, noCache));
}

function enqueueAll(units, then, error) {
  if (units.length === 0) {
    then([]);
    return;
  }
  var ok = true;
  var count = 0;
  var results = Array(units.length);
  units.forEach(function(unit, i) {
    enqueue(unit(function(task, data) {
      if (ok) {
        results[i] = data;
        ++count;
        if (count === results.length) {
          then(results);
        }
      }
      complete(task);
    }, function(task) {
      if (ok) {
        ok = false;
        error();
      }
      complete(task);
    }));
  });
}

function loadAll(urls, then, error) {
  enqueueAll(urls.map(loadUnit), then, error);
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

function checkType(errorEvent, global, kind) {
  if (typeof errorEvent.error === 'object') {
    return errorEvent.error instanceof global[kind];
  } else {
    return !!errorEvent.message.match(kind); // todo more cleverness
  }
}

var errSigil = {};
function runSources(sources, done) {
  var iframe = document.createElement('iframe');

  iframe.addEventListener('load', function() {
    var err = errSigil, timeout;
    var w = iframe.contentWindow;
    w.addEventListener('error', function(e) { err = e; });
    w.done = function(){
      clearTimeout(timeout);
      done(err, w);
      document.body.removeChild(iframe);
    };

    function append(src) {
      var script = w.document.createElement('script');
      script.text = src;
      w.document.body.appendChild(script);
    }

    sources.forEach(append);
    append('done();');

    if (err === errSigil) {
      timeout = setTimeout(wait, function() {
        console.error('done not invoked!');
        done(null);
        document.body.removeChild(iframe);
      });
    }
  });

  iframe.src = './blank.html';
  iframe.style.display = 'none';
  document.body.appendChild(iframe);
}

function checkErr(negative, pass, fail) {
  return function(err, w) {
    if (err === errSigil) {
      if (negative) {
        fail('Expecting ' + negative.phase + ' ' + negative.type + ', but no error was thrown.');
      } else {
        pass();
      }
    } else {
      if (negative) {
        if (checkType(err, w, negative.type)) {
          pass();
        } else {
          fail('Expecting ' + negative.phase + ' ' + negative.type + ', but got an error of another kind.');  // todo more precise complaints
        }
      } else {
        fail('Unexpected error: ' + err.message.replace(/^uncaught\W+/i, ''));
      }
    }
  };
}

function strict(src) {
  return '"use strict";\n' + src;
}

var alwaysIncludes = ['assert.js', 'sta.js'];
var wait = 50; // ms
function runTest262Test(src, pass, fail) {
  var meta = parseFrontmatter(src);
  if (!meta) {
    fail('Couldn\'t parse frontmatter');
    return;
  }

  if (meta.flags.module || meta.flags.raw || meta.flags.async) {
    // todo
    fail('Unhandled metadata ' + JSON.stringify(meta));
    return;
  }

  if (meta.negative && meta.negative.phase === 'early' && !meta.flags.raw) {
    src += 'throw new Error("NotEarlyError");\n';
  }

  loadAll(alwaysIncludes.concat(meta.includes).map(function(include) { return './test262/harness/' + include; }), function(includeSrcs) {
    if (!meta.flags.strict) {
      // run in both strict and non-strict.
      runSources(includeSrcs.concat([strict(src)]), checkErr(meta.negative, function() {
        runSources(includeSrcs.concat([src]), checkErr(meta.negative, pass, fail));
      }, fail));
    } else {
      runSources(includeSrcs.concat([meta.flags.strict === 'always' ? strict(src) : src]), checkErr(meta.negative, pass, fail));
    }
  }, function() {
    fail('Error loading test data.');
  });
}

// end runner primitive


// function walk(list, path, file, dir) {
//   // functions are called on children before parents
//   list.forEach(function(item) {
//     if (item.type === 'file') {
//       file(path + item.name);
//     } else {
//       walk(item.files, path + item.name + '/', file, dir);
//       dir(path + item.name + '/');
//     }
//   });
// }

// walk(files, './test262/test/', function(path) {
//   load(path, function then(task, data) {
//     var matter = parseFrontmatter(data);
//     // console.log(path);
//     if (matter === null) {
//       console.error(path);
//       backlogTasks = [];
//     }
//     complete(task);
//   }, function error(task) {
//     console.error('oh no!', path);
//     backlogTasks = [];
//     complete(task);
//   });
// }, function(){})

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
  (function renderTree(tree, container, path, hide) {
    var list = container.appendChild(document.createElement('ul'));
    tree.forEach(function(item) {
      var li = document.createElement('li');
      item.element = li; // mutating cached data, woo
      if (item.type === 'dir') {
        li.innerText = '[+] ' + item.name;
        renderTree(item.files, li, path + item.name + '/', true);
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
        li.path = path + item.name; // todo find a better way of doing this
        var status = li.appendChild(document.createElement('span'));
        status.style.paddingLeft = '5px';
        li.addEventListener('click', function(e) {
          if (e.target !== li) return;
          e.stopPropagation();
          load(path + item.name, function(task, data) {
            runTest262Test(data, function() {
              status.innerText = 'Pass!';
              status.className = 'pass';
            }, function(msg) {
              status.innerText = msg;
              status.className = 'fail';
            });
            complete(task);
          }, function(task) {
            status.innerText = 'Load failed.';
            status.className = 'fail';
            complete(task);
          });
        });
      }
      list.appendChild(li);
    });
    if (hide) list.style.display = 'none';
  })(files, document.getElementById('tree'), './test262/test/', false);

  //runTest262Test('1 1');
});









var ded = 0;
function runSubtree(root, then) {
  if (root.path) {
    var status = root.querySelector('span');
    enqueue(loadTask(root.path, function(task, data) {
      runTest262Test(data, function() {
        status.innerText = 'Pass!';
        status.className = 'pass';
        then();
      }, function(msg) {
        status.innerText = msg;
        status.className = 'fail';
        then();
      });
      complete(task);
    }, function(task) {
      status.innerText = 'Load failed.';
      status.className = 'fail';
      then();
      complete(task);
    }));
  } else {
    var doneCount = 0;
    var ul = root.querySelector('ul');
    var children = ul.children;
    if (children.length === 0) {
      then();
      return;
    }
    var wasHidden = ul.style.display === 'none';
    if (wasHidden) {
      ul.style.display = '';
    }
    var len = children.length;
    for (var i = 0; i < len; ++i) {
      runSubtree(children[i], function() {
        ++doneCount;
        if (doneCount === len) {
          if (wasHidden) {
            ul.style.display = 'none';
          }
          then();
        }
      });
    }
  }
}





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
