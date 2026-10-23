var CDN = "https://cdn.jsdelivr.net/gh/jxmath/assets@";
var SCOPE = new URL("./", self.registration.scope).pathname;
var PFX = SCOPE + "_g/";
var CACHE = "jm-games-v1";
var CACHE_MAX = 64 * 1024 * 1024;

var TYPES = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
  js: "application/javascript; charset=utf-8", mjs: "application/javascript; charset=utf-8",
  css: "text/css; charset=utf-8", json: "application/json; charset=utf-8",
  wasm: "application/wasm", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon",
  mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4", mp4: "video/mp4", webm: "video/webm",
  ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2",
  swf: "application/x-shockwave-flash", txt: "text/plain; charset=utf-8", xml: "application/xml",
  map: "application/json"
};

var partsCache = {};

self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

function typeFor(path, fallback) {
  var m = /\.([a-z0-9]+)$/i.exec(path.split("?")[0]);
  var t = m && TYPES[m[1].toLowerCase()];
  if (t) return t;
  return fallback && fallback !== "text/plain" ? fallback : "application/octet-stream";
}

function getParts(sha) {
  if (!partsCache[sha]) {
    partsCache[sha] = fetch(CDN + sha + "/parts.json")
      .then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return {}; });
  }
  return partsCache[sha];
}

function syncShim(sha) {
  return "<script>(function(){var o=XMLHttpRequest.prototype.open,p=" + JSON.stringify(PFX + sha + "/") + ",c=" + JSON.stringify(CDN + sha + "/") +
    ";XMLHttpRequest.prototype.open=function(m,u,a){if(a===false&&typeof u===\"string\"){try{var x=new URL(u,document.baseURI);if(x.origin===location.origin&&x.pathname.indexOf(p)===0){arguments[1]=c+x.pathname.slice(p.length)+x.search}}catch(e){}}return o.apply(this,arguments)}})();<\/script>";
}

function injectShim(text, sha) {
  var tag = syncShim(sha);
  if (/<head[^>]*>/i.test(text)) return text.replace(/<head[^>]*>/i, function (m) { return m + tag; });
  return tag + text;
}

