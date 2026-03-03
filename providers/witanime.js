/**
 * WitAnime Nuvio Provider Plugin
 * 
 * Scrapes witanime (Arabic anime streaming site) for video streams.
 * Compatible with Hermes JS engine — no async/await, uses Promise chains.
 * 
 * Exports: { getStreams(tmdbId, mediaType, season, episode) }
 */

var TMDB_API_KEY = "afab9a1cfcd043370e6a7ceb62949a8c";

var BASE_DOMAINS = ["witanime.you", "witanime.pics", "witanime.cyou"];

var DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ar,en-US;q=0.9,en;q=0.8"
};

// ─── Base64 decode (no atob in Hermes) ───────────────────────────────────────

var B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

function b64Decode(input) {
  var str = "";
  var i = 0;
  input = input.replace(/[^A-Za-z0-9+/=]/g, "");
  while (i < input.length) {
    var enc1 = B64_CHARS.indexOf(input.charAt(i++));
    var enc2 = B64_CHARS.indexOf(input.charAt(i++));
    var enc3 = B64_CHARS.indexOf(input.charAt(i++));
    var enc4 = B64_CHARS.indexOf(input.charAt(i++));
    var chr1 = (enc1 << 2) | (enc2 >> 4);
    var chr2 = ((enc2 & 15) << 4) | (enc3 >> 2);
    var chr3 = ((enc3 & 3) << 6) | enc4;
    str += String.fromCharCode(chr1);
    if (enc3 !== 64) str += String.fromCharCode(chr2);
    if (enc4 !== 64) str += String.fromCharCode(chr3);
  }
  return str;
}

function reverseString(s) { return s.split("").reverse().join(""); }

// ─── XOR decrypt hex-encoded string ──────────────────────────────────────────

function xorDecrypt(hexStr, key) {
  var result = "";
  for (var i = 0; i < hexStr.length; i += 2) {
    var byte = parseInt(hexStr.substr(i, 2), 16);
    var keyByte = key.charCodeAt((i / 2) % key.length);
    result += String.fromCharCode(byte ^ keyByte);
  }
  return result;
}

// ─── P.A.C.K.E.R. unpacker for hlswish/filemoon-type hosts ──────────────────

function unpackPacker(packed) {
  // Position-based parser to handle escaped quotes in payloads
  // Structure: eval(function(p,a,c,k,e,d){...}('payload',base,count,'dict'.split('|'),0,{}))

  // Find the dictionary using the split('|') anchor
  var splitIdx = packed.lastIndexOf(".split('|')");
  if (splitIdx === -1) return null;

  // Find the dictionary: search backwards for ,'
  var dictStart = packed.lastIndexOf(",'", splitIdx);
  if (dictStart === -1) return null;
  var dict = packed.substring(dictStart + 2, splitIdx);

  // Find base and count: search backwards for ,base,count pattern
  var beforeDict = packed.substring(0, dictStart);
  var countMatch = beforeDict.match(/,\s*(\d+)\s*,\s*(\d+)\s*$/);
  if (!countMatch) return null;
  var a = parseInt(countMatch[1], 10);
  var c = parseInt(countMatch[2], 10);

  // Find the payload: between }(' and ,base,count
  var payloadEnd = beforeDict.length - countMatch[0].length;
  var funcEnd = packed.indexOf("}('");
  if (funcEnd === -1) {
    funcEnd = packed.indexOf("}(\"");
    if (funcEnd === -1) return null;
  }
  var payloadStart = funcEnd + 3;
  var p = packed.substring(payloadStart, payloadEnd);
  // Remove trailing quote
  if (p.charAt(p.length - 1) === "'" || p.charAt(p.length - 1) === '"') {
    p = p.substring(0, p.length - 1);
  }

  var k = dict.split("|");

  function baseN(val, base) {
    var alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    if (val < base) return alphabet.charAt(val);
    return baseN(Math.floor(val / base), base) + alphabet.charAt(val % base);
  }

  while (c--) {
    if (k[c]) {
      p = p.replace(new RegExp("\\b" + baseN(c, a) + "\\b", "g"), k[c]);
    }
  }

  return p;
}

