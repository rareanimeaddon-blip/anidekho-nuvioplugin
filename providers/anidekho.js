/*
 * AniDekho Streams — Nuvio native provider
 *
 * Adapted from the user-supplied Stremio add-on. Nuvio calls getStreams with
 * a TMDB ID, media type, and optional season/episode, then consumes the
 * normalized stream records returned here.
 *
 * Gate behavior is intentionally not automated. A watch response marked
 * "gated" yields no streams.
 */

var BASE = "https://animedekho.tv";
var API = BASE + "/wp-json/dgt/v1";
var USER_AGENT =
  "Mozilla/5.0 (compatible; AniDekhoNuvioPlugin/1.0; +https://nuvio.tv)";
var PLAYER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
var MAX_DEPTH = 4;
var MAX_LINKS = 12;
var MAX_CANDIDATES = 12;
var MAX_PAGE_CHARS = 1000000;

function getStreams(tmdbId, mediaType, season, episode) {
  return findStreams(tmdbId, mediaType, season, episode).catch(function (error) {
    console.error("[AniDekho] " + (error && error.message ? error.message : error));
    return [];
  });
}

async function findStreams(tmdbId, mediaType, season, episode) {
  var type = normalizeType(mediaType);
  var id = String(tmdbId == null ? "" : tmdbId).trim();
  if (!type || !id) return [];

  var metadata = await resolveTitleMetadata(id, type);
  if (!metadata || !metadata.name) return [];

  var item = await findAniDekhoItem(type, metadata);
  if (!item) return [];

  var episodeId = 0;
  var pageUrl = item.url;
  if (type === "series") {
    var seasonNumber = positiveNumber(season);
    var episodeNumber = positiveNumber(episode);
    if (!seasonNumber || !episodeNumber) return [];
    var episodes = await getEpisodes(item.id);
    var selected = episodes.filter(function (candidate) {
      return Number(candidate.season) === seasonNumber &&
        Number(candidate.episode) === episodeNumber;
    })[0];
    if (!selected) return [];
    episodeId = selected.id;
    pageUrl = selected.url;
  }

  var watch = await postWatch(item.id, episodeId, pageUrl);
  if (!watch || watch.gated || watch.unreleased) return [];

  var candidates = collectWatchCandidates(watch);
  var resolved = [];
  for (var i = 0; i < candidates.length; i++) {
    var candidate = candidates[i];
    var media = await resolveMedia(
      candidate.url,
      pageUrl,
      0,
      Object.create(null)
    );
    for (var j = 0; j < media.length; j++) {
      var stream = media[j];
      if (!safePublicUrl(stream.url, pageUrl)) continue;
      resolved.push({
        name: "AniDekho · " + cleanSourceName(candidate.server),
        title: [candidate.kind, candidate.quality, candidate.language]
          .filter(Boolean)
          .join(" · ") || "Direct stream",
        url: stream.url,
        quality: candidate.quality || undefined,
        language: candidate.language || undefined,
        provider: "AniDekho",
        headers: stream.headers || mediaHeaders(pageUrl)
      });
    }
  }

  return dedupeStreams(resolved);
}

function normalizeType(value) {
  var type = String(value || "").toLowerCase();
  if (type === "tv" || type === "series" || type === "show") return "series";
  if (type === "movie" || type === "film") return "movie";
  return null;
}

