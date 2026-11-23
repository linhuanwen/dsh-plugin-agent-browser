const http = require("node:http");
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  const ms = Math.min(30000, Number(u.searchParams.get("ms") || 20000));
  console.log(new Date().toISOString(), "request", req.url, "delaying", ms, "ms");
  setTimeout(() => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>slow page</title><h1>slow page arrived after " + ms + " ms</h1>" +
            "<p>ticket-021 cancel test fixture</p>" +
            "<ul>" + Array.from({length: 40}, (_, i) => "<li>row " + (i + 1) + " of the slow fixture</li>").join("") + "</ul>");
    console.log(new Date().toISOString(), "responded", req.url);
  }, ms);
});
server.listen(7799, "127.0.0.1", () => console.log("slow fixture listening on http://127.0.0.1:7799/?ms=20000"));
