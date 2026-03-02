/**
 * WitAnime Nuvio Provider Plugin
 * 
 * Scrapes witanime (Arabic anime streaming site) for video streams.
 * Compatible with Hermes JS engine — no async/await, uses Promise chains.
 * 
 * Exports: { getStreams(tmdbId, mediaType, season, episode) }
 */

var TMDB_API_KEY = "afab9a1cfcd043370e6a7ceb62949a8c";

var BASE_DOMAINS = ["witanime.pics", "witanime.cyou", "witanime.you"];

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
  // Strip anything not in the base64 alphabet
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
    })
  }).then(function (res) {
    if (!res.ok) {
      console.log("[WitAnime] HTTP " + res.status + " from " + BASE_DOMAINS[domainIndex] + ", trying next domain...");
      return fetchWithFallback(path, domainIndex + 1);
    }
    // Attach the working domain so callers know which base to use
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

  // Also fetch alternative titles to find romaji name
  var altTitlesUrl = "https://api.themoviedb.org/3/" + mediaType + "/" + tmdbId + "/alternative_titles?api_key=" + TMDB_API_KEY;
  var altTitlesPromise = fetch(altTitlesUrl, { headers: { "User-Agent": DEFAULT_HEADERS["User-Agent"] } })
    .then(function (res) { return res.json(); })
    .catch(function () { return { results: [], titles: [] }; });

  return Promise.all([mainDataPromise, altTitlesPromise]).then(function (responses) {
    var data = responses[0];
    var altData = responses[1];

    var englishName = data.name || data.title || "";
    var originalName = data.original_name || data.original_title || "";

    // Extract romaji title from alternative titles
    // Look for: Japanese entry with iso_3166_1='JP', or title that's Latin script
    var altTitles = altData.results || altData.titles || [];
    var romajiTitle = "";

    for (var i = 0; i < altTitles.length; i++) {
      var alt = altTitles[i];
      var t = alt.title || "";
      // Check if it's a Latin-script title from Japan (romaji)
      if (alt.iso_3166_1 === "JP" && /^[\x20-\x7E]+$/.test(t)) {
        romajiTitle = t;
        break;
      }
    }

    // Also check if original_name is already romaji (Latin script)
    var isOriginalLatin = /^[\x20-\x7E]+$/.test(originalName.trim());
    if (!romajiTitle && isOriginalLatin && originalName) {
      romajiTitle = originalName;
    }

    console.log("[WitAnime] TMDB English name: " + englishName);
    console.log("[WitAnime] TMDB original name: " + originalName);
    console.log("[WitAnime] TMDB romaji title: " + romajiTitle);

    // Build title list: romaji first (witanime uses romaji), then English, then original
    var titles = [];
    if (romajiTitle) titles.push(romajiTitle);
    if (englishName && titles.indexOf(englishName) === -1) titles.push(englishName);
    if (originalName && titles.indexOf(originalName) === -1) titles.push(originalName);

    var primary = titles[0] || englishName;
    console.log("[WitAnime] Using primary title: " + primary);

    return { primary: primary, alternatives: titles.slice(1) };
  });
}

// ─── Step 1b: Search with title fallbacks ────────────────────────────────────

function searchWithFallbacks(titleInfo) {
  if (!titleInfo || !titleInfo.primary) return Promise.resolve([]);

  return searchAnime(titleInfo.primary).then(function (results) {
    if (results.length > 0) return results;

    // Try alternative titles sequentially
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
      // Search results are <a> tags with href containing /anime/slug/
      // Some <a> tags have class="overlay" and no text, so we filter those out
      var re = /href=["'](https?:\/\/[^"']*\/anime\/([^"'\/]+)\/)["'][^>]*>([^<]*)<\/a>/g;
      var m;
      while ((m = re.exec(html)) !== null) {
        var href = m[1];
        var slug = m[2];
        var name = m[3].trim();
        // Skip empty names (overlay links) and dedup by slug
        if (name && slug && results.findIndex(function (r) { return r.slug === slug; }) === -1) {
          results.push({ href: href, slug: slug, name: name });
        }
      }
      console.log("[WitAnime] Search found " + results.length + " results");
      if (results.length > 0) {
        console.log("[WitAnime] First result: " + results[0].name + " (" + results[0].slug + ")");
      }
      return results;
    });
}

// ─── Step 3: Pick best match for season ──────────────────────────────────────

