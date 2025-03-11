'use strict';

// var zipballUrl = 'https://api.github.com/repos/tc39/test262/zipball'; // this would be nice, but while the API claims to support CORS, it doesn't for this particular endpoint
var zipballUrl = 'tc39-test262-69c1efd.zip';

var skippedRegex = /integer-limit/; // todo this should not be here, and should probably be exposed


// queue/fetch primitives

var paused = false;
var runningTasks = [];
var backlogTasks = [];
var maxRunningTasks = 4;

function enqueue(task) {
  if (!paused && runningTasks.length < maxRunningTasks) {
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
    if (!paused && backlogTasks.length > 0) {
      var next = backlogTasks.shift();
      runningTasks.push(next);
      next(next);
    }
  } else {
    console.log('task not found', task);
  }
}

function pause() {
  paused = true;
}

function resume() {
  // This might cause tasks to be executed out of order if some are synchronous, but whatever.
  paused = false;
  var start = runningTasks.length;
  for (var i = start; backlogTasks.length > 0 && i < maxRunningTasks; ++i) {
    runningTasks.push(backlogTasks.shift());
  }
  for (var i = start; i < runningTasks.length; ++i) {
    runningTasks[i](runningTasks[i]);
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
      if (file) {
        file.async("string").then(function(c) { then(task, c); }, function(e) { error(task); });
      } else {
        then();
      }
    };
  };
}

function load(path, then, error) {
  enqueue(loadUnit(path)(then, error));
}

function loadAllUnqueued(paths, then, error) {
  runAllUnqueued(paths.map(loadUnit), then, error);
}


// API

function installAPI(global) {
  return global.$262 = {
    createRealm: function() {
      var iframe = global.document.createElement('iframe');
      iframe.src = iframeSrc;
      global.document.body.appendChild(iframe);
      return installAPI(iframe.contentWindow);
    },
    evalScript: function(src) {
      var script = global.document.createElement('script');
      script.text = src;
      global.document.body.appendChild(script);
    },
    detachArrayBuffer: function(buffer) {
      if (typeof postMessage !== 'function') {
        throw new Error('No method available to detach an ArrayBuffer');
      } else {
        postMessage(null, '*', [buffer]);
        /*
          See https://html.spec.whatwg.org/multipage/comms.html#dom-window-postmessage
          which calls https://html.spec.whatwg.org/multipage/infrastructure.html#structuredclonewithtransfer
          which calls https://html.spec.whatwg.org/multipage/infrastructure.html#transfer-abstract-op
          which calls the DetachArrayBuffer abstract operation https://tc39.github.io/ecma262/#sec-detacharraybuffer
        */
      }
    },
    global: global,
    IsHTMLDDA: global.document.all,
  };
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

  return {includes: includes, flags: flags, negative: negative, isDynamic: /dynamic-import/.test(frontmatter)}; // lol, do better
}

var errSigil = {};
var noCompletionSigil = {};
var asyncWait = 500; // ms
var iframeSrc = ''; // will be set to './blank.html' if the environment does not report error details when src = ''.
var iframes = [];

/*
arg looks like this:
{
  setup: string,
  source: string,
  isModule: boolean,
  isAsync: boolean,
  needsAPI: boolean,
  path: string,
}

*/
function runSources(arg, done) {
  var iframe = iframes.pop();

  var path = ['SYNTHETIC'].concat(arg.path);

  var listener = function() {
    iframe.removeEventListener('load', listener);
    var err = errSigil;
    var timeout;
    var w = iframe.contentWindow;
    var completed = false;

    if (arg.needsAPI) {
      installAPI(w);
    }

    w.$$testFinished = function() {
      if (completed) return;
      completed = true;
      if (timeout !== undefined) clearTimeout(timeout);
      iframes.push(iframe);
      done(err, w);
    };
    w.addEventListener('error', function(e) {
      err = e;
      w.$$testFinished();
    });
    if (arg.isAsync) {
      w.print = function(msg) {
        if (err === errSigil && msg !== 'Test262:AsyncTestComplete') {
          err = new w.Error('Error: unexpected message ' + msg);
        }
        w.$$testFinished();
      }
    }

    var script = w.document.createElement('script');
    script.text = arg.setup;
    w.document.body.appendChild(script);

    w.navigator.serviceWorker.addEventListener('message', messageListener);

    script = w.document.createElement('script');
    if (arg.isModule) {
      script.src = path[path.length - 1];
      script.type = 'module';
    } else {
      script.text = arg.source;
    }
    w.document.body.appendChild(script);

    if (!arg.isAsync && !arg.isModule) { // For modules, our service worker appends this to the source; it would be better to do it this way in that case also, but there's some evaluation order issues.
      script = w.document.createElement('script');
      script.text = '$$testFinished();';
      w.document.body.appendChild(script);
    }
    if (!completed) {
      timeout = setTimeout(function() {
        if (completed) return;
        iframes.push(iframe);
        done(err === errSigil ? noCompletionSigil : err);
      }, asyncWait);
    }
  };

  iframe.addEventListener('load', listener);

  iframe.src = (arg.isDynamic || arg.isModule) ? path.slice(0, path.length - 1).concat(['blank.html']).join('/') : iframeSrc; // Our service worker can't intercept requests when src = '', sadly.
}