// ─── Utility: safe fetch with domain fallback ────────────────────────────────

function fetchWithFallback(path, domainIndex) {
  if (domainIndex === undefined) domainIndex = 0;
  if (domainIndex >= BASE_DOMAINS.length) {
    return Promise.reject(new Error("All domains failed for path: " + path));
  }
  var url = "https://" + BASE_DOMAINS[domainIndex] + path;
  console.log("[WitAnime] Trying: " + url);
  return fetch(url, {
    headers: Object.assign({}, DEFAULT_HEADERS, {
      "Referer": "https://" + BASE_DOMAINS[domainIndex] + "/"
    }),
    redirect: "follow"
  }).then(function (res) {
    if (!res.ok) {
      console.log("[WitAnime] HTTP " + res.status + " from " + BASE_DOMAINS[domainIndex]);
      return fetchWithFallback(path, domainIndex + 1);
    }
    res._workingDomain = BASE_DOMAINS[domainIndex];
    return res;
  }).catch(function (err) {
    console.log("[WitAnime] Fetch error: " + err.message);
    return fetchWithFallback(path, domainIndex + 1);
  });
}

// ─── TMDB title lookup ───────────────────────────────────────────────────────

function getTmdbTitle(tmdbId, mediaType) {
  var url = "https://api.themoviedb.org/3/" + mediaType + "/" + tmdbId + "?api_key=" + TMDB_API_KEY + "&language=en-US";
  var mainP = fetch(url, { headers: { "User-Agent": DEFAULT_HEADERS["User-Agent"] } })
    .then(function (r) { return r.json(); });
  var altUrl = "https://api.themoviedb.org/3/" + mediaType + "/" + tmdbId + "/alternative_titles?api_key=" + TMDB_API_KEY;
  var altP = fetch(altUrl, { headers: { "User-Agent": DEFAULT_HEADERS["User-Agent"] } })
    .then(function (r) { return r.json(); })
    .catch(function () { return { results: [], titles: [] }; });

  return Promise.all([mainP, altP]).then(function (res) {
    var data = res[0], altData = res[1];
    var englishName = data.name || data.title || "";
    var originalName = data.original_name || data.original_title || "";
    var altTitles = altData.results || altData.titles || [];
    var romajiTitle = "";

    for (var i = 0; i < altTitles.length; i++) {
      var t = altTitles[i].title || "";
      if (altTitles[i].iso_3166_1 === "JP" && /^[\x20-\x7E]+$/.test(t)) {
        romajiTitle = t;
        break;
      }
    }
    if (!romajiTitle && /^[\x20-\x7E]+$/.test(originalName.trim()) && originalName) {
      romajiTitle = originalName;
    }

    var titles = [];
    if (romajiTitle) titles.push(romajiTitle);
    if (englishName && titles.indexOf(englishName) === -1) titles.push(englishName);
    if (originalName && titles.indexOf(originalName) === -1) titles.push(originalName);
    return { primary: titles[0] || englishName, alternatives: titles.slice(1) };
  });
}

// ─── Search & select ─────────────────────────────────────────────────────────

function searchWithFallbacks(titleInfo) {
  if (!titleInfo || !titleInfo.primary) return Promise.resolve([]);
  return searchAnime(titleInfo.primary).then(function (results) {
    if (results.length > 0) return results;
    var alts = titleInfo.alternatives || [];
    if (alts.length === 0) return results;
    return searchAnime(alts[0]).then(function (r2) {
      if (r2.length > 0 || alts.length <= 1) return r2;
      return searchAnime(alts[1]);
    });
  });
}

function searchAnime(title) {
  var searchPath = "/?search_param=animes&s=" + encodeURIComponent(title);
  return fetchWithFallback(searchPath)
    .then(function (res) { return res.text(); })
    .then(function (html) {
      var results = [];
      var re = /href=["'](https?:\/\/[^"']*\/anime\/([^"'\/]+)\/)[^>]*>([^<]*)<\/a>/g;
      var m;
      while ((m = re.exec(html)) !== null) {
        var name = m[3].trim();
        if (name && m[2] && results.findIndex(function (r) { return r.slug === m[2]; }) === -1) {
          results.push({ href: m[1], slug: m[2], name: name });
        }
      }
      console.log("[WitAnime] Search found " + results.length + " results");
      return results;
    });
}