function pickAnimeForSeason(results, title, season, mediaType) {
  if (!results || results.length === 0) return null;

  var titleLower = title.toLowerCase().replace(/[^a-z0-9]/g, "");

  // For movies, pick the first result whose name closely matches
  if (mediaType === "movie") {
    for (var i = 0; i < results.length; i++) {
      var nameLower = results[i].name.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (nameLower.indexOf(titleLower) !== -1 || titleLower.indexOf(nameLower) !== -1) {
        return results[i];
      }
    }
    return results[0];
  }

  // For TV: if season 1, prefer the result without "season N" in the slug
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

  // For season > 1, look for matching season number in slug
  var seasonPatterns = [
    "season-" + season,
    season + "nd-season",
    season + "rd-season",
    season + "th-season",
    "season-" + season,
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

  // Fallback: look for "Part N" patterns
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

  // Extract domain from the anime href
  var domainMatch = anime.href.match(/https?:\/\/([^\/]+)/);
  var domain = domainMatch ? domainMatch[1] : BASE_DOMAINS[0];

  if (mediaType === "movie") {
    // For movies, the anime page itself should have the player or single episode
    var moviePath = "/anime/" + anime.slug + "/";
    return fetchWithFallback(moviePath)
      .then(function (res) { return res.text(); })
      .then(function (html) {
        // Look for episode links on the anime page
        var epRe = /href=["'](https?:\/\/[^"']*\/episode\/[^"']+)["']/g;
        var m = epRe.exec(html);
        if (m) {
          var epUrl = m[1];
          // Normalize to use path only
          var pathMatch = epUrl.match(/\/episode\/[^"']+/);
          return { url: pathMatch ? pathMatch[0] : "/episode/" + anime.slug + "/", domain: domain };
        }
        return { url: "/episode/" + anime.slug + "/", domain: domain };
      });
  }

  // For TV shows, construct the episode URL
  // Pattern: /episode/{slug}-الحلقة-{N}/
  var episodePath = "/episode/" + anime.slug + "-%D8%A7%D9%84%D8%AD%D9%84%D9%82%D8%A9-" + episode + "/";
  return Promise.resolve({ url: episodePath, domain: domain });
}

// ─── Step 5: Extract encrypted embeds from episode page ──────────────────────

// Helper: compute paramOffset from config object {d: [...], k: "base64_index"}
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

// Helper: decode a single obfuscated resource string to a URL
function decodeResource(encoded, paramOffset) {
  if (!encoded || typeof encoded !== "string") return null;

  // Step 1: Reverse the string
  var reversed = reverseString(encoded);

  // Step 2: Strip all non-base64 characters (junk chars like #, !, @, %, ^, ~, *)
  var cleaned = reversed.replace(/[^A-Za-z0-9+/=]/g, "");

  // Step 3: Base64 decode
  var decoded = b64Decode(cleaned);

  // Step 4: Slice off trailing bytes if paramOffset > 0
  if (paramOffset && paramOffset > 0 && decoded.length > paramOffset) {
    decoded = decoded.slice(0, -paramOffset);
  }

  return decoded;
}

function extractEmbeds(episodeInfo) {
  return fetchWithFallback(episodeInfo.url)
    .then(function (res) { return res.text(); })
    .then(function (html) {
      console.log("[WitAnime] Episode page loaded (" + html.length + " bytes), extracting embeds...");

      var embeds = [];

      // ── Method 1: Extract _zG/_zH inline variables ──
      // The page embeds encrypted data as: var _zG="base64_json_string"; var _zH="base64_json_string";
      // _zG decodes to a JSON array of obfuscated resource strings
      // _zH decodes to a JSON array of config objects {d:[...], k:"...", v:"...", x:[...]}
      var zGMatch = html.match(/var\s+_zG\s*=\s*["']([^"']+)["']/);
      var zHMatch = html.match(/var\s+_zH\s*=\s*["']([^"']+)["']/);

      if (zGMatch) {
        try {
          // Decode _zG: it's a base64-encoded JSON array of obfuscated strings
          var zGDecoded = b64Decode(zGMatch[1]);
          console.log("[WitAnime] _zG decoded length: " + zGDecoded.length);

          var resources = JSON.parse(zGDecoded);
          console.log("[WitAnime] Found " + resources.length + " resources in _zG");

          // Decode _zH for config/offset data
          var configs = [];
          if (zHMatch) {
            try {
              // _zH may be truncated in the regex match or split across lines
              // Try to pad and decode
              var zHRaw = zHMatch[1];
              while (zHRaw.length % 4 !== 0) zHRaw += "=";
              var zHDecoded = b64Decode(zHRaw);
              // The JSON might be truncated, try to parse
              // If it fails, try adding the closing bracket
              try {
                configs = JSON.parse(zHDecoded);
              } catch (e2) {
                // Try to recover partial JSON
                var lastBrace = zHDecoded.lastIndexOf("}");
                if (lastBrace !== -1) {
                  configs = JSON.parse(zHDecoded.substring(0, lastBrace + 1) + "]");
                }
              }
              console.log("[WitAnime] Parsed " + configs.length + " config entries from _zH");
            } catch (e) {
              console.log("[WitAnime] _zH parse error (non-fatal): " + e.message);
            }
          }

          // Decode each resource
          for (var i = 0; i < resources.length; i++) {
            try {
              var offset = (configs.length > i) ? getParamOffset(configs[i]) : 0;
              var decoded = decodeResource(resources[i], offset);

              if (decoded && (decoded.indexOf("http") === 0 || decoded.indexOf("//") === 0)) {
                if (decoded.indexOf("//") === 0) decoded = "https:" + decoded;

                // Append yonaplay API key if needed
                if (decoded.indexOf("yonaplay.net") !== -1 && decoded.indexOf("apiKey") === -1) {
                  decoded += (decoded.indexOf("?") !== -1 ? "&" : "?") + "apiKey=1c0f3441-e3c2-4023-9e8b-bee77ff59adf";
                }

                console.log("[WitAnime] Decoded embed URL: " + decoded);
                embeds.push(decoded);
              } else {
                console.log("[WitAnime] Resource " + i + " decoded but not a URL: " + (decoded ? decoded.substring(0, 50) : "null"));
              }
            } catch (e) {
              console.log("[WitAnime] Decode error for resource " + i + ": " + e.message);
            }
          }
        } catch (e) {
          console.log("[WitAnime] _zG parse error: " + e.message);
        }
      } else {
        console.log("[WitAnime] No _zG variable found in page");
      }

      // ── Method 2: Try direct resourceRegistry/configRegistry variables ──
      if (embeds.length === 0) {
        var resourceMatch = html.match(/resourceRegistry\s*=\s*(\[[^\]]*\])/);
        if (resourceMatch) {
          console.log("[WitAnime] Found resourceRegistry, decoding...");
          try {
            var resources2 = JSON.parse(resourceMatch[1].replace(/'/g, '"'));
            for (var i = 0; i < resources2.length; i++) {
              var decoded2 = decodeResource(resources2[i], 0);
              if (decoded2 && decoded2.indexOf("http") === 0) {
                embeds.push(decoded2);
              }
            }
          } catch (e) {
            console.log("[WitAnime] resourceRegistry parse error: " + e.message);
          }
        }
      }

      // ── Method 3: Fallback — direct iframe extraction ──
      if (embeds.length === 0) {
        console.log("[WitAnime] No encrypted data found, trying direct iframe extraction...");
        var iframeRe = /iframe[^>]+src=["']([^"']+)["']/gi;
        var m;
        while ((m = iframeRe.exec(html)) !== null) {
          var src = m[1];
          if (src.indexOf("witanime") === -1 && src.indexOf("google") === -1 &&
            src.indexOf("facebook") === -1 && src.indexOf("ads") === -1) {
            if (src.indexOf("//") === 0) src = "https:" + src;
            embeds.push(src);
          }
        }
      }

      console.log("[WitAnime] Total embeds extracted: " + embeds.length);
      return { embeds: embeds, domain: episodeInfo.domain };
    });
}

// ─── Step 6: Resolve embed URLs to stream URLs ──────────────────────────────

// Identify host name from embed URL for labeling
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
    if (host.indexOf("yourupload") !== -1) return "YourUpload";
    if (host.indexOf("dailymotion") !== -1) return "Dailymotion";
    return host.split(".")[0].charAt(0).toUpperCase() + host.split(".")[0].slice(1);
  } catch (e) {
    return "Unknown";
  }
}

// Guess quality from server button text or URL
function guessQuality(url) {
  var u = url.toLowerCase();
  if (u.indexOf("fhd") !== -1 || u.indexOf("1080") !== -1) return "1080p";
  if (u.indexOf("hd") !== -1 || u.indexOf("720") !== -1) return "720p";
  if (u.indexOf("sd") !== -1 || u.indexOf("480") !== -1) return "480p";
  return "auto";
}

function resolveEmbed(embedUrl) {
  if (!embedUrl) return Promise.resolve([]);

  var hostLabel = getHostLabel(embedUrl);
  var quality = guessQuality(embedUrl);
  console.log("[WitAnime] Resolving " + hostLabel + ": " + embedUrl);

  // Try to fetch the embed page and extract direct video URLs
  return fetch(embedUrl, {
    headers: Object.assign({}, DEFAULT_HEADERS, {
      "Referer": "https://" + BASE_DOMAINS[0] + "/"
    }),
    redirect: "follow"
  })
    .then(function (res) {
      if (!res.ok) {
        console.log("[WitAnime] " + hostLabel + " returned HTTP " + res.status + ", returning embed URL directly");
        // Return the embed URL itself — the Nuvio app webview will handle it
        return [{
          name: "WitAnime",
          title: hostLabel + " " + quality + " (Arabic Sub)",
          url: embedUrl,
          quality: quality,
          headers: { "Referer": "https://" + BASE_DOMAINS[0] + "/" }
        }];
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
            headers: { "Referer": embedUrl, "Origin": "https://" + hostLabel.toLowerCase() + ".net" }
          });
        }

        // Look for .mp4 URLs
        var mp4Re = /(https?:\/\/[^"'\s\\]+\.mp4[^"'\s\\]*)/g;
        while ((m = mp4Re.exec(html)) !== null) {
          var mp4Url = m[1].replace(/\\/g, "");
          // Filter out asset/image mp4 names
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
              fileUrl.indexOf(".png") === -1 && fileUrl.indexOf(".ico") === -1 &&
              fileUrl.indexOf(".jpg") === -1) {
              streams.push({
                name: "WitAnime",
                title: hostLabel + " Stream (Arabic Sub)",
                url: fileUrl.replace(/\\/g, ""),
                quality: quality,
                headers: { "Referer": embedUrl }
              });
            }
          }
        }

        // If no direct streams found, return the embed URL itself
        // The Nuvio app webview can load and play the embed
        if (streams.length === 0) {
          console.log("[WitAnime] No direct stream URLs found in " + hostLabel + " page (" + html.length + " bytes), returning embed URL");
          streams.push({
            name: "WitAnime",
            title: hostLabel + " " + quality + " (Arabic Sub)",
            url: embedUrl,
            quality: quality,
            headers: { "Referer": "https://" + BASE_DOMAINS[0] + "/" }
          });
        } else {
          console.log("[WitAnime] Extracted " + streams.length + " direct stream(s) from " + hostLabel);
        }

        return streams;
      });
    })
    .catch(function (err) {
      console.log("[WitAnime] " + hostLabel + " resolve error: " + err.message + ", returning embed URL");
      // Even on error, return the embed URL as a fallback
      return [{
        name: "WitAnime",
        title: hostLabel + " " + quality + " (Arabic Sub)",
        url: embedUrl,
        quality: quality,
        headers: { "Referer": "https://" + BASE_DOMAINS[0] + "/" }
      }];
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
            console.log("[WitAnime] No matching anime found in search results");
            return { embeds: [], domain: null };
          }
          console.log("[WitAnime] Selected anime: " + anime.name + " (" + anime.slug + ")");
          return getEpisodeUrl(anime, episode || 1, mediaType)
            .then(function (episodeInfo) {
              if (!episodeInfo || !episodeInfo.url) {
                console.log("[WitAnime] No episode URL found");
                return { embeds: [], domain: null };
              }
              console.log("[WitAnime] Episode URL: " + episodeInfo.url);
              return extractEmbeds(episodeInfo);
            });
        })
        .then(function (embedData) {
          if (!embedData || !embedData.embeds || embedData.embeds.length === 0) {
            console.log("[WitAnime] No embeds found");
            return [];
          }

          // Resolve all embeds in parallel
          var resolvePromises = embedData.embeds.map(function (embedUrl) {
            return resolveEmbed(embedUrl).catch(function () { return []; });
          });

          return Promise.all(resolvePromises).then(function (results) {
            var allStreams = [];
            for (var i = 0; i < results.length; i++) {
              for (var j = 0; j < results[i].length; j++) {
                allStreams.push(results[i][j]);
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
    })
    .catch(function (err) {
      console.log("[WitAnime] Fatal error: " + err.message);
      return [];
    });
}

module.exports = { getStreams: getStreams };
