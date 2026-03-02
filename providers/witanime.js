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

// ─── Utility: reverse a string ───────────────────────────────────────────────

function reverseString(s) {
  return s.split("").reverse().join("");
}

// ─── Utility: XOR decrypt hex-encoded string with key ────────────────────────

function xorDecrypt(hexStr, key) {
  var result = "";
  for (var i = 0; i < hexStr.length; i += 2) {
    var byte = parseInt(hexStr.substr(i, 2), 16);
    var keyByte = key.charCodeAt((i / 2) % key.length);
    result += String.fromCharCode(byte ^ keyByte);
  }
  return result;
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
      console.log("[WitAnime] HTTP " + res.status + " from " + BASE_DOMAINS[domainIndex] + ", trying next domain...");
      return fetchWithFallback(path, domainIndex + 1);
    }
    res._workingDomain = BASE_DOMAINS[domainIndex];
    return res;
  }).catch(function (err) {
    console.log("[WitAnime] Fetch error from " + BASE_DOMAINS[domainIndex] + ": " + err.message);
    return fetchWithFallback(path, domainIndex + 1);
  });
}

// ─── Step 1: Get anime title from TMDB ───────────────────────────────────────

function getTmdbTitle(tmdbId, mediaType) {
  var url = "https://api.themoviedb.org/3/" + mediaType + "/" + tmdbId + "?api_key=" + TMDB_API_KEY + "&language=en-US";
  console.log("[WitAnime] Fetching TMDB info: " + url);

  var mainDataPromise = fetch(url, { headers: { "User-Agent": DEFAULT_HEADERS["User-Agent"] } })
    .then(function (res) { return res.json(); });

  var altTitlesUrl = "https://api.themoviedb.org/3/" + mediaType + "/" + tmdbId + "/alternative_titles?api_key=" + TMDB_API_KEY;
  var altTitlesPromise = fetch(altTitlesUrl, { headers: { "User-Agent": DEFAULT_HEADERS["User-Agent"] } })
    .then(function (res) { return res.json(); })
    .catch(function () { return { results: [], titles: [] }; });

  return Promise.all([mainDataPromise, altTitlesPromise]).then(function (responses) {
    var data = responses[0];
    var altData = responses[1];

    var englishName = data.name || data.title || "";
    var originalName = data.original_name || data.original_title || "";

    var altTitles = altData.results || altData.titles || [];
    var romajiTitle = "";

    for (var i = 0; i < altTitles.length; i++) {
      var alt = altTitles[i];
      var t = alt.title || "";
      if (alt.iso_3166_1 === "JP" && /^[\x20-\x7E]+$/.test(t)) {
        romajiTitle = t;
        break;
      }
    }

    var isOriginalLatin = /^[\x20-\x7E]+$/.test(originalName.trim());
    if (!romajiTitle && isOriginalLatin && originalName) {
      romajiTitle = originalName;
    }

    console.log("[WitAnime] TMDB English name: " + englishName);
    console.log("[WitAnime] TMDB romaji title: " + romajiTitle);

    var titles = [];
    if (romajiTitle) titles.push(romajiTitle);
    if (englishName && titles.indexOf(englishName) === -1) titles.push(englishName);
    if (originalName && titles.indexOf(originalName) === -1) titles.push(originalName);

    var primary = titles[0] || englishName;
    return { primary: primary, alternatives: titles.slice(1) };
  });
}

// ─── Step 1b: Search with title fallbacks ────────────────────────────────────

function searchWithFallbacks(titleInfo) {
  if (!titleInfo || !titleInfo.primary) return Promise.resolve([]);

  return searchAnime(titleInfo.primary).then(function (results) {
    if (results.length > 0) return results;

    var alts = titleInfo.alternatives || [];
    if (alts.length === 0) return results;

    console.log("[WitAnime] Primary search failed, trying alternative: " + alts[0]);
    return searchAnime(alts[0]).then(function (altResults) {
      if (altResults.length > 0) return altResults;
      if (alts.length > 1) {
        console.log("[WitAnime] Trying alternative: " + alts[1]);
        return searchAnime(alts[1]);
      }
      return altResults;
    });
  });
}

