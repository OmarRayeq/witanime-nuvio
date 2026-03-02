var BASE_URL = "https://witanime.cyou";

function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[WitAnime] Searching tmdbId=" + tmdbId);
  return fetch("https://api.themoviedb.org/3/" + mediaType + "/" + tmdbId + "?language=ar", {
    headers: { "Authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI4YjMzMmMzZjFkYjZjNmJkZGNmOGVhMzhjMzdmYjliYSIsInN1YiI6IjY0YjQ5YWJkMTk1YmJjMDBlMjNmMWIzMCJ9._kVGHOw0XqdkWsm0O-yRoTNx3Ugh6MVNyZ2nTgR0Pbk" }
  })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      var title = data.name || data.title || "";
      return searchAnime(title);
    })
    .then(function(animeUrl) {
      if (!animeUrl) return [];
      if (mediaType === "tv") return getEpisodeStreams(animeUrl, season, episode);
      return getMovieStreams(animeUrl);
    })
    .catch(function(err) {
      console.error("[WitAnime] Error:", err.message);
      return [];
    });
}

function searchAnime(title) {
  var url = BASE_URL + "/?search_param=animes&s=" + encodeURIComponent(title);
  return fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Referer": BASE_URL } })
    .then(function(res) { return res.text(); })
    .then(function(html) {
      var match = html.match(/href="(https?:\/\/[^"]*\/anime\/[^"]+\/)"/);
      return match ? match[1] : null;
    });
}

function getEpisodeStreams(animePageUrl, season, episode) {
  return fetch(animePageUrl, { headers: { "User-Agent": "Mozilla/5.0", "Referer": BASE_URL } })
    .then(function(res) { return res.text(); })
    .then(function(html) {
      var links = [];
      var re = /href="(https?:\/\/[^"]*\/episode\/[^"]*episode-(\d+)[^"]*)"/gi;
      var m;
      while ((m = re.exec(html)) !== null) links.push({ url: m[1], num: parseInt(m[2]) });
      var target = links.find(function(e) { return e.num === episode; });
      if (!target) {
        var slug = animePageUrl.split("/anime/")[1].replace(/\//g, "");
        target = { url: BASE_URL + "/episode/" + slug + "-episode-" + episode + "/" };
      }
      return extractStreams(target.url);
    });
}

function getMovieStreams(animePageUrl) {
  return fetch(animePageUrl, { headers: { "User-Agent": "Mozilla/5.0" } })
    .then(function(res) { return res.text(); })
    .then(function(html) {
      var m = html.match(/href="(https?:\/\/[^"]*\/episode\/[^"]+)"/);
      return extractStreams(m ? m[1] : animePageUrl);
    });
}

function extractStreams(episodeUrl) {
  return fetch(episodeUrl, { headers: { "User-Agent": "Mozilla/5.0", "Referer": BASE_URL } })
    .then(function(res) { return res.text(); })
    .then(function(html) {
      var streams = [];
      var re1 = /(https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*)/g;
      var m;
      while ((m = re1.exec(html)) !== null) {
        streams.push({ name: "WitAnime", title: "HLS", url: m[1].replace(/\\/g, ""), quality: getQuality(m[1]), headers: { "Referer": episodeUrl } });
      }
      var re2 = /(https?:\/\/[^\s"'\\]+\.mp4[^\s"'\\]*)/g;
      while ((m = re2.exec(html)) !== null) {
        streams.push({ name: "WitAnime", title: "MP4", url: m[1].replace(/\\/g, ""), quality: getQuality(m[1]), headers: { "Referer": episodeUrl } });
      }
      return streams;
    });
}

function getQuality(url) {
  if (url.indexOf("1080") > -1) return "1080p";
  if (url.indexOf("720") > -1) return "720p";
  if (url.indexOf("480") > -1) return "480p";
  return "Auto";
}

module.exports = { getStreams };