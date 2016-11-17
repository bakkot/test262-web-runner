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

function runAllUnqueued(units, then, error) {
  // basically Promise.all
  if (units.length === 0) {
    then([]);
    return;
  }
  var ok = true;
  var count = 0;
  var results = Array(units.length);
  units.forEach(function(unit, i) {
    unit(function(task, data) {
      if (ok) {
        results[i] = data;
        ++count;
        if (count === results.length) {
          then(results);
        }
      }
    }, function(task) {
      if (ok) {
        ok = false;
        error();
      }
    })(null);
  });
}

function delay(wait, task) {
  return function(me) {
    setTimeout(function() { task(me); }, wait);
  };
}

function loadUnit(path) {
  return function(then, error) {
    return function(task) {
      var file = path.reduce(function(acc, name) { return acc.files[name]; }, tree).file;
      file.async("string").then(function(c) { then(task, c); }, function(e) { error(task); });
    };
  };
}

function load(path, then, error) {
  enqueue(loadUnit(path)(then, error));
}

function loadAllUnqueued(paths, then, error) {
  runAllUnqueued(paths.map(loadUnit), then, error);
}

// end queue/fetch primitives

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

  loadAllUnqueued(alwaysIncludes.concat(meta.includes).map(function(include) { return ['harness', include]; }), function(includeSrcs) {
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

function runSubtree(root, then, toExpand) {
  if (root.passes) {
    then(root.passes, root.fails);
    return;
  }
  var status = root.querySelector('span');
  if (root.path) { // todo consistent file vs directory ordering
    load(root.path, function(task, data) {
      toExpand.forEach(function(ele) {
        ele.querySelector('ul').style.display = '';
        var status = ele.querySelector('span');
        status.textContent = 'Working...';
        status.className = 'wait';
      });
      status.textContent = 'Running...';
      status.className = 'running';
      runTest262Test(data, function() {
        status.textContent = 'Pass!';
        status.className = 'pass';
        root.passes = 1;
        root.fails = 0;
        then(1, 0);
        complete(task);
      }, function(msg) {
        status.textContent = msg;
        status.className = 'fail';
        root.passes = 0;
        root.fails = 1;
        then(0, 1);
        complete(task);
      });
    }, function(task) {
      status.textContent = 'Load failed.';
      status.className = 'fail';
      root.passes = 0;
      root.fails = 1;
      then(0, 1);
    });
  } else {
    var doneCount = 0;
    var ul = root.querySelector('ul');
    var children = ul.children;
    if (children.length === 0) {
      then(0, 0);
      return;
    }
    var wasHidden = ul.style.display === 'none';
    var len = children.length;
    var passCount = 0;
    var failCount = 0;
    for (var i = 0; i < len; ++i) {
      runSubtree(children[i], function(passes, fails) {
        ++doneCount;
        passCount += passes;
        failCount += fails;
        if (doneCount === len) {
          if (wasHidden) {
            ul.style.display = 'none';
          }
          status.textContent = '' + passCount + ' / ' + (passCount + failCount);
          status.className = failCount === 0 ? 'pass' : 'fail';
          root.passes = passCount;
          root.fails = failCount;
          then(passCount, failCount);
        }
      }, i === 0 ? toExpand.concat([root]) : []);
    }
  }
}

function runTree(root) {
  var buttons = root.querySelectorAll('input');
  for (var i = 0; i < buttons.length; ++i) {
    buttons[i].parentNode.removeChild(buttons[i]);
  }
  runSubtree(root, function(){}, []);
}

function addRunLink(ele) {
  var status = ele.appendChild(document.createElement('span'));
  status.style.paddingLeft = '5px';

  var runLink = status.appendChild(document.createElement('input'));
  runLink.type = 'button';
  runLink.value = 'Run';
  runLink.addEventListener('click', function(e) {
    e.stopPropagation();
    runTree(ele);
  });
}

function renderTree(tree, container, path, hide) {
  var list = container.appendChild(document.createElement('ul'));
  Object.keys(tree).sort().forEach(function(key) {
    var item = tree[key];

    var li = document.createElement('li');
    li.textContent = (item.type === 'dir' ? '[+] ' : '') + item.name;

    addRunLink(li);

    if (item.type === 'dir') {
      renderTree(item.files, li, path.concat([item.name]), true);
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
      li.path = path.concat([item.name]);
    }
    list.appendChild(li);
  });
  if (hide) list.style.display = 'none';
}

function getStructure(zip, predicate) {
  var structure = Object.create(null);
  structure.type = 'dir';
  structure.name = '.';
  structure.files = Object.create(null);
  zip.forEach(function(path, file) {
    if (!predicate(path)) return;
    path = path.split('/');
    if (path[path.length - 1] === '') return; // i.e. this is a directory
    var dir = structure;
    for (var i = 0; i < path.length - 1; ++i) {
      if (!Object.prototype.hasOwnProperty.call(dir.files, path[i])) {
        dir.files[path[i]] = Object.create(null);
        dir.files[path[i]].type = 'dir';
        dir.files[path[i]].name = path[i];
        dir.files[path[i]].files = Object.create(null);
      }
      dir = dir.files[path[i]];
    }
    var obj = Object.create(null);
    obj.type = 'file';
    obj.name = path[path.length - 1];
    obj.file = file;
    dir.files[path[path.length - 1]] = obj;
  });
  return structure;
}

var tree; // global variables are fun!
function loadZip(z) {
  return JSZip.loadAsync(z).then(function(z) {
    tree = getStructure(z, function(path) { return path.match(/\.js$/) && !path.match(/(^\.)|(_FIXTURE\.js$)/); });
    var keys = Object.keys(tree.files);
    if (keys.length === 1) tree = tree.files[keys[0]];
    if (!tree.files.test || !tree.files.test.type === 'dir' || !tree.files.harness || !tree.files.harness.files['assert.js'] || !tree.files.harness.files['sta.js']) {
      throw new Error("Doesn't look like a test262 bundle."); // todo
    }
    var treeEle = document.getElementById('tree');
    treeEle.textContent = 'Tests:';
    addRunLink(treeEle);
    renderTree(tree.files.test.files, treeEle, ['test'], false);
  });
}

// end tree rendering / running stuff

// var zipballUrl = 'https://api.github.com/repos/tc39/test262/zipball'; // this would be nice, but while the API claims to support CORS, it doesn't for this particular endpoint
var zipballUrl = 'tc39-test262-84e6ba8.zip';

window.addEventListener('load', function() {
  var fileEle = document.getElementById('fileLoader');
  var buttons = document.getElementById('buttons');
  var loadStatus = document.getElementById('loadStatus');

  fileEle.addEventListener('change', function() {
    if (!fileEle.files[0]) return;
    loadZip(fileEle.files[0])
      .then(function() { buttons.style.display = 'none'; })
      .catch(function(e) { loadStatus.textContent = e; });
  });

  document.getElementById('loadLocal').addEventListener('click', function() {
    fileEle.click();
  });

  document.getElementById('loadGithub').addEventListener('click', function() {
    loadStatus.textContent = '';
    var req = new XMLHttpRequest;

    req.addEventListener('load', function() {
      loadStatus.textContent = 'Loaded!';
      loadZip(req.response)
        .then(function() { buttons.style.display = 'none'; })
        .catch(function(e) { loadStatus.textContent = e; });
    });

    req.addEventListener('error', function() {
      loadStatus.textContent = 'Error loading.';
    });

    var tick = false;
    var MB = Math.pow(2, 20)/10;
    req.addEventListener('progress', function(evt) {
      if (evt.lengthComputable) {
        var loaded = '' + Math.floor(evt.loaded/MB)/10;
        var total = '' + Math.ceil(evt.total/MB)/10;
        while (loaded.length < total.length) loaded = '\u00A0' + loaded;
        loadStatus.textContent = 'Loading... ' + loaded + 'MB / ' + total + 'MB';
      } else {
        loadStatus.textContent = 'Loading... ' + (tick ? '/' : '\\');
        tick = !tick;
      }
    });

    req.open('GET', zipballUrl);
    req.responseType = 'arraybuffer'; // todo check support
    req.send();
  });
});