// ─── Step 2: Search witanime ─────────────────────────────────────────────────

function searchAnime(title) {
  var searchPath = "/?search_param=animes&s=" + encodeURIComponent(title);
  return fetchWithFallback(searchPath)
    .then(function (res) { return res.text(); })
    .then(function (html) {
      var results = [];
      var re = /href=["'](https?:\/\/[^"']*\/anime\/([^"'\/]+)\/)[^>]*>([^<]*)<\/a>/g;
      var m;
      while ((m = re.exec(html)) !== null) {
        var href = m[1];
        var slug = m[2];
        var name = m[3].trim();
        if (name && slug && results.findIndex(function (r) { return r.slug === slug; }) === -1) {
          results.push({ href: href, slug: slug, name: name });
        }
      }
      console.log("[WitAnime] Search found " + results.length + " results");
      return results;
    });
}

// ─── Step 3: Pick best match for season ──────────────────────────────────────

function pickAnimeForSeason(results, title, season, mediaType) {
  if (!results || results.length === 0) return null;

  var titleLower = title.toLowerCase().replace(/[^a-z0-9]/g, "");

  if (mediaType === "movie") {
    for (var i = 0; i < results.length; i++) {
      var nameLower = results[i].name.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (nameLower.indexOf(titleLower) !== -1 || titleLower.indexOf(nameLower) !== -1) {
        return results[i];
      }
    }
    return results[0];
  }

  if (season === 1) {
    for (var i = 0; i < results.length; i++) {
      var slug = results[i].slug.toLowerCase();
      if (slug.indexOf("season") === -1 && slug.indexOf("part") === -1 &&
        slug.indexOf("2nd") === -1 && slug.indexOf("3rd") === -1 &&
        slug.indexOf("4th") === -1 && slug.indexOf("final") === -1 &&
        slug.indexOf("ova") === -1 && slug.indexOf("movie") === -1 &&
        slug.indexOf("special") === -1) {
        return results[i];
      }
    }
    return results[0];
  }

  var seasonPatterns = [
    "season-" + season,
    season + "nd-season",
    season + "rd-season",
    season + "th-season",
    "-" + season + "-"
  ];

  for (var i = 0; i < results.length; i++) {
    var slug = results[i].slug.toLowerCase();
    for (var j = 0; j < seasonPatterns.length; j++) {
      if (slug.indexOf(seasonPatterns[j]) !== -1) {
        return results[i];
      }
    }
  }

  var partPatterns = ["part-" + season, "part" + season];
  for (var i = 0; i < results.length; i++) {
    var slug = results[i].slug.toLowerCase();
    for (var j = 0; j < partPatterns.length; j++) {
      if (slug.indexOf(partPatterns[j]) !== -1) {
        return results[i];
      }
    }
  }

  console.log("[WitAnime] No exact season match, falling back to first result");
  return results[0];
}

// ─── Step 4: Get episode URL ─────────────────────────────────────────────────