function pickAnimeForSeason(results, title, season, mediaType) {
  if (!results || results.length === 0) return null;
  if (mediaType === "movie") {
    var tl = title.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (var i = 0; i < results.length; i++) {
      var nl = results[i].name.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (nl.indexOf(tl) !== -1 || tl.indexOf(nl) !== -1) return results[i];
    }
    return results[0];
  }

  if (season === 1) {
    for (var i = 0; i < results.length; i++) {
      var s = results[i].slug.toLowerCase();
      if (s.indexOf("season") === -1 && s.indexOf("part") === -1 &&
        s.indexOf("2nd") === -1 && s.indexOf("3rd") === -1 && s.indexOf("4th") === -1 &&
        s.indexOf("final") === -1 && s.indexOf("ova") === -1 &&
        s.indexOf("movie") === -1 && s.indexOf("special") === -1) return results[i];
    }
    return results[0];
  }

  var patterns = ["season-" + season, season + "nd-season", season + "rd-season", season + "th-season", "-" + season + "-"];
  for (var i = 0; i < results.length; i++) {
    var sl = results[i].slug.toLowerCase();
    for (var j = 0; j < patterns.length; j++) {
      if (sl.indexOf(patterns[j]) !== -1) return results[i];
    }
  }
  var pp = ["part-" + season, "part" + season];
  for (var i = 0; i < results.length; i++) {
    var sl = results[i].slug.toLowerCase();
    for (var j = 0; j < pp.length; j++) { if (sl.indexOf(pp[j]) !== -1) return results[i]; }
  }
  return results[0];
}

// ─── Get episode URL ─────────────────────────────────────────────────────────