function positiveNumber(value) {
  var number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

async function resolveTitleMetadata(rawId, type) {
  var id = rawId.replace(/^tmdb:(?:(?:movie|tv|series):)?/i, "");
  var imdbId = /^tt\d+$/i.test(id) ? id : "";
  var fallbackTitle = "";
  var metadata = null;

  if (/^\d+$/.test(id)) {
    var crossReference = await lookupTmdbCrossReference(type, id);
    if (crossReference) {
      imdbId = crossReference.imdbId || "";
      fallbackTitle = crossReference.label || "";
    }
  }

  if (imdbId) {
    var cinemeta = await getCinemetaMetadata(type, imdbId);
    if (cinemeta && cinemeta.name) {
      metadata = cinemeta;
    }
    if (!fallbackTitle && !metadata) {
      fallbackTitle = await lookupImdbTitle(imdbId);
    }
  }

  if (!metadata && !fallbackTitle) return null;
  if (!metadata) metadata = { name: fallbackTitle, type: type };
  if (!metadata.name) metadata.name = fallbackTitle;
  return metadata;
}

async function lookupTmdbCrossReference(type, tmdbId) {
  if (!/^\d+$/.test(tmdbId)) return null;
  var property = type === "series" ? "P4983" : "P4947";
  var query = "SELECT ?imdb ?label WHERE { ?item wdt:" + property +
    ' "' + tmdbId + '" . OPTIONAL { ?item wdt:P345 ?imdb } ' +
    'SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } LIMIT 1';
  var url = "https://query.wikidata.org/sparql?query=" +
    encodeURIComponent(query) + "&format=json";
  var data = await fetchJson(url, {
    Accept: "application/sparql-results+json",
    "User-Agent": USER_AGENT
  });
  var binding = data && data.results && data.results.bindings &&
    data.results.bindings[0];
  if (!binding) return null;
  var candidateImdb = binding.imdb && binding.imdb.value;
  var label = binding.label && binding.label.value;
  return {
    imdbId: typeof candidateImdb === "string" && /^tt\d+$/.test(candidateImdb)
      ? candidateImdb
      : "",
    label: typeof label === "string" ? label.trim() : ""
  };
}

async function lookupImdbTitle(imdbId) {
  if (!/^tt\d+$/.test(imdbId)) return "";
  var query = 'SELECT ?itemLabel WHERE { ?item wdt:P345 "' + imdbId +
    '" . SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } LIMIT 1';
  var url = "https://query.wikidata.org/sparql?query=" +
    encodeURIComponent(query) + "&format=json";
  var data = await fetchJson(url, {
    Accept: "application/sparql-results+json",
    "User-Agent": USER_AGENT
  });
  var bindings = data && data.results && data.results.bindings;
  var title = bindings && bindings[0] && bindings[0].itemLabel &&
    bindings[0].itemLabel.value;
  return typeof title === "string" ? title.trim() : "";
}

async function getCinemetaMetadata(type, imdbId) {
  if (!/^tt\d+$/.test(imdbId)) return null;
  var url = "https://v3-cinemeta.strem.io/meta/" +
    (type === "series" ? "series" : "movie") + "/" +
    encodeURIComponent(imdbId) + ".json";
  var data = await fetchJson(url, { Accept: "application/json" });
  return data && data.meta && typeof data.meta === "object" ? data.meta : null;
}

async function findAniDekhoItem(type, metadata) {
  var names = [
    metadata.name,
    metadata.originalName,
    metadata.original_name,
    metadata.title,
    metadata.original_title,
    metadata.originalName,
    metadata.aka
  ];
  if (Array.isArray(metadata.aliases)) names = names.concat(metadata.aliases);
  if (Array.isArray(metadata.aka)) names = names.concat(metadata.aka);
  names = names.filter(function (name) {
    return typeof name === "string" && name.trim();
  });

  var queries = [];
  names.forEach(function (name) {
    titleSearchVariants(name).forEach(function (query) {
      if (queries.indexOf(query) < 0 && queries.length < 6) queries.push(query);
    });
  });
  if (!queries.length) return null;

  var resultSets = await Promise.all(queries.map(function (query) {
    return searchTitles(query).catch(function () { return []; });
  }));
  var candidates = [];
  resultSets.forEach(function (set) {
    set.forEach(function (item) {
      if (item.type === type &&
          !candidates.some(function (existing) {
            return existing.id === item.id && existing.type === item.type;
          })) {
        candidates.push(item);
      }
    });
  });

  var year = parseYear(metadata.year || metadata.releaseInfo ||
    metadata.release_date || metadata.first_air_date);
  var ranked = candidates.map(function (item) {
    var score = titleMatchScore(names, item.title);
    if (year && item.year) {
      var difference = Math.abs(year - item.year);
      score += difference === 0 ? 25 : difference === 1 ? 12 : -25;
      if (difference > 5) score -= 35;
    }
    return { item: item, score: score };
  }).sort(function (a, b) { return b.score - a.score; });

  return ranked.length && ranked[0].score >= 75 ? ranked[0].item : null;
}

function titleSearchVariants(value) {
  var cleaned = String(value || "")
    .replace(/\(\s*(?:19|20)\d{2}[^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return [];
  var withoutPrefix = cleaned.replace(/^(?:crayon|kureyon)\s+/i, "").trim();
  var compact = withoutPrefix.replace(/[^A-Za-z0-9\u0080-\uFFFF]+/g, "");
  return [cleaned, withoutPrefix, compact].filter(function (value, index, all) {
    return value.length >= 3 && all.indexOf(value) === index;
  });
}

function normalizeTitle(value) {
  var normalized = String(value || "").toLowerCase();
  try {
    normalized = normalized.normalize("NFKD");
  } catch (_) {}
  return normalized
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\u0080-\uFFFF]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function titleMatchScore(names, candidate) {
  var target = normalizeTitle(candidate);
  var compactTarget = target.replace(/\s+/g, "");
  var targetTokens = target.split(" ").filter(Boolean);
  var best = 0;
  names.forEach(function (name) {
    titleSearchVariants(name).forEach(function (variant) {
      var normalized = normalizeTitle(variant);
      var compact = normalized.replace(/\s+/g, "");
      if (target === normalized) best = Math.max(best, 100);
      else if (target && compact === compactTarget) best = Math.max(best, 96);
      else if (normalized.length >= 5 &&
          (target.indexOf(normalized) >= 0 || normalized.indexOf(target) >= 0)) {
        best = Math.max(best, 76);
      }
      var tokens = normalized.split(" ").filter(Boolean);
      var common = tokens.filter(function (token) {
        return targetTokens.indexOf(token) >= 0;
      }).length;
      var coverage = tokens.length ? common / tokens.length : 0;
      if (coverage >= 0.8) {
        best = Math.max(best, 72 + coverage * 18 -
          Math.max(0, targetTokens.length - tokens.length) * 3);
      }
    });
  });
  return best;
}

function parseYear(value) {
  var match = String(value || "").match(/\b(?:19|20)\d{2}\b/);
  return match ? Number(match[0]) : 0;
}

async function searchTitles(query) {
  var data = await fetchJson(API + "/suggest?q=" + encodeURIComponent(query), {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
    Referer: BASE + "/"
  });
  var items = data && Array.isArray(data.items) ? data.items : [];
  return items.filter(function (item) {
    return Number.isInteger(Number(item.id)) &&
      typeof item.title === "string" &&
      (item.type === "series" || item.type === "movie") &&
      typeof item.url === "string";
  }).map(function (item) {
    return {
      id: Number(item.id),
      title: item.title,
      year: parseYear(item.year),
      type: item.type,
      url: safePublicUrl(item.url, BASE + "/"),
      poster: item.poster || ""
    };
  }).filter(function (item) { return !!item.url; });
}

async function getEpisodes(seriesId) {
  var data = await fetchJson(API + "/episodes?series=" +
    encodeURIComponent(String(seriesId)), {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      Referer: BASE + "/"
    });
  var episodes = data && Array.isArray(data.episodes) ? data.episodes : [];
  return episodes.filter(function (episode) {
    return Number.isInteger(Number(episode.id)) &&
      typeof episode.url === "string";
  }).map(function (episode) {
    return {
      id: Number(episode.id),
      season: Number(episode.season),
      episode: Number(episode.episode),
      url: safePublicUrl(episode.url, BASE + "/")
    };
  }).filter(function (episode) { return !!episode.url; });
}

async function postWatch(postId, episodeId, pageUrl) {
  var response = await fetch(API + "/watch", {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      "Content-Type": "application/json",
      Referer: pageUrl,
      Origin: BASE
    },
    body: JSON.stringify({ post_id: postId, episode_id: episodeId })
  });
  if (!response || !response.ok) return null;
  try {
    return await response.json();
  } catch (_) {
    return null;
  }
}

function collectWatchCandidates(watch) {
  var entries = [];
  if (Array.isArray(watch.sources)) entries = entries.concat(watch.sources);
  if (Array.isArray(watch.streams)) entries = entries.concat(watch.streams);
  var candidates = [];
  entries.forEach(function (entry) {
    if (!entry || (entry.show_embed === false && entry.show_download === false)) return;
    var server = String(entry.server || "AniDekho").trim();
    var quality = String(entry.quality || "").trim();
    var language = String(entry.language || "").trim();
    if (entry.embed && entry.show_embed !== false) {
      candidates.push({
        url: entry.embed, server: server, kind: "embed",
        quality: quality, language: language
      });
    }
    if (entry.download && entry.show_download !== false) {
      candidates.push({
        url: entry.download, server: server, kind: "download",
        quality: quality, language: language
      });
    }
    var direct = entry.url || entry.file || entry.src;
    if (direct && isDirectMediaUrl(direct) && !entry.embed && !entry.download) {
      candidates.push({
        url: direct, server: server, kind: "direct",
        quality: quality, language: language
      });
    }
  });
  [watch.url, watch.file].forEach(function (url) {
    if (url) candidates.push({ url: url, server: "AniDekho", kind: "direct" });
  });

  var seen = Object.create(null);
  return candidates.map(function (candidate) {
    candidate.url = safePublicUrl(candidate.url, BASE + "/");
    return candidate;
  }).filter(function (candidate) {
    if (!candidate.url) return false;
    var key = candidate.kind + ":" + candidate.url;
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  }).slice(0, MAX_CANDIDATES);
}

async function resolveMedia(rawUrl, referer, depth, visited) {
  if (depth > MAX_DEPTH) return [];
  var url = safePublicUrl(rawUrl, referer);
  if (!url || visited[url]) return [];
  visited[url] = true;

  if (isDirectMediaUrl(url)) {
    return [{ url: url, headers: mediaHeaders(referer) }];
  }

  var parsed = safeParseUrl(url);
  if (!parsed) return [];
  var host = String(parsed.hostname || "").toLowerCase();

  if (/(\.|^)ravok\.buzz$/.test(host)) {
    var ravok = await resolveRavok(url, referer, depth, visited);
    if (ravok.length) return ravok;
  }
  if (/(^|\.)abyssplayer\.com$/.test(host) || host === "short.icu") {
    var abyss = await resolveAbyss(url, referer, depth, visited);
    if (abyss.length) return abyss;
  }
  if (host === "animedekho.tv" &&
      /\/aaa\/myth\/play(?:2)?\.php$/i.test(parsed.pathname || "")) {
    var neo = await resolveNeoCdn(url, referer);
    if (neo.length) return neo;
  }
  if (host === "rubystm.com" || /(\.|^)rubystm\.com$/.test(host)) {
    return resolveStreamRuby(url, referer, depth, visited);
  }
  if (host === "animeworld.site" && /^\/mirror(?:\/|$)/i.test(parsed.pathname || "")) {
    return resolveAnimeworldMirror(url, referer, depth, visited);
  }
  if (/hubcloud/i.test(host) || /hubcloud\.php/i.test(url)) {
    return resolveHubCloud(url, referer, depth, visited);
  }
  if (host === "vidcloud.upns.ink") {
    return resolveVidStack(url, referer, depth, visited);
  }

  var page = await fetchPage(url, {
    Accept: "text/html,application/xhtml+xml,application/json,application/vnd.apple.mpegurl,*/*",
    Referer: referer || BASE + "/"
  });
  if (!page) return [];
  var contentType = String(page.contentType || "").toLowerCase();
  if (isMediaContentType(contentType) || isHlsContentType(contentType)) {
    return [{ url: page.url, headers: mediaHeaders(referer) }];
  }

  var body = page.text || "";
  if (/^\s*#EXTM3U(?:\s|$)/m.test(body)) {
    return [{ url: page.url, headers: mediaHeaders(referer) }];
  }
  var urls = extractDirectMediaUrls(body, page.url)
    .concat(extractEmbedUrls(body, page.url));
  return resolveCandidateList(urls, page.url, depth, visited);
}

async function resolveStreamRuby(url, referer, depth, visited) {
  var playerUrl = url.replace(/\/e(?=\/|$)/g, "");
  var page = await fetchPage(playerUrl, {
    Accept: "text/html,application/xhtml+xml,*/*",
    "X-Requested-With": "XMLHttpRequest",
    Referer: playerUrl
  });
  if (!page) return [];
  var scripts = page.text.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];
  var script = scripts.filter(function (value) { return /vplayer/i.test(value); })[0] || page.text;
  var match = script.match(/\bfile\s*:\s*["']([^"']+)["']/i);
  if (!match) return [];
  var source = decodeHtml(match[1])
    .replace(/\\\//g, "/")
    .replace(/\\u0026/gi, "&")
    .replace(/\\x26/gi, "&");
  var results = await resolveCandidateList([source], "https://rubystm.com/", depth, visited);
  return results.map(function (item) {
    item.headers = Object.assign({}, item.headers || {}, {
      "User-Agent": PLAYER_USER_AGENT,
      Accept: "*/*",
      Origin: "https://rubystm.com",
      Referer: "https://rubystm.com/"
    });
    return item;
  });
}

async function resolveAnimeworldMirror(url, referer, depth, visited) {
  var page = await fetchPage(url, {
    Accept: "text/html,application/xhtml+xml",
    Referer: referer || BASE + "/"
  });
  if (!page) return [];
  var select = page.text.match(/<select\b[^>]*\bid=["']serverSelect["'][^>]*>([\s\S]*?)<\/select>/i);
  if (!select) return [];
  var options = [];
  var optionPattern = /<option\b[^>]*>([\s\S]*?)<\/option>/gi;
  var match;
  while ((match = optionPattern.exec(select[1])) && options.length < MAX_LINKS) {
    var opening = match[0].match(/^<option\b[^>]*>/i);
    var tag = opening ? opening[0] : "";
    var value = readHtmlAttribute(tag, "value");
    var label = readHtmlAttribute(tag, "data-server") || htmlText(match[1]);
    if (!value || !label || /rpm|p2p/i.test(label)) continue;
    var candidate = safePublicUrl(value, page.url);
    if (candidate) options.push({ url: candidate, server: label });
  }
  var streams = [];
  for (var i = 0; i < options.length; i++) {
    var result = /upn/i.test(options[i].server)
      ? await resolveVidStack(options[i].url, page.url, depth + 1, visited)
      : await resolveMedia(options[i].url, page.url, depth + 1, visited);
    streams = streams.concat(result);
  }
  return dedupeMedia(streams);
}

async function resolveHubCloud(url, referer, depth, visited) {
  var page = await fetchPage(url, {
    Accept: "text/html,application/xhtml+xml,application/json,*/*",
    Referer: referer || BASE + "/"
  });
  if (!page) return [];
  if (isMediaContentType(page.contentType) || isHlsContentType(page.contentType)) {
    return [{ url: page.url, headers: mediaHeaders(referer) }];
  }
  var html = page.text || "";
  var downloadTag = html.match(/<[^>]+\bid=["']download["'][^>]*>/i);
  var rawDownload = downloadTag && (
    readHtmlAttribute(downloadTag[0], "href") ||
    readHtmlAttribute(downloadTag[0], "data-href") ||
    readHtmlAttribute(downloadTag[0], "data-url")
  );
  if (rawDownload) {
    var downloadUrl = safePublicUrl(rawDownload, page.url);
    if (downloadUrl && !isDirectMediaUrl(downloadUrl)) {
      var next = await fetchPage(downloadUrl, {
        Accept: "text/html,application/xhtml+xml,application/json,*/*",
        Referer: page.url
      });
      if (next) {
        if (isMediaContentType(next.contentType) || isHlsContentType(next.contentType)) {
          return [{ url: next.url, headers: mediaHeaders(page.url) }];
        }
        page = next;
        html = next.text || "";
      }
    }
  }

  var candidates = [];
  var anchorPattern = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
  var anchor;
  while ((anchor = anchorPattern.exec(html)) && candidates.length < MAX_LINKS) {
    var openingTag = anchor[0].match(/^<a\b[^>]*>/i);
    var tag = openingTag ? openingTag[0] : "";
    var classes = readHtmlAttribute(tag, "class") || "";
    if (!/\bbtn\b/i.test(classes)) continue;
    var href = readHtmlAttribute(tag, "href");
    if (!href) continue;
    var label = htmlText(anchor[0]).toLowerCase();
    var target = safePublicUrl(href, page.url);
    if (!target) continue;
    if (/pixeldrain|pixel/i.test(label) || /pixeldrain/i.test(target)) {
      var pieces = target.split("?")[0].split("/");
      var fileId = pieces[pieces.length - 1];
      if (fileId) target = target.replace(/\/[^/]+(?:\?.*)?$/, "/api/file/" +
        encodeURIComponent(fileId) + "?download");
    } else if (/buzzserver/i.test(label) && !/\/download\/?$/i.test(target)) {
      target = target.replace(/\/+$/, "") + "/download";
    }
    candidates.push(target);
  }
  if (!candidates.length) {
    candidates = extractDirectMediaUrls(html, page.url)
      .concat(extractEmbedUrls(html, page.url));
  }
  if (!candidates.length && rawDownload) candidates.push(rawDownload);
  return resolveCandidateList(candidates.slice(0, MAX_LINKS), page.url, depth, visited);
}

async function resolveVidStack(url, referer, depth, visited) {
  var fragment = String(url).split("#").pop() || "";
  var slash = fragment.indexOf("/");
  var hash = slash >= 0 ? fragment.slice(slash + 1) : fragment;
  if (!hash) return [];
  var api = "https://vidcloud.upns.ink/api/v1/video?id=" + encodeURIComponent(hash);
  var response = await fetchText(api, {
    Accept: "text/plain,*/*",
    Referer: referer || url
  });
  if (!response) return [];
  var decrypted = decryptVidStackPayload(response.text.trim());
  if (!decrypted) return [];
  var payload = parseJson(decrypted) || decrypted;
  return resolveCandidateList(
    extractNamedLinks(payload, ["source", "url", "file", "src"]),
    referer || url,
    depth,
    visited
  );
}

function decryptVidStackPayload(input) {
  if (!/^(?:[a-f\d]{2})+$/i.test(input)) return "";
  var crypto = null;
  try {
    crypto = typeof CryptoJS !== "undefined" ? CryptoJS : null;
  } catch (_) {}
  if (!crypto && typeof require === "function") {
    try { crypto = require("crypto-js"); } catch (_) {}
  }
  if (!crypto || !crypto.AES || !crypto.enc) return "";
  var key = crypto.enc.Utf8.parse("kiemtienmua911ca");
  var cipher = crypto.enc.Hex.parse(input);
  var ivs = ["1234567890oiuytr", "0123456789abcdef"];
  for (var i = 0; i < ivs.length; i++) {
    try {
      var plain = crypto.AES.decrypt(
        { ciphertext: cipher },
        key,
        {
          iv: crypto.enc.Utf8.parse(ivs[i]),
          mode: crypto.mode.CBC,
          padding: crypto.pad.Pkcs7
        }
      ).toString(crypto.enc.Utf8);
      if (extractNamedLinks(parseJson(plain), ["source"]).length) return plain;
    } catch (_) {}
  }
  return "";
}

async function resolveAbyss(url, referer, depth, visited) {
  var parsed = safeParseUrl(url);
  var data = parsed && parsed.searchParams && parsed.searchParams.get("data");
  if (data) {
    var decoded = decodeBase64Json(data);
    if (decoded !== null) {
      var links = extractNamedLinks(decoded, ["link", "url", "file", "src"]);
      var direct = await resolveCandidateList(links, url, depth, visited);
      if (direct.length) return direct;
    }
  }

  var page = await fetchPage(url, {
    Accept: "text/html,application/xhtml+xml",
    Origin: "https://playhydrax.com",
    Referer: "https://playhydrax.com/"
  });
  if (!page) return [];
  var encrypted = page.text.match(/const\s+datas\s*=\s*["']([^"']+)["']/i);
  if (!encrypted) {
    return resolveCandidateList(
      extractDirectMediaUrls(page.text, page.url),
      page.url,
      depth,
      visited
    );
  }
  var response = await fetchText("https://enc-dec.app/api/dec-abyss", {
    method: "POST",
    Accept: "application/json",
    "Content-Type": "application/json",
    Origin: "https://playhydrax.com",
    Referer: "https://playhydrax.com/"
  }, JSON.stringify({ text: encrypted[1] }));
  if (!response) return [];
  var payload = parseJson(response.text) || response.text;
  return resolveCandidateList(
    extractNamedLinks(payload, ["link", "url", "file", "src", "source"]),
    url,
    depth,
    visited
  );
}

async function resolveNeoCdn(url, referer) {
  var page = await fetchText(url, {
    Accept: "text/html,application/xhtml+xml",
    Referer: referer || BASE + "/"
  });
  if (!page) return [];
  var fetchMatch = page.text.match(/fetch\s*\(\s*["']([^"']*fetch\.php[^"']*)["']/i);
  if (!fetchMatch) return [];
  var workerMatch = page.text.match(/const\s+worker\s*=\s*["']([^"']*)["']/i);
  var fetchUrl = safePublicUrl(fetchMatch[1], originOf(page.url) + "/");
  if (!fetchUrl) return [];
  var data = await fetchJson(fetchUrl, {
    Accept: "application/json",
    Referer: url
  });
  if (!data || !Array.isArray(data.sources)) return [];
  var output = [];
  data.sources.forEach(function (source) {
    if (!source || typeof source.url !== "string") return;
    var sourceUrl = safePublicUrl(source.url, page.url);
    if (!sourceUrl) return;
    if (workerMatch && workerMatch[1]) {
      var worker = safePublicUrl(workerMatch[1], page.url);
      if (worker) {
        output.push({
          url: worker + encodeFormComponent(sourceUrl),
          headers: mediaHeaders("")
        });
      }
    } else {
      output.push({ url: sourceUrl, headers: mediaHeaders("") });
    }
  });
  return dedupeMedia(output);
}

async function resolveRavok(url, referer, depth, visited) {
  var parsed = safeParseUrl(url);
  if (!parsed) return [];
  var pathParts = String(parsed.pathname || "").split("/").filter(Boolean);
  var hash = pathParts.length ? pathParts[pathParts.length - 1] : "";
  if (!hash) return [];
  var endpoint = originOf(url) + "/player/index.php?data=" +
    encodeURIComponent(hash) + "&do=getVideo";
  var requestReferer = referer || originOf(url) + "/";
  var response = await fetchText(endpoint, {
    method: "POST",
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
    "X-Requested-With": "XMLHttpRequest",
    Origin: originOf(url),
    Referer: requestReferer
  }, "hash=" + encodeURIComponent(hash) + "&r=" +
    encodeURIComponent(requestReferer));
  if (!response) return [];
  var payload = parseJson(response.text);
  if (!payload) return [];
  return resolveCandidateList(
    extractNamedLinks(payload, ["videoSource", "securedLink", "url", "file", "src"]),
    originOf(url) + "/",
    depth,
    visited
  );
}

async function resolveCandidateList(rawCandidates, referer, depth, visited) {
  var candidates = [];
  var seen = Object.create(null);
  (rawCandidates || []).forEach(function (raw) {
    var candidate = safePublicUrl(raw, referer);
    if (candidate && !seen[candidate] && candidates.length < MAX_LINKS) {
      seen[candidate] = true;
      candidates.push(candidate);
    }
  });
  candidates.sort(function (a, b) {
    return (isDirectMediaUrl(a) ? 0 : 1) - (isDirectMediaUrl(b) ? 0 : 1);
  });
  var output = [];
  for (var i = 0; i < candidates.length; i++) {
    var result = await resolveMedia(
      candidates[i],
      referer,
      depth + 1,
      Object.assign(Object.create(null), visited)
    );
    output = output.concat(result);
  }
  return dedupeMedia(output);
}

async function fetchPage(url, headers, method, body) {
  var safe = safePublicUrl(url, BASE + "/");
  if (!safe) return null;
  try {
    var requestHeaders = Object.assign({
      "User-Agent": PLAYER_USER_AGENT,
      Accept: "text/html,application/xhtml+xml,*/*"
    }, headers || {});
    var response = await fetch(safe, {
      method: method || "GET",
      headers: requestHeaders,
      body: body
    });
    if (!response || !response.ok) return null;
    var finalUrl = safePublicUrl(response.url || safe, safe);
    if (!finalUrl) return null;
    var contentType = response.headers && response.headers.get
      ? (response.headers.get("content-type") || "")
      : "";
    var text = await response.text();
    return {
      url: finalUrl,
      contentType: contentType,
      text: String(text || "").slice(0, MAX_PAGE_CHARS)
    };
  } catch (_) {
    return null;
  }
}

function fetchText(url, headers, method, body) {
  return fetchPage(url, headers, method, body);
}

async function fetchJson(url, headers) {
  var response = await fetchText(url, Object.assign({
    Accept: "application/json"
  }, headers || {}));
  if (!response) return null;
  return parseJson(response.text);
}

function extractDirectMediaUrls(text, baseUrl) {
  var normalized = decodeHtml(String(text || ""))
    .replace(/\\\//g, "/")
    .replace(/\\u0026/gi, "&")
    .replace(/\\x26/gi, "&");
  var output = [];
  var seen = Object.create(null);
  var pattern = /https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4|m4v|webm)(?:\?[^\s"'<>\\]*)?/gi;
  var match;
  while ((match = pattern.exec(normalized))) {
    addUrl(output, seen, trimUrlPunctuation(match[0]), baseUrl);
  }
  var fields = /(?:file|src|url|hls|playlist|video(?:_source|_url)?)\s*[:=]\s*["']([^"']+)["']/gi;
  while ((match = fields.exec(normalized))) {
    var value = match[1].replace(/\\\//g, "/");
    if (isDirectMediaUrl(value)) addUrl(output, seen, value, baseUrl);
  }
  return output;
}

function extractEmbedUrls(text, baseUrl) {
  var output = [];
  var seen = Object.create(null);
  var pattern = /<(?:iframe|source|video)\b[^>]*>/gi;
  var match;
  while ((match = pattern.exec(String(text || "")))) {
    var tag = match[0];
    var value = tag.match(/\b(?:src|data-src|data-url)\s*=\s*(["'])(.*?)\1/i);
    if (value) addUrl(output, seen, decodeHtml(value[2]), baseUrl);
  }
  return output;
}

function addUrl(output, seen, value, baseUrl) {
  var safe = safePublicUrl(value, baseUrl);
  if (safe && !seen[safe]) {
    seen[safe] = true;
    output.push(safe);
  }
}

function extractNamedLinks(value, allowedKeys) {
  var allowed = Object.create(null);
  allowedKeys.forEach(function (key) { allowed[key.toLowerCase()] = true; });
  var links = [];
  var seen = Object.create(null);
  function visit(node, key) {
    if (typeof node === "string") {
      var value = node.replace(/\\\//g, "/").trim();
      if (allowed[String(key || "").toLowerCase()] && /^https?:\/\//i.test(value)) {
        if (!seen[value]) {
          seen[value] = true;
          links.push(value);
        }
      } else if (/^[\[{]/.test(value)) {
        var nested = parseJson(value);
        if (nested) visit(nested, "");
      }
    } else if (Array.isArray(node)) {
      node.forEach(function (item) { visit(item, key); });
    } else if (node && typeof node === "object") {
      Object.keys(node).forEach(function (childKey) {
        visit(node[childKey], childKey);
      });
    }
  }
  visit(value, "");
  return links;
}

function decodeBase64Json(value) {
  try {
    var source = decodeURIComponent(value).replace(/-/g, "+").replace(/_/g, "/");
    while (source.length % 4) source += "=";
    var binary = atob(source);
    var encoded = "";
    for (var i = 0; i < binary.length; i++) {
      encoded += "%" + ("0" + binary.charCodeAt(i).toString(16)).slice(-2);
    }
    return parseJson(decodeURIComponent(encoded));
  } catch (_) {
    return null;
  }
}

function parseJson(value) {
  try { return JSON.parse(value); } catch (_) { return null; }
}

function safePublicUrl(value, baseUrl) {
  if (!value || typeof value !== "string") return "";
  try {
    var url = new URL(value, baseUrl || BASE + "/");
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    if (url.username || url.password) return "";
    var host = String(url.hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
    if (!host || host === "localhost" || host.slice(-10) === ".localhost" ||
        host.slice(-6) === ".local" || host.slice(-9) === ".internal" ||
        host === "::1" || host.slice(0, 4) === "fe80" ||
        host.slice(0, 2) === "fc" || host.slice(0, 2) === "fd") return "";
    var parts = host.split(".");
    if (parts.length === 4 && parts.every(function (part) {
      return /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255;
    })) {
      var a = Number(parts[0]), b = Number(parts[1]);
      if (a === 0 || a === 10 || a === 127 ||
          (a === 169 && b === 254) ||
          (a === 172 && b >= 16 && b <= 31) ||
          (a === 192 && b === 168)) return "";
    }
    return url.href;
  } catch (_) {
    return "";
  }
}

function safeParseUrl(value) {
  try { return new URL(value); } catch (_) { return null; }
}

function originOf(value) {
  var parsed = safeParseUrl(value);
  return parsed ? parsed.origin : "";
}

function isDirectMediaUrl(value) {
  return /\.(?:m3u8|mp4|m4v|webm)(?:$|[?#])/i.test(String(value || ""));
}

function isMediaContentType(value) {
  return /^video\//i.test(value) || /^application\/octet-stream\b/i.test(value);
}

function isHlsContentType(value) {
  return /(?:mpegurl|vnd\.apple\.mpegurl)/i.test(value);
}

function mediaHeaders(referer) {
  var headers = { "User-Agent": PLAYER_USER_AGENT };
  if (referer) headers.Referer = referer;
  return headers;
}

function encodeFormComponent(value) {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

function readHtmlAttribute(tag, name) {
  var escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  var match = new RegExp(
    "(?:^|\\s)" + escaped + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))",
    "i"
  ).exec(tag);
  var value = match && (match[1] || match[2] || match[3]);
  return value === undefined ? "" : decodeHtml(value);
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&#0*38;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#0*39;|&#x0*27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(?:x([0-9a-f]+)|(\d+));?/gi, function (_, hex, decimal) {
      var code = parseInt(hex || decimal, hex ? 16 : 10);
      return isFinite(code) ? String.fromCharCode(code) : "";
    });
}

function htmlText(value) {
  return decodeHtml(String(value || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function trimUrlPunctuation(value) {
  return String(value || "").replace(/[),;]+$/, "");
}

function cleanSourceName(value) {
  return /hydrax|abyssplayer/i.test(value) ? "AbyssPlayer" : value;
}

function dedupeMedia(items) {
  var seen = Object.create(null);
  return (items || []).filter(function (item) {
    if (!item || !item.url || seen[item.url]) return false;
    seen[item.url] = true;
    return true;
  });
}

function dedupeStreams(items) {
  var seen = Object.create(null);
  return (items || []).filter(function (item) {
    if (!item || !item.url || seen[item.url]) return false;
    seen[item.url] = true;
    return true;
  });
}

module.exports = { getStreams: getStreams };