function checkErrorType(errorEvent, global, kind) {
  if (typeof errorEvent.error === 'object') {
    return errorEvent.error instanceof global[kind];
  } else {
    return !!errorEvent.message.match(kind); // can give incorrect answers, but in practice this works pretty well.
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
    } else if (err === noCompletionSigil) {
      fail('Test timed out.');
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
function runTest262Test(src, path, pass, fail, skip) {
  var meta = parseFrontmatter(src);
  if (!meta) {
    skip('Test runner couldn\'t parse frontmatter');
    return;
  }

  if (meta.negative && meta.negative.phase === 'early' && !meta.flags.raw) {
    src = 'throw new Error("NotEarlyError");\n' + src;
  }

  var includeSrcs = alwaysIncludes.concat(meta.includes).map(function(include) { return harness[include]; });
  var needsAPI = includeSrcs.some(function(src) { return src.match(/\$262\./); }) || src.match(/\$262\./);

  var isAsync = meta.flags.async;
  if (isAsync) {
    includeSrcs.push(harness['doneprintHandle.js']);
  }

  // cleanup of global object. would be nice to also delete window.top, but we can't.
  if (!meta.flags.raw && src.match(/(?:^|[^A-Za-z0-9.'"\-])(name|length)/)) {
    includeSrcs.push('delete window.name;\ndelete window.length;');
  }

  var setup = includeSrcs.join(';\n');

  if ((includeSrcs + src).match(/\$262\.agent/)) {
    skip('Test runner does not yet support the agent API.'); // and won't until https://github.com/tc39/test262/issues/928 probably
    return;
  }

  if (window.useTransformer) {
    if (typeof transform !== 'function') {
      skip('"transform" does not appear to be a function; did you forget to specify one?');
      return;
    }
    try {
      var newSrc = transform(src, path.join('/'));
      if (newSrc == null) {
        skip('Transformer marked test as skipped');
        return;
      }
    } catch (e) {
      skip('Transformer threw: ' + e.toString());
      return;
    }
    src = newSrc;
  }

  if (meta.flags.module) {
    runSources({ setup: setup, source: src, isModule: true, isAsync: isAsync, needsAPI: needsAPI, path: path, isDynamic: meta.isDynamic }, checkErr(meta.negative, pass, fail));
    return;
  }
  if (meta.flags.raw) {
    // Note: we cannot assert phase for these, so false positives are possible.
    runSources({ setup: setup, source: src, isModule: false, isAsync: isAsync, needsAPI: needsAPI, path: path, isDynamic: meta.isDynamic }, checkErr(meta.negative, pass, fail));
    return;
  }
  if (meta.flags.strict) {
    runSources({ setup: setup, source: meta.flags.strict === 'always' ? strict(src) : src, isModule: false, isAsync: isAsync, needsAPI: needsAPI, path: path, isDynamic: meta.isDynamic }, checkErr(meta.negative, pass, fail));
    return;
  }

  // run in both strict and non-strict
  runSources({ setup: setup, source: strict(src), isAsync: isAsync, needsAPI: needsAPI, path: path, isDynamic: meta.isDynamic }, checkErr(meta.negative, function() {
    runSources({ setup: setup, source: src, isModule: false, isAsync: isAsync, needsAPI: needsAPI, path: path, isDynamic: meta.isDynamic }, checkErr(meta.negative, pass, fail));
  }, fail));
}


// tree rendering / running

function makeFailEle(path, msg) {
  var ele = document.createElement('li');
  var pathSpan = ele.appendChild(document.createElement('span'));
  pathSpan.style.fontFamily = 'monospace';
  pathSpan.textContent = path.slice(1).join('/');
  addSrcLink(ele, path);
  var msgEle = ele.appendChild(document.createElement('p'));
  msgEle.textContent = msg;
  return ele;
}

var failedTests = [];
function addFailure(path, msg) {
  failedTests.push({path: path, ele: makeFailEle(path, msg)});
  failedTests.sort(function(a, b) {
    if (a.path < b.path) {
      return -1;
    } else if (b.path < a.path) {
      return 1;
    } else {
      return 0;
    }
  });
  document.getElementById('failures').style.display = '';
  var failList = document.getElementById('failList');
  failList.innerHTML = '';
  failedTests.forEach(function(o) {
    failList.appendChild(o.ele);
  });
  document.getElementById('failuresCount').textContent = failedTests.length;
}

function makeProgressBar(count, total) {
  var text = count + '/' + total + ' [';
  for (var i = 0; i < 10; ++i) {
    text += i/10 < count/total ? '=' : '\u00A0';
  }
  text += ']';
  return text;
}

function increment(ancestors) {
  ancestors.forEach(function(ele) {
    ++ele.doneCount;
    ele.querySelector('span span').textContent = makeProgressBar(ele.doneCount, ele.totalCount);
  });
}

function runSubtree(root, then, ancestors, toExpand) {
  if (root.passes) {
    then(root.passes, root.fails, root.skips);
    return;
  }
  var status = root.querySelector('span');
  if (root.path) { // i.e. is a file
    if (skippedRegex.test(root.path[root.path.length - 1])) {
      status.textContent = 'Skipped by runner.';
      status.className = 'skip';
      root.passes = 0;
      root.fails = 0;
      root.skips = 1;
      then(0, 0, 1);
      return;
    }
    load(root.path, function(task, data) {
      if (task.cancelled) {
        complete(task);
        return;
      }
      toExpand.forEach(function(ele) {
        ele.querySelector('ul').style.display = '';
        var progress = ele.querySelector('span span');
        progress.textContent = makeProgressBar(ele.doneCount, ele.totalCount);
        progress.style.display = '';
      });
      status.textContent = 'Running...';
      status.className = 'running';
      runTest262Test(data, root.path, function() {
        status.textContent = 'Pass!';
        status.className = 'pass';
        root.passes = 1;
        root.fails = 0;
        root.skips = 0;
        increment(ancestors);
        then(1, 0, 0);
        complete(task);
      }, function(msg) {
        addFailure(root.path, msg);
        status.textContent = msg;
        status.className = 'fail fail-message';
        root.passes = 0;
        root.fails = 1;
        root.skips = 0;
        increment(ancestors);
        then(0, 1, 0);
        complete(task);
      }, function(msg) {
        status.textContent = msg;
        status.className = 'skip';
        root.passes = 0;
        root.fails = 0;
        root.skips = 1;
        increment(ancestors);
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
    var seenNovel = false;
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
          status.textContent = passCount + '/' + (passCount + failCount) + (skipCount > 0 ? ' (skipped ' + skipCount + ')' : '')
          status.className = failCount === 0 ? 'pass' : 'fail';
          root.passes = passCount;
          root.fails = failCount;
          root.skips = skipCount;
          then(passCount, failCount, skipCount);
        }
      }, ancestors.concat([root]), !seenNovel && children[i].passes === undefined ? toExpand.concat([root]) : []);
      seenNovel = children[i].passes === undefined;
    }
  }
}

function runTree(root) {
  var controls = document.getElementById('controls');
  controls.style.display = '';

  var runs = document.querySelectorAll('.run');
  for (var i = 0; i < runs.length; ++i) {
    runs[i].style.display = 'none';
  }

  var ancestors = [];
  for (var current = root; current.id !== 'tree'; current = current.parentNode.parentNode) {
    ancestors.unshift(current.parentNode.parentNode);
  }

  var start = Date.now();
  runSubtree(root, function(){
    console.log((Date.now() - start)/1000 + ' seconds');

    controls.style.display = 'none';
    for (var i = 0; i < runs.length; ++i) {
      runs[i].style.display = '';
    }
  }, ancestors, []);
}

function addRunLink(ele) {
  var status = ele.appendChild(document.createElement('span'));
  status.className = 'wait';
  status.style.marginLeft = '5px';

  var runLink = status.appendChild(document.createElement('input'));
  runLink.type = 'button';
  runLink.value = 'Run';
  runLink.className = 'btn btn-default btn-xs run';
  runLink.addEventListener('click', function(e) {
    e.stopPropagation();
    runTree(ele);
  });

  var progressEle = status.appendChild(document.createElement('span'));
  progressEle.style.display = 'none';
  progressEle.style.fontFamily = 'monospace';
}

function addSrcLink(ele, path) {
  var srcLink = ele.appendChild(document.createElement('input'));
  srcLink.type = 'button';
  srcLink.value = 'Src';
  srcLink.className = 'btn btn-default btn-xs';
  srcLink.style.marginLeft = '5px';
  srcLink.addEventListener('click', function(e) {
    e.stopPropagation();
    var w = window.open(iframeSrc);
    loadUnit(path)(function(task, data) {
      var pre = w.document.body.appendChild(w.document.createElement('pre'));
      pre.textContent = data;
    }, function(){ console.error('Error loading file. This shouldn\'t happen...'); })(null);
  });
}

function renderTree(tree, container, path, hide) {
  var list = container.appendChild(document.createElement('ul'));
  Object.keys(tree)
    .sort()
    .filter(function(key) { return !key.match(/(_FIXTURE\.js$)/); })
    .forEach(function(key) {
      var item = tree[key];

      var li = document.createElement('li');
      li.textContent = (item.type === 'dir' ? '[+] ' : '') + item.name;

      if (item.type === 'file') {
        addSrcLink(li, path.concat([item.name]));
        addRunLink(li);
        li.path = path.concat([item.name]);
      } else {
        li.totalCount = item.count;
        li.doneCount = 0;
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
  structure.count = 0;
  zip.forEach(function(path, file) {
    if (!predicate(path)) return;
    path = path.split('/');
    if (path[path.length - 1] === '') return; // i.e. this is a directory
    var dir = structure;
    for (var i = 0; i < path.length - 1; ++i) {
      ++dir.count;
      if (!Object.prototype.hasOwnProperty.call(dir.files, path[i])) {
        var f = dir.files[path[i]] = Object.create(null);
        f.type = 'dir';
        f.name = path[i];
        f.files = Object.create(null);
        f.count = 0;
      }
      dir = dir.files[path[i]];
    }
    if (!path[path.length - 1].match(/(_FIXTURE\.js$)/)) {
      ++dir.count;
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
    tree = getStructure(z, function(path) { return path.match(/\.js$/) && !path.match(/^(\.|__MACOSX)/); });
    var keys = Object.keys(tree.files);
    if (keys.length === 1) tree = tree.files[keys[0]];
    if (!tree.files.test || !tree.files.test.type === 'dir' || !tree.files.harness || !tree.files.harness.files['assert.js'] || !tree.files.harness.files['sta.js']) {
      throw new Error("Doesn't look like a test262 bundle.");
    }
    var resolve, reject;
    var renderPromise = new Promise(function(_resolve, _reject) { resolve = _resolve; reject = _reject; });
    var harnessNames = Object.keys(tree.files.harness.files);
    loadAllUnqueued(harnessNames.map(function(include) { return ['harness', include]; }), function(harnessFiles) {
      if (!harnessFiles) {
        resolve();
      }
      try {
        for (var i = 0; i < harnessNames.length; ++i) {
          harness[harnessNames[i]] = harnessFiles[i];
        }

        var treeEle = document.getElementById('tree');
        treeEle.textContent = 'Tests:';
        treeEle.doneCount = 0;
        treeEle.totalCount = tree.files.test.count;
        addRunLink(treeEle);
        renderTree(tree.files.test.files, treeEle, ['test'], false);
      } catch (e) {
        reject(e);
        return;
      }
      resolve();
    }, reject);
    return renderPromise;
  });
}


// coordination with service worker

function messageListener(e) {
  var port = e.ports[0];
  var path = e.data.split('/');
  path = path.slice(path.lastIndexOf('test') + 1);
  var head = tree.files.test;
  for (var i = 0; i < path.length; ++i) {
    if (typeof head !== 'object' || head.type !== 'dir') {
      e.ports[0].postMessage({ success: false });
      return;
    }
    head = head.files[path[i]];
  }
  if (typeof head !== 'object' || head.type !== 'file') {
    port.postMessage({ success: false });
    return;
  }
  head.file.async('string').then(function(c) {
    port.postMessage({ success: true, data: c });
  }, function(e) {
    port.postMessage({ success: false });
  });
}
navigator.serviceWorker.addEventListener('message', messageListener);

// onload

window.addEventListener('load', function() {
  var fileEle = document.getElementById('fileLoader');
  var buttons = document.getElementById('buttons');
  var loadStatus = document.getElementById('loadStatus');

  fileEle.value = ''; // so that the change event is still fired after reloads

  fileEle.addEventListener('change', function() {
    var file = fileEle.files[0];
    if (!file) {
      return;
    }

    var src = file.name;
    var safeSrc = src.replace(/</g, '&lt;');
    document.getElementById('tree').textContent = '';
    loadStatus.innerHTML = 'Reading <kbd>' + safeSrc + '</kbd>...';
    loadStatus.style.display = 'inline-block';
    loadZip(file)
      .then(function() { loadStatus.innerHTML = 'Loaded <kbd>' + safeSrc + '</kbd>.'; })
      .catch(function(e) {
        console.log(e)
        loadStatus.textContent = e;
      })
      .then(function() { fileEle.value = ''; });
  });

  document.getElementById('loadLocal').addEventListener('click', function() {
    fileEle.click();
  });

  document.getElementById('loadGithub').addEventListener('click', function() {
    var src = zipballUrl;
    var safeSrc = src.replace(/</g, '&lt;');
    document.getElementById('tree').textContent = '';
    loadStatus.innerHTML = 'Loading <kbd>' + safeSrc + '</kbd>... <span id="loadFraction"></span>';
    loadStatus.style.display = 'inline-block';
    var req = new XMLHttpRequest;

    req.addEventListener('load', function() {
      loadStatus.innerHTML = 'Reading <kbd>' + safeSrc + '</kbd>...';
      loadZip(req.response)
        .then(function() { loadStatus.innerHTML = 'Loaded <kbd>' + safeSrc + '</kbd>.'; })
        .catch(function(e) { loadStatus.textContent = e; });
    });

    req.addEventListener('error', function() {
      loadStatus.textContent = 'Error loading.';
    });

    var tick = false;
    var MB = Math.pow(2, 20)/10;
    var loadFraction = document.getElementById('loadFraction');
    req.addEventListener('progress', function(evt) {
      if (evt.lengthComputable) {
        var loaded = '' + Math.floor(evt.loaded/MB)/10;
        var total = '' + Math.ceil(evt.total/MB)/10;
        while (loaded.length < total.length) loaded += '\u00A0'; // nbsp
        loadFraction.textContent = loaded + 'MB / ' + total + 'MB';
      } else {
        loadFraction.textContent = tick ? '/' : '\\';
        tick = !tick;
      }
    });

    req.open('GET', zipballUrl);
    req.responseType = 'arraybuffer'; // todo check support
    req.send();
  });

  document.getElementById('failuresToggle').addEventListener('click', function() {
    var failList = document.getElementById('failList');
    failList.style.display = failList.style.display === 'none' ? '' : 'none';
  });

  var pauseButton = document.getElementById('pause');
  pauseButton.addEventListener('click', function() {
    if (backlogTasks.length === 0) return;
    if (!paused) {
      pause();
      pauseButton.value = 'Resume';
      pauseButton.className = 'btn btn-success btn-lg';
    } else {
      pauseButton.value = 'Pause';
      pauseButton.className = 'btn btn-primary btn-lg';
      resume();
    }
  });

  document.getElementById('cancel').addEventListener('click', function() {
    runningTasks.forEach(function(task) { task.cancelled = true; });
    backlogTasks = [];
    paused = false;

    document.getElementById('controls').style.display = 'none';
    pauseButton.value = 'Pause';
    pauseButton.className = 'btn btn-primary btn-lg';

    var runs = document.querySelectorAll('.run');
    for (var i = 0; i < runs.length; ++i) {
      runs[i].style.display = '';
    }
  });

  // Make some realms
  for (var i = 0; i < maxRunningTasks; ++i) {
    var iframe = document.body.appendChild(document.createElement('iframe'));
    iframe.style.display = 'none';
    iframes.push(iframe);
  }

  // Check if the environment reports errors from iframes with src = ''.
  runSources({ setup: '', source: 'throw new Error;', isModule: false, isAsync: false, needsAPI: false, path: ['test', 'path', 'test.js'] }, function(e) {
    if (e.message.match(/Script error\./i)) {
      iframeSrc = 'blank.html';
    }
  });


  // Register a service worker to handle module requests
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./worker.js').catch(function(err) {
      console.log('ServiceWorker registration failed: ', err);
    });
  }

});
