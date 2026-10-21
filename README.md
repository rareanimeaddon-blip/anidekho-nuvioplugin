# AniDekho Streams for Nuvio

A native Nuvio stream provider adapted from the supplied AniDekho Stremio add-on.
It searches AniDekho from a Nuvio movie/TV entry and returns resolved stream
URLs. Nuvio native providers return streams only, so the original Stremio
catalogs and metadata endpoints are not part of this package.

## Install

1. Put this folder in a public static repository or host that serves the files
   without authentication.
2. In Nuvio, open **Settings → Content & Discovery → Plugins** and add the
   public URL of this repository's `manifest.json`.
3. Refresh the repository and enable **AniDekho Streams**.

The manifest points to `providers/anidekho.js` relative to the manifest URL.
Sideloaded Nuvio builds are required for native plugins; app-store builds may
not expose plugin support.

## Lookup and playback

- Movies are matched using the Nuvio TMDB ID; TV episodes additionally require
  season and episode numbers.
- It uses Wikidata TMDB cross-references and Cinemeta to identify titles without
  embedding or logging a TMDB API key.
- It calls AniDekho's public suggestion, episode, and watch endpoints, then
  resolves direct media links from the supported player pages.
- If AniDekho marks an item as gated, the provider does not automate the
  verification flow and returns no stream for that item.

The source site and its player hosts can change without notice. Playback depends
on those third-party endpoints being reachable and permitting the requests.
Only use sources you are authorized to access.

## Files

- `manifest.json` — Nuvio plugin repository manifest.
- `providers/anidekho.js` — standalone Nuvio `getStreams` provider.