function getEpisodeUrl(anime, episode, mediaType) {
  if (!anime) return Promise.reject(new Error("No anime found"));

  var domainMatch = anime.href.match(/https?:\/\/([^\/]+)/);
  var domain = domainMatch ? domainMatch[1] : BASE_DOMAINS[0];

  if (mediaType === "movie") {
    var moviePath = "/anime/" + anime.slug + "/";
    return fetchWithFallback(moviePath)
      .then(function (res) { return res.text(); })
      .then(function (html) {
        var epRe = /href=["'](https?:\/\/[^"']*\/episode\/[^"']+)["']/g;
        var m = epRe.exec(html);
        if (m) {
          var epUrl = m[1];
          var pathMatch = epUrl.match(/\/episode\/[^"']+/);
          return { url: pathMatch ? pathMatch[0] : "/episode/" + anime.slug + "/", domain: domain };
        }
        return { url: "/episode/" + anime.slug + "/", domain: domain };
      });
  }

  var episodePath = "/episode/" + anime.slug + "-%D8%A7%D9%84%D8%AD%D9%84%D9%82%D8%A9-" + episode + "/";
  return Promise.resolve({ url: episodePath, domain: domain });
}

// ─── Step 5: Extract download links from episode page (px9 system) ───────────

function extractDownloadLinks(html) {
  var downloads = [];

  // Extract _m (XOR key)
  var mMatch = html.match(/var\s+_m\s*=\s*(\{[^}]+\})/);
  if (!mMatch) {
    console.log("[WitAnime] No _m variable found, skipping download links");
    return downloads;
  }

  try {
    var mObj = JSON.parse(mMatch[1]);
    var xorKey = b64Decode(mObj.r);
    console.log("[WitAnime] XOR key length: " + xorKey.length);

    // Extract _t (count)
    var tMatch = html.match(/var\s+_t\s*=\s*(\{[^}]+\})/);
    var count = 2; // default
    if (tMatch) {
      try {
        var tObj = JSON.parse(tMatch[1]);
        count = parseInt(tObj.l, 10) || 2;
      } catch (e) { }
    }

    // Extract _s (reorder sequences)
    var sMatch = html.match(/var\s+_s\s*=\s*(\[[^\]]+\])/);
    var sequences = [];
    if (sMatch) {
      try {
        sequences = JSON.parse(sMatch[1].replace(/'/g, '"'));
      } catch (e) {
        console.log("[WitAnime] _s parse error: " + e.message);
      }
    }

    // Extract _a (quality/auth info)
    var aMatch = html.match(/var\s+_a\s*=\s*(\[[\s\S]*?\]);/);
    var authInfo = [];
    if (aMatch) {
      try {
        authInfo = JSON.parse(aMatch[1].replace(/'/g, '"'));
      } catch (e) { }
    }

    // For each download group, extract _p{i} and reassemble
    for (var i = 0; i < count; i++) {
      var pRe = new RegExp("var\\s+_p" + i + "\\s*=\\s*(\\[[^\\]]+\\])");
      var pMatch = html.match(pRe);
      if (!pMatch) continue;

      try {
        var chunks = JSON.parse(pMatch[1].replace(/'/g, '"'));

        // Decrypt each chunk
        var decrypted = [];
        for (var c = 0; c < chunks.length; c++) {
          decrypted.push(xorDecrypt(chunks[c], xorKey));
        }

        // Get reorder sequence from _s
        var finalUrl = "";
        if (sequences[i]) {
          var seq = JSON.parse(xorDecrypt(sequences[i], xorKey));
          var arranged = new Array(seq.length);
          for (var j = 0; j < seq.length; j++) {
            arranged[seq[j]] = decrypted[j];
          }
          finalUrl = arranged.join("");
        } else {
          // Fallback: just concatenate
          finalUrl = decrypted.join("");
        }

        // Get service name from _a
        var serviceName = "";
        if (authInfo[i] && authInfo[i].t) {
          serviceName = xorDecrypt(authInfo[i].t, xorKey);
        }

        if (finalUrl && finalUrl.indexOf("http") === 0) {
          console.log("[WitAnime] Download link " + i + " (" + serviceName + "): " + finalUrl);
          downloads.push({ url: finalUrl, service: serviceName, index: i });
        }
      } catch (e) {
        console.log("[WitAnime] Download group " + i + " error: " + e.message);
      }
    }
  } catch (e) {
    console.log("[WitAnime] Download link extraction error: " + e.message);
  }

  return downloads;
}

// ─── Step 5b: Extract encrypted embeds from episode page ─────────────────────

function getParamOffset(configObj) {
  try {
    if (!configObj || !configObj.d || !configObj.k) return 0;
    var indexStr = b64Decode(configObj.k);
    var idx = parseInt(indexStr, 10);
    if (isNaN(idx) || idx < 0 || idx >= configObj.d.length) return 0;
    return configObj.d[idx];
  } catch (e) {
    return 0;
  }
}

function decodeResource(encoded, paramOffset) {
  if (!encoded || typeof encoded !== "string") return null;
  var reversed = reverseString(encoded);
  var cleaned = reversed.replace(/[^A-Za-z0-9+/=]/g, "");
  var decoded = b64Decode(cleaned);
  if (paramOffset && paramOffset > 0 && decoded.length > paramOffset) {
    decoded = decoded.slice(0, -paramOffset);
  }
  return decoded;
}

function extractEmbeds(html) {
  var embeds = [];

  var zGMatch = html.match(/var\s+_zG\s*=\s*["']([^"']+)["']/);
  var zHMatch = html.match(/var\s+_zH\s*=\s*["']([^"']+)["']/);

  if (zGMatch) {
    try {
      var zGDecoded = b64Decode(zGMatch[1]);
      var resources = JSON.parse(zGDecoded);
      console.log("[WitAnime] Found " + resources.length + " embed resources");

      var configs = [];
      if (zHMatch) {
        try {
          var zHRaw = zHMatch[1];
          while (zHRaw.length % 4 !== 0) zHRaw += "=";
          var zHDecoded = b64Decode(zHRaw);
          try {
            configs = JSON.parse(zHDecoded);
          } catch (e2) {
            var lastBrace = zHDecoded.lastIndexOf("}");
            if (lastBrace !== -1) {
              configs = JSON.parse(zHDecoded.substring(0, lastBrace + 1) + "]");
            }
          }
        } catch (e) { }
      }

      for (var i = 0; i < resources.length; i++) {
        try {
          var offset = (configs.length > i) ? getParamOffset(configs[i]) : 0;
          var decoded = decodeResource(resources[i], offset);

          if (decoded && (decoded.indexOf("http") === 0 || decoded.indexOf("//") === 0)) {
            if (decoded.indexOf("//") === 0) decoded = "https:" + decoded;
            if (decoded.indexOf("yonaplay.net") !== -1 && decoded.indexOf("apiKey") === -1) {
              decoded += (decoded.indexOf("?") !== -1 ? "&" : "?") + "apiKey=1c0f3441-e3c2-4023-9e8b-bee77ff59adf";
            }
            embeds.push(decoded);
          }
        } catch (e) { }
      }
    } catch (e) {
      console.log("[WitAnime] _zG parse error: " + e.message);
    }
  }

  return embeds;
}

// ─── Step 6: Resolve MediaFire page to direct download URL ───────────────────

function resolveMediaFire(mediafireUrl) {
  console.log("[WitAnime] Resolving MediaFire: " + mediafireUrl);
  return fetch(mediafireUrl, {
    headers: Object.assign({}, DEFAULT_HEADERS),
    redirect: "follow"
  })
    .then(function (res) {
      if (!res.ok) {
        console.log("[WitAnime] MediaFire returned HTTP " + res.status);
        return null;
      }
      return res.text();
    })
    .then(function (html) {
      if (!html) return null;

      // Look for the direct download URL
      var dlMatch = html.match(/href=["'](https?:\/\/download[^"']+\.mp4[^"']*)["']/i);
      if (!dlMatch) {
        dlMatch = html.match(/aria-label=["']Download file["'][^>]*href=["']([^"']+)["']/i);
      }
      if (!dlMatch) {
        dlMatch = html.match(/(https?:\/\/download[^\s"']+\.mp4[^\s"']*)/);
      }

      if (dlMatch) {
        var directUrl = dlMatch[1];
        console.log("[WitAnime] MediaFire direct URL: " + directUrl.substring(0, 80) + "...");
        return {
          name: "WitAnime",
          title: "MediaFire FHD (Arabic Sub)",
          url: directUrl,
          quality: "1080p",
          headers: {}
        };
      }

      console.log("[WitAnime] No direct download URL found on MediaFire page");
      return null;
    })
    .catch(function (err) {
      console.log("[WitAnime] MediaFire resolve error: " + err.message);
      return null;
    });
}

// ─── Step 6b: Resolve Workupload page to direct download URL ─────────────────

function resolveWorkupload(workuploadUrl) {
  console.log("[WitAnime] Resolving Workupload: " + workuploadUrl);
  return fetch(workuploadUrl, {
    headers: Object.assign({}, DEFAULT_HEADERS),
    redirect: "follow"
  })
    .then(function (res) {
      if (!res.ok) return null;
      return res.text();
    })
    .then(function (html) {
      if (!html) return null;

      // Workupload has a direct download button
      var dlMatch = html.match(/href=["'](https?:\/\/[^"']*\/dl\/[^"']+)["']/i);
      if (!dlMatch) {
        dlMatch = html.match(/id=["']download["'][^>]*href=["']([^"']+)["']/i);
      }
      if (!dlMatch) {
        dlMatch = html.match(/(https?:\/\/workupload\.com\/start\/[^\s"']+)/);
      }

      if (dlMatch) {
        var directUrl = dlMatch[1];
        console.log("[WitAnime] Workupload direct URL: " + directUrl);
        return {
          name: "WitAnime",
          title: "Workupload FHD (Arabic Sub)",
          url: directUrl,
          quality: "1080p",
          headers: { "Referer": workuploadUrl }
        };
      }

      return null;
    })
    .catch(function (err) {
      console.log("[WitAnime] Workupload resolve error: " + err.message);
      return null;
    });
}

// ─── Step 6c: Resolve embed URL (fallback) ───────────────────────────────────

function getHostLabel(url) {
  try {
    var hostMatch = url.match(/https?:\/\/([^\/]+)/);
    if (!hostMatch) return "Unknown";
    var host = hostMatch[1].toLowerCase();
    if (host.indexOf("yonaplay") !== -1) return "Yonaplay";
    if (host.indexOf("videa") !== -1) return "Videa";
    if (host.indexOf("streamtape") !== -1) return "Streamtape";
    if (host.indexOf("dood") !== -1) return "Doodstream";
    if (host.indexOf("vidmoly") !== -1) return "Vidmoly";
    if (host.indexOf("mp4upload") !== -1) return "MP4Upload";
    return host.split(".")[0].charAt(0).toUpperCase() + host.split(".")[0].slice(1);
  } catch (e) {
    return "Unknown";
  }
}

function resolveEmbed(embedUrl) {
  if (!embedUrl) return Promise.resolve([]);

  var hostLabel = getHostLabel(embedUrl);
  console.log("[WitAnime] Resolving embed " + hostLabel + ": " + embedUrl);

  return fetch(embedUrl, {
    headers: Object.assign({}, DEFAULT_HEADERS, {
      "Referer": "https://" + BASE_DOMAINS[0] + "/"
    }),
    redirect: "follow"
  })
    .then(function (res) {
      if (!res.ok) {
        console.log("[WitAnime] " + hostLabel + " returned HTTP " + res.status);
        return [];
      }
      return res.text().then(function (html) {
        var streams = [];

        // Look for .m3u8 URLs (HLS)
        var m3u8Re = /(https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*)/g;
        var m;
        while ((m = m3u8Re.exec(html)) !== null) {
          streams.push({
            name: "WitAnime",
            title: hostLabel + " HLS (Arabic Sub)",
            url: m[1].replace(/\\/g, ""),
            quality: "auto",
            headers: { "Referer": embedUrl }
          });
        }

        // Look for .mp4 URLs
        var mp4Re = /(https?:\/\/[^"'\s\\]+\.mp4[^"'\s\\]*)/g;
        while ((m = mp4Re.exec(html)) !== null) {
          var mp4Url = m[1].replace(/\\/g, "");
          if (mp4Url.indexOf("player") === -1 || mp4Url.length > 100) {
            streams.push({
              name: "WitAnime",
              title: hostLabel + " MP4 (Arabic Sub)",
              url: mp4Url,
              quality: "720p",
              headers: { "Referer": embedUrl }
            });
          }
        }

        // Look for "file"/"source" in JS config
        if (streams.length === 0) {
          var fileRe = /["']?(?:file|source|src|video_url)["']?\s*[:=]\s*["'](https?:\/\/[^"']+)["']/gi;
          while ((m = fileRe.exec(html)) !== null) {
            var fileUrl = m[1];
            if (fileUrl.indexOf(".js") === -1 && fileUrl.indexOf(".css") === -1 &&
              fileUrl.indexOf(".png") === -1 && fileUrl.indexOf(".ico") === -1) {
              streams.push({
                name: "WitAnime",
                title: hostLabel + " Stream (Arabic Sub)",
                url: fileUrl.replace(/\\/g, ""),
                quality: "auto",
                headers: { "Referer": embedUrl }
              });
            }
          }
        }

        if (streams.length > 0) {
          console.log("[WitAnime] Extracted " + streams.length + " stream(s) from " + hostLabel);
        }
        return streams;
      });
    })
    .catch(function (err) {
      console.log("[WitAnime] " + hostLabel + " resolve error: " + err.message);
      return [];
    });
}

// ─── Main: getStreams ────────────────────────────────────────────────────────

function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[WitAnime] getStreams called: tmdbId=" + tmdbId + " type=" + mediaType + " S" + season + "E" + episode);

  return getTmdbTitle(String(tmdbId), mediaType)
    .then(function (titleInfo) {
      if (!titleInfo || !titleInfo.primary) {
        console.log("[WitAnime] No title found from TMDB");
        return [];
      }
      return searchWithFallbacks(titleInfo)
        .then(function (results) {
          var anime = pickAnimeForSeason(results, titleInfo.primary, season || 1, mediaType);
          if (!anime) {
            console.log("[WitAnime] No matching anime found");
            return [];
          }
          console.log("[WitAnime] Selected anime: " + anime.name + " (" + anime.slug + ")");
          return getEpisodeUrl(anime, episode || 1, mediaType);
        })
        .then(function (episodeInfo) {
          if (!episodeInfo || !episodeInfo.url) return [];
          console.log("[WitAnime] Episode URL: " + episodeInfo.url);

          // Fetch the episode page
          return fetchWithFallback(episodeInfo.url)
            .then(function (res) { return res.text(); })
            .then(function (html) {
              console.log("[WitAnime] Episode page loaded (" + html.length + " bytes)");

              // ── Priority 1: Extract download links (MediaFire, Workupload) ──
              var downloadLinks = extractDownloadLinks(html);
              console.log("[WitAnime] Found " + downloadLinks.length + " download links");

              // ── Priority 2: Extract embed URLs (Yonaplay, Videa, etc.) ──
              var embedUrls = extractEmbeds(html);
              console.log("[WitAnime] Found " + embedUrls.length + " embed URLs");

              // Resolve download links first (they give direct MP4s)
              var downloadPromises = downloadLinks.map(function (dl) {
                if (dl.url.indexOf("mediafire.com") !== -1) {
                  return resolveMediaFire(dl.url);
                } else if (dl.url.indexOf("workupload.com") !== -1) {
                  return resolveWorkupload(dl.url);
                }
                // Unknown download service, skip
                return Promise.resolve(null);
              });

              // Resolve embeds as fallback
              var embedPromises = embedUrls.map(function (embedUrl) {
                return resolveEmbed(embedUrl).catch(function () { return []; });
              });

              return Promise.all(downloadPromises.concat(embedPromises)).then(function (results) {
                var allStreams = [];

                // Collect download results (single stream objects or null)
                for (var i = 0; i < downloadLinks.length; i++) {
                  if (results[i]) {
                    allStreams.push(results[i]);
                  }
                }

                // Collect embed results (arrays of streams)
                for (var i = downloadLinks.length; i < results.length; i++) {
                  var embedStreams = results[i];
                  if (Array.isArray(embedStreams)) {
                    for (var j = 0; j < embedStreams.length; j++) {
                      allStreams.push(embedStreams[j]);
                    }
                  }
                }

                // Deduplicate by URL
                var seen = {};
                var unique = [];
                for (var i = 0; i < allStreams.length; i++) {
                  if (!seen[allStreams[i].url]) {
                    seen[allStreams[i].url] = true;
                    unique.push(allStreams[i]);
                  }
                }

                console.log("[WitAnime] Total streams found: " + unique.length);
                return unique;
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
