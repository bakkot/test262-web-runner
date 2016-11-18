// queue/fetch primitives

var runningTasks = [];
var backlogTasks = [];
var maxRunningTasks = 32;

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

// test runner primitives

function parseFrontmatter(src) {
  var start = src.indexOf('/*---');
  var end = src.indexOf('---*/');
  if (start === -1 || end === -1) return null;

  var match, includes = [], flags = {}, negative = null;
  var frontmatter = src.substring(start+5, end);

  match = frontmatter.match(/(?:^|\n)\s*includes:\s*\[([^\]]*)\]/);
  if (match) {
    includes = match[1].split(',').map(function f(s){return s.replace(/^\s+|\s+$/g, '');});
  } else {
    match = frontmatter.match(/(?:^|\n)\s*includes:\s*\n(\s+-.*\n)/);
    if (match) {
      includes = match[1].split(',').map(function f(s){return s.replace(/^[\s\-]+|\s+$/g, '');});
    }
  }

  match = frontmatter.match(/(?:^|\n)\s*flags:\s*\[([^\]]*)\]/);
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

  match = frontmatter.match(/(?:^|\n)\s*negative:/);
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

var errSigil = {};
var wait = 50; // ms
var iframeSrc = ''; // will be set to './blank.html' if the environment does not report error details when src = ''.
var iframes = [];

function runSources(sources, done) {
  var iframe = iframes.pop();

  var listener = function() {
    var err = errSigil;
    var timeout;
    var w = iframe.contentWindow;
    w.addEventListener('error', function(e) { err = e; });
    w.$$testFinished = function(){
      clearTimeout(timeout);
      iframe.removeEventListener('load', listener);
      iframes.push(iframe);
      done(err, w);
    };

    function append(src) {
      var script = w.document.createElement('script');
      script.text = src;
      w.document.body.appendChild(script);
    }

    sources.forEach(append);
    append('$$testFinished();');

    if (err === errSigil) { // todo maybe delete
      timeout = setTimeout(wait, function() {
        console.error('done not invoked!');
        iframe.removeEventListener('load', listener);
        iframes.push(iframe);
        done(null);
      });
    }
  };

  iframe.addEventListener('load', listener);

  iframe.src = iframeSrc;
}

