'use strict';

window.useTransformer = true;
window.addEventListener('load', function() {
  document.getElementById('make-transformer').addEventListener('click', function() {
    var transformSrc = document.getElementById('transformer').value;
    try {
      (0, eval)(transformSrc); // Well, what can you do.
    } catch(e) {
      alert('Defining transformer failed! See console.'); // TODO something better than this
      throw e;
    }
    document.getElementById('transform-specifier').style.display = 'none';
    document.getElementById('content').style.display = 'inline';
  });
});
