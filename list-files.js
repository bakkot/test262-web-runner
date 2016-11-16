var path = require('path');
var fs = require('fs');

fs.writeFile('files.js', 'var files = ' + JSON.stringify((function list(dir) {
  var files = [];
  fs.readdirSync(dir).forEach(function(file) {
    if (file[0] === '.') return;
    if (fs.statSync(path.join(dir, file)).isDirectory()) {
      files.push({type: 'dir', name: file, files: list(path.join(dir, file))});
    } else if (file.match(/\.js$/) && !file.match(/_FIXTURE\.js/)) {
      files.push({type: 'file', name: file});
    }
  });
  return files;
})(path.join(__dirname, 'test262', 'test'), [])));