function getEpisodeUrl(anime, episode, mediaType) {
  if (!anime) return Promise.reject(new Error("No anime found"));
  var dm = (anime.href.match(/https?:\/\/([^\/]+)/) || [])[1] || BASE_DOMAINS[0];

  if (mediaType === "movie") {
    return fetchWithFallback("/anime/" + anime.slug + "/")
      .then(function (res) { return res.text(); })
      .then(function (html) {
        var m = /href=["'](https?:\/\/[^"']*\/episode\/[^"']+)["']/.exec(html);
        var path = m ? (m[1].match(/\/episode\/[^"']+/) || ["/episode/" + anime.slug + "/"])[0] : "/episode/" + anime.slug + "/";
        return { url: path, domain: dm };
      });
  }
  return Promise.resolve({ url: "/episode/" + anime.slug + "-%D8%A7%D9%84%D8%AD%D9%84%D9%82%D8%A9-" + episode + "/", domain: dm });
}

// ─── Extract download links (px9 system) ─────────────────────────────────────

function extractDownloadLinks(html) {
  var downloads = [];
  var mMatch = html.match(/var\s+_m\s*=\s*(\{[^}]+\})/);
  if (!mMatch) return downloads;

  try {
    var xorKey = b64Decode(JSON.parse(mMatch[1]).r);
    var tMatch = html.match(/var\s+_t\s*=\s*(\{[^}]+\})/);
    var count = 2;
    if (tMatch) try { count = parseInt(JSON.parse(tMatch[1]).l, 10) || 2; } catch (e) { }

    var sMatch = html.match(/var\s+_s\s*=\s*(\[[^\]]+\])/);
    var sequences = [];
    if (sMatch) try { sequences = JSON.parse(sMatch[1].replace(/'/g, '"')); } catch (e) { }

    for (var i = 0; i < count; i++) {
      var pMatch = html.match(new RegExp("var\\s+_p" + i + "\\s*=\\s*(\\[[^\\]]+\\])"));
      if (!pMatch) continue;
      try {
        var chunks = JSON.parse(pMatch[1].replace(/'/g, '"'));
        var decrypted = chunks.map(function (c) { return xorDecrypt(c, xorKey); });
        var finalUrl = "";
        if (sequences[i]) {
          var seq = JSON.parse(xorDecrypt(sequences[i], xorKey));
          var arranged = new Array(seq.length);
          for (var j = 0; j < seq.length; j++) arranged[seq[j]] = decrypted[j];
          finalUrl = arranged.join("");
        } else {
          finalUrl = decrypted.join("");
        }
        if (finalUrl && finalUrl.indexOf("http") === 0) {
          console.log("[WitAnime] Download link " + i + ": " + finalUrl.substring(0, 80));
          downloads.push({ url: finalUrl, index: i });
        }
      } catch (e) { console.log("[WitAnime] Download decode error: " + e.message); }
    }
  } catch (e) { console.log("[WitAnime] Download extraction error: " + e.message); }
  return downloads;
}

// ─── Extract embed URLs (_zG/_zH system) ─────────────────────────────────────

function extractEmbeds(html) {
  var embeds = [];
  var zGMatch = html.match(/var\s+_zG\s*=\s*["']([^"']+)["']/);
  var zHMatch = html.match(/var\s+_zH\s*=\s*["']([^"']+)["']/);
  if (!zGMatch) return embeds;

  try {
    var resources = JSON.parse(b64Decode(zGMatch[1]));
    var configs = [];
    if (zHMatch) {
      try {
        var raw = zHMatch[1]; while (raw.length % 4) raw += "=";
        var d = b64Decode(raw);
        try { configs = JSON.parse(d); } catch (e) {
          var lb = d.lastIndexOf("}");
          if (lb !== -1) configs = JSON.parse(d.substring(0, lb + 1) + "]");
        }
      } catch (e) { }
    }

    for (var i = 0; i < resources.length; i++) {
      try {
        var c = configs[i];
        var offset = (c && c.d && c.k) ? (function () {
          var idx = parseInt(b64Decode(c.k), 10);
          return (!isNaN(idx) && idx >= 0 && idx < c.d.length) ? c.d[idx] : 0;
        })() : 0;
        var rev = reverseString(resources[i]).replace(/[^A-Za-z0-9+/=]/g, "");
        var dec = b64Decode(rev);
        if (offset > 0 && dec.length > offset) dec = dec.slice(0, -offset);
        if (dec && (dec.indexOf("http") === 0 || dec.indexOf("//") === 0)) {
          if (dec.indexOf("//") === 0) dec = "https:" + dec;
          embeds.push(dec);
        }
      } catch (e) { }
    }
  } catch (e) { }
  console.log("[WitAnime] Found " + embeds.length + " embed URLs");
  return embeds;
}

// ─── URL validation helper ───────────────────────────────────────────────────

var URL_BLACKLIST = [
  "googletagmanager", "google-analytics", "googlesyndication", "gstatic.com",
  "cloudflareinsights", "cloudflare.com/cdn-cgi", "beacon.min.js",
  "doubleclick.net", "facebook.com", "twitter.com", "yandex.ru",
  "jquery", "bootstrap", "fontawesome", "recaptcha",
  "matomo", "piwik", "analytics", "tracker", "pixel",
  "ads.", "adserver", "pagead", "funding",
  ".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".woff", ".ttf",
  "favicon", "logo", "image", "assets/"
];

function isVideoUrl(url) {
  if (!url || url.length < 20) return false;
  var lower = url.toLowerCase();
  for (var i = 0; i < URL_BLACKLIST.length; i++) {
    if (lower.indexOf(URL_BLACKLIST[i]) !== -1) return false;
  }
  return true;
}

// ─── HOST RESOLVERS ──────────────────────────────────────────────────────────

function getHostLabel(url) {
  try {
    var h = (url.match(/https?:\/\/([^\/]+)/) || ["", "unknown"])[1].toLowerCase();
    if (h.indexOf("yonaplay") !== -1) return "Yonaplay";
    if (h.indexOf("videa") !== -1) return "Videa";
    if (h.indexOf("darkibox") !== -1) return "Darkibox";
    if (h.indexOf("hlswish") !== -1) return "HLSwish";
    if (h.indexOf("luluvdo") !== -1) return "Luluvdo";
    if (h.indexOf("hglink") !== -1) return "HGLink";
    if (h.indexOf("mp4upload") !== -1) return "MP4Upload";
    if (h.indexOf("mediafire") !== -1) return "MediaFire";
    if (h.indexOf("workupload") !== -1) return "Workupload";
    if (h.indexOf("wahmi") !== -1) return "Wahmi";
    if (h.indexOf("4shared") !== -1) return "4shared";
    if (h.indexOf("linkbox") !== -1) return "Linkbox";
    return h.split(".")[0].charAt(0).toUpperCase() + h.split(".")[0].slice(1);
  } catch (e) { return "Unknown"; }
}

// --- MediaFire: Extract direct MP4 download URL ---
function resolveMediaFire(url) {
  console.log("[WitAnime] Resolving MediaFire: " + url.substring(0, 80));
  return fetch(url, { headers: DEFAULT_HEADERS, redirect: "follow" })
    .then(function (res) { return res.ok ? res.text() : null; })
    .then(function (html) {
      if (!html) return null;
      var m = html.match(/href=["'](https?:\/\/download[^"']+)["']/i)
        || html.match(/(https?:\/\/download[^\s"']+\.mp4[^\s"']*)/);
      if (m) {
        console.log("[WitAnime] MediaFire direct URL found");
        return {
          name: "WitAnime",
          title: "MediaFire FHD (Arabic Sub)",
          url: m[1],
          quality: "1080p",
          headers: {}
        };
      }
      return null;
    })
    .catch(function () { return null; });
}

// --- Darkibox: Returns M3U8 URL directly in page HTML ---
function resolveDarkibox(url) {
  console.log("[WitAnime] Resolving Darkibox: " + url.substring(0, 80));
  return fetch(url, {
    headers: Object.assign({}, DEFAULT_HEADERS, { "Referer": "https://" + BASE_DOMAINS[0] + "/" }),
    redirect: "follow"
  })
    .then(function (res) { return res.ok ? res.text() : null; })
    .then(function (html) {
      if (!html) return null;
      var m3u8 = html.match(/(https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*)/);
      if (m3u8) {
        var streamUrl = m3u8[1].replace(/\\/g, "");
        // Clean up truncated query params
        if (streamUrl.indexOf("&s") === streamUrl.length - 2) {
          streamUrl = streamUrl.substring(0, streamUrl.length - 2);
        }
        console.log("[WitAnime] Darkibox M3U8 found");
        return {
          name: "WitAnime",
          title: "Darkibox HLS (Arabic Sub)",
          url: streamUrl,
          quality: "1080p",
          headers: { "Referer": url, "Origin": "https://darkibox.com" }
        };
      }
      return null;
    })
    .catch(function () { return null; });
}

// --- HLSwish/Filemoon: Unpack P.A.C.K.E.R. JS to find M3U8 ---
function resolveHlswish(url) {
  console.log("[WitAnime] Resolving HLSwish: " + url.substring(0, 80));
  var domain = (url.match(/https?:\/\/([^\/]+)/) || ["", "hlswish.com"])[1];
  return fetch(url, {
    headers: Object.assign({}, DEFAULT_HEADERS, { "Referer": "https://" + BASE_DOMAINS[0] + "/" }),
    redirect: "follow"
  })
    .then(function (res) { return res.ok ? res.text() : null; })
    .then(function (html) {
      if (!html) return null;

      // Try direct M3U8 first
      var m3u8 = html.match(/(https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*)/);
      if (m3u8) {
        console.log("[WitAnime] HLSwish direct M3U8 found");
        return {
          name: "WitAnime",
          title: "HLSwish HLS (Arabic Sub)",
          url: m3u8[1].replace(/\\/g, ""),
          quality: "1080p",
          headers: { "Referer": url, "Origin": "https://" + domain }
        };
      }

      // Try unpacking P.A.C.K.E.R.
      var packedMatch = html.match(/eval\(function\(p,a,c,k,e,[\w]\)\{[\s\S]*?\.split\('\|'\)/);
      if (packedMatch) {
        try {
          var unpacked = unpackPacker(packedMatch[0]);
          if (unpacked) {
            // Find M3U8 in unpacked JS
            m3u8 = unpacked.match(/(https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*)/);
            if (m3u8) {
              console.log("[WitAnime] HLSwish unpacked M3U8 found");
              return {
                name: "WitAnime",
                title: "HLSwish HLS (Arabic Sub)",
                url: m3u8[1].replace(/\\/g, ""),
                quality: "1080p",
                headers: { "Referer": url, "Origin": "https://" + domain }
              };
            }
            // Also check for MP4
            var mp4 = unpacked.match(/(https?:\/\/[^\s"'\\]+\.mp4[^\s"'\\]*)/);
            if (mp4) {
              console.log("[WitAnime] HLSwish unpacked MP4 found");
              return {
                name: "WitAnime",
                title: "HLSwish MP4 (Arabic Sub)",
                url: mp4[1].replace(/\\/g, ""),
                quality: "1080p",
                headers: { "Referer": url, "Origin": "https://" + domain }
              };
            }
          }
        } catch (e) {
          console.log("[WitAnime] HLSwish unpack error: " + e.message);
        }
      }

      return null;
    })
    .catch(function () { return null; });
}

// --- Luluvdo: Same as HLSwish (filemoon family) ---
function resolveLuluvdo(url) {
  console.log("[WitAnime] Resolving Luluvdo: " + url.substring(0, 80));
  var domain = (url.match(/https?:\/\/([^\/]+)/) || ["", "luluvdo.com"])[1];
  return fetch(url, {
    headers: Object.assign({}, DEFAULT_HEADERS, { "Referer": "https://" + BASE_DOMAINS[0] + "/" }),
    redirect: "follow"
  })
    .then(function (res) { return res.ok ? res.text() : null; })
    .then(function (html) {
      if (!html) return null;

      var m3u8 = html.match(/(https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*)/);
      if (m3u8) {
        return {
          name: "WitAnime",
          title: "Luluvdo HLS (Arabic Sub)",
          url: m3u8[1].replace(/\\/g, ""),
          quality: "1080p",
          headers: { "Referer": url, "Origin": "https://" + domain }
        };
      }

      var packedMatch = html.match(/eval\(function\(p,a,c,k,e,[\w]\)\{[\s\S]*?\.split\('\|'\)/);
      if (packedMatch) {
        try {
          var unpacked = unpackPacker(packedMatch[0]);
          if (unpacked) {
            m3u8 = unpacked.match(/(https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*)/);
            if (m3u8) {
              return {
                name: "WitAnime",
                title: "Luluvdo HLS (Arabic Sub)",
                url: m3u8[1].replace(/\\/g, ""),
                quality: "1080p",
                headers: { "Referer": url, "Origin": "https://" + domain }
              };
            }
          }
        } catch (e) { }
      }
      return null;
    })
    .catch(function () { return null; });
}

// --- Generic embed resolver (try M3U8/MP4/source extraction + P.A.C.K.E.R.) ---
function resolveGenericEmbed(url) {
  var hostLabel = getHostLabel(url);
  var domain = (url.match(/https?:\/\/([^\/]+)/) || ["", ""])[1];
  console.log("[WitAnime] Resolving " + hostLabel + ": " + url.substring(0, 80));

  return fetch(url, {
    headers: Object.assign({}, DEFAULT_HEADERS, { "Referer": "https://" + BASE_DOMAINS[0] + "/" }),
    redirect: "follow"
  })
    .then(function (res) { return res.ok ? res.text() : null; })
    .then(function (html) {
      if (!html) return null;

      // Try direct M3U8
      var m3u8 = html.match(/(https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*)/);
      if (m3u8 && isVideoUrl(m3u8[1])) {
        return {
          name: "WitAnime",
          title: hostLabel + " HLS (Arabic Sub)",
          url: m3u8[1].replace(/\\/g, ""),
          quality: "1080p",
          headers: { "Referer": url, "Origin": "https://" + domain }
        };
      }

      // Try P.A.C.K.E.R.
      var packed = html.match(/eval\(function\(p,a,c,k,e,[\w]\)\{[\s\S]*?\.split\('\|'\)/);
      if (packed) {
        try {
          var unpacked = unpackPacker(packed[0]);
          if (unpacked) {
            m3u8 = unpacked.match(/(https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*)/);
            if (m3u8 && isVideoUrl(m3u8[1])) {
              return {
                name: "WitAnime",
                title: hostLabel + " HLS (Arabic Sub)",
                url: m3u8[1].replace(/\\/g, ""),
                quality: "1080p",
                headers: { "Referer": url, "Origin": "https://" + domain }
              };
            }
            var mp4u = unpacked.match(/(https?:\/\/[^\s"'\\]+\.mp4[^\s"'\\]*)/);
            if (mp4u && isVideoUrl(mp4u[1])) {
              return {
                name: "WitAnime",
                title: hostLabel + " MP4 (Arabic Sub)",
                url: mp4u[1].replace(/\\/g, ""),
                quality: "1080p",
                headers: { "Referer": url, "Origin": "https://" + domain }
              };
            }
          }
        } catch (e) { }
      }

      // Try MP4 (direct in HTML)
      var mp4 = html.match(/(https?:\/\/[^\s"'\\]+\.mp4[^\s"'\\]*)/);
      if (mp4 && mp4[1].length > 50 && isVideoUrl(mp4[1])) {
        return {
          name: "WitAnime",
          title: hostLabel + " MP4 (Arabic Sub)",
          url: mp4[1].replace(/\\/g, ""),
          quality: "720p",
          headers: { "Referer": url }
        };
      }

      // Try file/source/video_url in JS config (NOT <script src=...>)
      var srcRe = /["'](?:file|source|video_url)["']\s*[:=]\s*["'](https?:\/\/[^"']+)["']/gi;
      var srcMatch;
      while ((srcMatch = srcRe.exec(html)) !== null) {
        if (isVideoUrl(srcMatch[1])) {
          return {
            name: "WitAnime",
            title: hostLabel + " Stream (Arabic Sub)",
            url: srcMatch[1].replace(/\\/g, ""),
            quality: "auto",
            headers: { "Referer": url }
          };
        }
      }

      // Try videojs player.src({src: "URL"}) pattern
      var vjsSrc = html.match(/src\s*:\s*["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/i);
      if (vjsSrc && isVideoUrl(vjsSrc[1])) {
        var isHls = vjsSrc[1].indexOf(".m3u8") !== -1;
        return {
          name: "WitAnime",
          title: hostLabel + (isHls ? " HLS" : " MP4") + " (Arabic Sub)",
          url: vjsSrc[1].replace(/\\/g, ""),
          quality: "auto",
          headers: { "Referer": url, "Origin": "https://" + domain }
        };
      }

      return null;
    })
    .catch(function () { return null; });
}

// ─── Smart resolver dispatcher ───────────────────────────────────────────────

function resolveSource(url) {
  var host = ((url.match(/https?:\/\/([^\/]+)/) || ["", ""])[1]).toLowerCase();

  // Download hosts
  if (host.indexOf("mediafire.com") !== -1) return resolveMediaFire(url);

  // Embed hosts with dedicated resolvers
  if (host.indexOf("darkibox") !== -1) return resolveDarkibox(url);
  if (host.indexOf("hlswish") !== -1) return resolveHlswish(url);
  if (host.indexOf("luluvdo") !== -1) return resolveLuluvdo(url);

  // mp4upload: Convert download URL to embed URL format
  if (host.indexOf("mp4upload") !== -1) {
    // Transform /CODE to /embed-CODE.html
    var mp4code = url.match(/mp4upload\.com\/(?:embed-)?([a-zA-Z0-9]+)/);
    if (mp4code) {
      var embedUrl = "https://www.mp4upload.com/embed-" + mp4code[1] + ".html";
      console.log("[WitAnime] MP4Upload embed URL: " + embedUrl);
      return resolveGenericEmbed(embedUrl);
    }
    return resolveGenericEmbed(url);
  }
  if (host.indexOf("swhoi") !== -1) return resolveGenericEmbed(url);
  if (host.indexOf("soraplay") !== -1) return resolveGenericEmbed(url);
  if (host.indexOf("hglink") !== -1) return resolveGenericEmbed(url);

  // Hosts that use JS redirects — follow the redirect URL
  if (host.indexOf("suzihazarpc") !== -1 || host.indexOf("swanksome") !== -1) {
    console.log("[WitAnime] Following JS redirect: " + url.substring(0, 80));
    return fetch(url, {
      headers: Object.assign({}, DEFAULT_HEADERS, { "Referer": "https://" + BASE_DOMAINS[0] + "/" }),
      redirect: "follow"
    })
      .then(function (res) { return res.ok ? res.text() : null; })
      .then(function (html) {
        if (!html) return null;
        var redirect = html.match(/window\.location\.replace\(['"]([^'"]+)['"]\)/);
        if (redirect) {
          console.log("[WitAnime] JS redirect to: " + redirect[1].substring(0, 80));
          return resolveGenericEmbed(redirect[1]);
        }
        // Try as generic embed anyway
        return null;
      })
      .catch(function () { return null; });
  }

  // Skip hosts that are known to be unreachable server-side
  if (host.indexOf("yonaplay") !== -1) {
    console.log("[WitAnime] Skipping Yonaplay (Cloudflare blocked)");
    return Promise.resolve(null);
  }
  if (host.indexOf("videa.hu") !== -1) {
    console.log("[WitAnime] Skipping Videa (requires browser)");
    return Promise.resolve(null);
  }
  if (host.indexOf("workupload") !== -1) {
    console.log("[WitAnime] Skipping Workupload (anti-bot)");
    return Promise.resolve(null);
  }
  if (host.indexOf("wahmi") !== -1) {
    console.log("[WitAnime] Skipping Wahmi (requires browser)");
    return Promise.resolve(null);
  }

  // Try generic resolution for any other unknown hosts
  return resolveGenericEmbed(url);
}

// ─── Main: getStreams ────────────────────────────────────────────────────────

function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[WitAnime] getStreams: tmdbId=" + tmdbId + " type=" + mediaType + " S" + season + "E" + episode);

  return getTmdbTitle(String(tmdbId), mediaType)
    .then(function (titleInfo) {
      if (!titleInfo || !titleInfo.primary) return [];
      return searchWithFallbacks(titleInfo)
        .then(function (results) {
          var anime = pickAnimeForSeason(results, titleInfo.primary, season || 1, mediaType);
          if (!anime) { console.log("[WitAnime] No anime found"); return []; }
          console.log("[WitAnime] Selected: " + anime.name + " (" + anime.slug + ")");
          return getEpisodeUrl(anime, episode || 1, mediaType);
        })
        .then(function (epInfo) {
          if (!epInfo || !epInfo.url) return [];
          console.log("[WitAnime] Episode: " + epInfo.url);

          return fetchWithFallback(epInfo.url)
            .then(function (res) { return res.text(); })
            .then(function (html) {
              // Collect all sources: download links + embeds
              var downloadLinks = extractDownloadLinks(html);
              var embedUrls = extractEmbeds(html);

              // Build unique URL list: downloads first, then embeds
              var allUrls = [];
              var seenHosts = {};
              downloadLinks.forEach(function (dl) {
                var h = ((dl.url.match(/https?:\/\/([^\/]+)/) || ["", ""])[1]).toLowerCase();
                // Only add one link per host
                if (!seenHosts[h]) {
                  seenHosts[h] = true;
                  allUrls.push(dl.url);
                }
              });
              embedUrls.forEach(function (u) {
                var h = ((u.match(/https?:\/\/([^\/]+)/) || ["", ""])[1]).toLowerCase();
                if (!seenHosts[h]) {
                  seenHosts[h] = true;
                  allUrls.push(u);
                }
              });

              console.log("[WitAnime] Total sources to resolve: " + allUrls.length);

              // Resolve all in parallel
              var promises = allUrls.map(function (u) {
                return resolveSource(u).catch(function () { return null; });
              });

              return Promise.all(promises).then(function (results) {
                var streams = [];
                var seenUrl = {};
                for (var i = 0; i < results.length; i++) {
                  var r = results[i];
                  if (r && r.url && !seenUrl[r.url]) {
                    seenUrl[r.url] = true;
                    streams.push(r);
                  }
                }
                console.log("[WitAnime] Total playable streams: " + streams.length);
                return streams;
              });
            });
        });
    })
    .catch(function (err) {
      console.log("[WitAnime] Fatal error: " + err.message);
      return [];
    });
}

module.exports = { getStreams: getStreams };