function fixHtml(text) {
  return text
    .replace(/(?:\.\.\/)+storage\/emulatorjs\/data\//g, "https://cdn.emulatorjs.org/stable/data/")
    .replace(/(?:\.\.\/)+storage\/ruffle\/ruffle\.js/g, "https://unpkg.com/@ruffle-rs/ruffle");
}

function parseRange(h, size) {
  var m = /^bytes=(\d*)-(\d*)$/.exec(h || "");
  if (!m || (m[1] === "" && m[2] === "")) return null;
  var s, e;
  if (m[1] === "") { s = Math.max(0, size - parseInt(m[2], 10)); e = size - 1; }
  else { s = parseInt(m[1], 10); e = m[2] === "" ? size - 1 : Math.min(parseInt(m[2], 10), size - 1); }
  if (s > e || s >= size) return null;
  return [s, e];
}

function assemble(sha, path, info, req) {
  var names = info.parts, sizes = info.sizes, total = info.size;
  var range = parseRange(req.headers.get("range"), total);
  var start = range ? range[0] : 0, end = range ? range[1] : total - 1;
  var jobs = [], off = 0;
  for (var i = 0; i < names.length; i++) {
    var ps = off, pe = off + sizes[i] - 1;
    off += sizes[i];
    if (pe < start || ps > end) continue;
    jobs.push({ name: names[i], from: Math.max(start, ps) - ps, to: Math.min(end, pe) - ps, whole: start <= ps && end >= pe });
  }
  var idx = 0, reader = null;
  var stream = new ReadableStream({
    pull: function (ctrl) {
      function next() {
        if (reader) {
          return reader.read().then(function (r) {
            if (r.done) { reader = null; return next(); }
            ctrl.enqueue(r.value);
          });
        }
        if (idx >= jobs.length) { ctrl.close(); return; }
        var j = jobs[idx++];
        var dir = path.slice(0, path.lastIndexOf("/") + 1);
        var url = CDN + sha + "/" + encodeURI(dir + j.name);
        return fetch(url).then(function (r) {
          if (!r.ok) throw new Error("part " + r.status);
          if (j.whole) { reader = r.body.getReader(); return next(); }
          return r.arrayBuffer().then(function (b) {
            reader = new ReadableStream({
              start: function (c) { c.enqueue(new Uint8Array(b.slice(j.from, j.to + 1))); c.close(); }
            }).getReader();
            return next();
          });
        });
      }
      return next();
    }
  });
  var h = new Headers({
    "content-type": typeFor(path), "content-length": String(end - start + 1),
    "accept-ranges": "bytes", "cache-control": "public, max-age=31536000, immutable"
  });
  if (range) h.set("content-range", "bytes " + start + "-" + end + "/" + total);
  return new Response(stream, { status: range ? 206 : 200, headers: h });
}

function serve(req, sha, path) {
  return getParts(sha).then(function (parts) {
    var info = parts[path];
    if (info) return assemble(sha, path, info, req);
    var url = CDN + sha + "/" + encodeURI(path);
    var hdr = {};
    var rg = req.headers.get("range");
    if (rg) hdr.range = rg;
    return fetch(url, { headers: hdr }).then(function (r) {
      if (!r.ok && r.status !== 206) return r;
      var ct = typeFor(path, r.headers.get("content-type"));
      if (/\.html?$/i.test(path) && r.status === 200) {
        return r.text().then(function (t) {
          return new Response(injectShim(fixHtml(t), sha), { status: 200, headers: { "content-type": ct, "cache-control": "no-cache" } });
        });
      }
      var h = new Headers();
      h.set("content-type", ct);
      ["content-length", "content-range", "accept-ranges", "etag"].forEach(function (k) {
        if (r.headers.get(k)) h.set(k, r.headers.get(k));
      });
      h.set("cache-control", "public, max-age=31536000, immutable");
      return new Response(r.body, { status: r.status, headers: h });
    });
  });
}

function handle(req, sha, path) {
  var cacheable = !req.headers.get("range") && /^[0-9a-f]{40}$/.test(sha);
  if (!cacheable) return serve(req, sha, path);
  return caches.open(CACHE).then(function (cache) {
    return cache.match(req.url).then(function (hit) {
      if (hit) return hit;
      return serve(req, sha, path).then(function (res) {
        var len = parseInt(res.headers.get("content-length") || "0", 10);
        if (res.status === 200 && len <= CACHE_MAX && !/\.html?$/i.test(path)) {
          cache.put(req.url, res.clone()).catch(function () {});
        }
        return res;
      });
    });
  });
}

self.addEventListener("fetch", function (e) {
  var req = e.request;
  var url = new URL(req.url);
  if (url.origin !== location.origin || req.method !== "GET") return;
  var p = url.pathname;
  if (p.indexOf(PFX) === 0) {
    var rest = p.slice(PFX.length);
    var i = rest.indexOf("/");
    if (i < 1) return;
    var sha = rest.slice(0, i);
    var path = decodeURIComponent(rest.slice(i + 1));
    e.respondWith(handle(req, sha, path).catch(function () { return new Response("not found", { status: 404 }); }).then(function (res) {
      if (res.ok || (req.destination !== "iframe" && req.destination !== "document")) return res;
      return new Response("<!DOCTYPE html><title>404</title><h1>404</h1>", { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
    }));
    return;
  }
  if (p.indexOf(SCOPE) !== 0 || p === SCOPE || p === SCOPE + "sw.js" || p === SCOPE + "index.html" || !e.clientId) return;
  e.respondWith(self.clients.get(e.clientId).then(function (c) {
    var m = c && new URL(c.url).pathname.indexOf(PFX) === 0 && /^([^/]+)\/(g\/[^/]+\/)/.exec(new URL(c.url).pathname.slice(PFX.length));
    if (!m) return fetch(req);
    return handle(req, m[1], m[2] + decodeURIComponent(p.slice(SCOPE.length)));
  }).catch(function () { return fetch(req); }));
});
