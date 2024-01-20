var http = require('http');

http.createServer(function (req, res) {
  res.write('im alive lmao');
  res.end();
}).listen(8080);