function checkErrorType(errorEvent, global, kind) {
  if (typeof errorEvent.error === 'object') {
    return errorEvent.error instanceof global[kind];
  } else {
    return !!errorEvent.message.match(kind); // todo more cleverness
  }
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
        if (checkErrorType(err, w, negative.type)) {
          pass();
        } else {
          if (negative.phase === 'early' && err.message && err.message.match('NotEarlyError')) {
            fail('Expecting early ' + negative.type + ', but parsing succeeded without errors.');
          } else {
            fail('Expecting ' + negative.phase + ' ' + negative.type + ', but got an error of another kind.');  // todo more precise complaints
          }
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
function runTest262Test(src, pass, fail, skip) {
  if (src.match(/DETACHBUFFER/)) {
    skip('Test runner does not support detatching array buffers.');
    return;
  }

  if (src.match(/\$\./)) {
    skip('Test runner does not yet support the "$" API');
    return;
  }

  var meta = parseFrontmatter(src);
  if (!meta) {
    skip('Test runner couldn\'t parse frontmatter');
    return;
  }

  if (meta.flags.module || meta.flags.raw || meta.flags.async) {
    // todo support flags, support $
    skip('Test runner does not yet support flags: ' + JSON.stringify(meta.flags));
    return;
  }

  if (meta.negative && meta.negative.phase === 'early' && !meta.flags.raw) {
    src = 'throw new Error("NotEarlyError");\n' + src;
  }

  var includeSrcs = alwaysIncludes.concat(meta.includes).map(function(include) { return harness[include]; });
  // cleanup of global object. would be nice to also delete window.top, but we can't.
  if (src.match(/(?:^|[^A-Za-z0-9.'"\-])(name|length)/)) {
    includeSrcs.push('delete window.name;\ndelete window.length;');
  }

  includeSrcs = [includeSrcs.join(';\n')];

  if (!meta.flags.strict) {
    // run in both strict and non-strict
    runSources(includeSrcs.concat([strict(src)]), checkErr(meta.negative, function() {
      runSources(includeSrcs.concat([src]), checkErr(meta.negative, pass, fail));
    }, fail));
  } else {
    runSources(includeSrcs.concat([meta.flags.strict === 'always' ? strict(src) : src]), checkErr(meta.negative, pass, fail));
  }
}

// tree rendering / running

function runSubtree(root, then, toExpand) {
  if (root.passes) {
    then(root.passes, root.fails, root.skips);
    return;
  }
  var status = root.querySelector('span');
  if (root.path) { // i.e. is a file
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
        root.skips = 0;
        then(1, 0, 0);
        complete(task);
      }, function(msg) {
        status.textContent = msg;
        status.className = 'fail';
        root.passes = 0;
        root.fails = 1;
        root.skips = 0;
        then(0, 1, 0);
        complete(task);
      }, function(msg) {
        status.textContent = msg;
        status.className = 'skip';
        root.passes = 0;
        root.fails = 0;
        root.skips = 1;
        then(0, 0, 1);
        complete(task);
      });
    }, function(task) {
      status.textContent = 'Load failed.';
      status.className = 'skip';
      root.passes = 0;
      root.fails = 0;
      root.skips = 1;
      then(0, 0, 1);
      complete(task);
    });
  } else {
    var doneCount = 0;
    var ul = root.querySelector('ul');
    var children = ul.children;
    if (children.length === 0) {
      then(0, 0, 0);
      return;
    }
    var wasHidden = ul.style.display === 'none';
    var len = children.length;
    var passCount = 0;
    var failCount = 0;
    var skipCount = 0;
    for (var i = 0; i < len; ++i) {
      runSubtree(children[i], function(passes, fails, skips) {
        ++doneCount;
        passCount += passes;
        failCount += fails;
        skipCount += skips;
        if (doneCount === len) {
          if (wasHidden) {
            ul.style.display = 'none';
          }
          status.textContent = '' + passCount + ' / ' + (passCount + failCount) + (skipCount > 0 ? ' (skipped ' + skipCount + ')' : '')
          status.className = failCount === 0 ? 'pass' : 'fail';
          root.passes = passCount;
          root.fails = failCount;
          root.skips = skipCount;
          then(passCount, failCount, skipCount);
        }
      }, i === 0 ? toExpand.concat([root]) : []);
    }
  }
}

function runTree(root) {
  console.time();
  runSubtree(root, function(){console.timeEnd();}, []);
}

function addRunLink(ele) {
  var status = ele.appendChild(document.createElement('span'));
  status.style.marginLeft = '5px';

  var runLink = status.appendChild(document.createElement('input'));
  runLink.type = 'button';
  runLink.value = 'Run';
  runLink.className = 'btn btn-default btn-xs';
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


    if (item.type === 'file') {
      var srcLink = li.appendChild(document.createElement('input'));
      srcLink.type = 'button';
      srcLink.value = 'Src';
      srcLink.className = 'btn btn-default btn-xs';
      srcLink.style.marginLeft = '5px';
      srcLink.addEventListener('click', function(e) {
        e.stopPropagation();
        var w = window.open(iframeSrc);
        loadUnit(li.path)(function(task, data) {
          var pre = w.document.body.appendChild(w.document.createElement('pre'));
          pre.textContent = data;
        }, function(){ console.error('Error loading file. This shouldn\'t happen...'); })(null);
      });
      addRunLink(li);
      li.path = path.concat([item.name]);
    } else {
      addRunLink(li);
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
var harness = {};
function loadZip(z) {
  return JSZip.loadAsync(z).then(function(z) {
    tree = getStructure(z, function(path) { return path.match(/\.js$/) && !path.match(/(^\.)|(_FIXTURE\.js$)/); });
    var keys = Object.keys(tree.files);
    if (keys.length === 1) tree = tree.files[keys[0]];
    if (!tree.files.test || !tree.files.test.type === 'dir' || !tree.files.harness || !tree.files.harness.files['assert.js'] || !tree.files.harness.files['sta.js']) {
      throw new Error("Doesn't look like a test262 bundle.");
    }
    var harnessNames = Object.keys(tree.files.harness.files);
    loadAllUnqueued(harnessNames.map(function(include) { return ['harness', include]; }), function(harnessFiles) {
      for (var i = 0; i < harnessNames.length; ++i) {
        harness[harnessNames[i]] = harnessFiles[i];
      }
      var treeEle = document.getElementById('tree');
      treeEle.textContent = 'Tests:';
      addRunLink(treeEle);
      renderTree(tree.files.test.files, treeEle, ['test'], false);
    }, function(e) {
      throw e;
    });
  });
}

// onload

// var zipballUrl = 'https://api.github.com/repos/tc39/test262/zipball'; // this would be nice, but while the API claims to support CORS, it doesn't for this particular endpoint
var zipballUrl = 'tc39-test262-84e6ba8.zip';

window.addEventListener('load', function() {
  var fileEle = document.getElementById('fileLoader');
  var buttons = document.getElementById('buttons');
  var loadStatus = document.getElementById('loadStatus');

  fileEle.addEventListener('change', function() {
    if (!fileEle.files[0]) return;
    loadStatus.textContent = 'Reading...';
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
      loadStatus.textContent = 'Reading...';
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

  // Make some realms
  for (var i = 0; i < maxRunningTasks; ++i) {
    var iframe = document.body.appendChild(document.createElement('iframe'));
    iframe.style.display = 'none';
    iframes.push(iframe);
  }

  // Check if the environment reports errors from iframes with src = ''.
  runSources(['throw new Error;'], function(e) {
    if (e.message.match(/Script error\./i)) {
      iframeSrc = 'blank.html';
    }
  });
});

// todo check environment sanity
