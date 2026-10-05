# Deterministic Backrooms Map Lab

A zero-dependency GitHub Pages project for generating large, irregular, deterministic 2D Backrooms-style floorplans.

The live map is an infinite deterministic spatial field. The viewport loads only a bounded working set:

```text
World seed + spatial site coordinate
  -> jittered architectural site
  -> regional architecture DNA
  -> dense / medium / transit mass profile
  -> boundaryless local room growth
  -> edge-owned transition rooms
  -> short deterministic connectors
  -> viewport streaming + render/export
```

There is no finite world-region count. Panning regenerates a bounded working set around the viewport. Invisible spatial cells are lookup addresses only: rooms are not clipped to them, architectural sites are heavily jittered, and geometry can cross those boundaries freely. Previously visited coordinates reproduce the same geometry without storing the entire world.

## Determinism

Generation uses addressable pseudo-random decisions. A value is derived from a stable address such as:

```text
hash(worldSeed, siteX, siteY, "room", roomId, "width")
```

No global random stream is consumed. The same seed and configuration therefore produce the same structural signature, independent of rendering order.

## Architecture DNA

Each macro region is assigned one of several deterministic profiles, including office lattice, service maze, institutional, open halls, utility works, archive stacks, flooded wing, and liminal rooms. Each profile changes room dimensions, corridor widths, branching behavior, hall frequency, flush attachments, and local loop frequency.

## Features

- Deterministic world seed and shareable URL parameters
- Infinite viewport-addressed generation with stable spatial coordinates
- Order-independent regeneration of previously visited areas
- Streaming cells that do not constrain or shape architecture
- Jittered architectural sites instead of a visible square lattice
- Dense, medium, and transit sites for masses, voids, and thin tendrils
- Multi-site architecture-DNA neighborhoods that read as larger wings
- Local spatial room growth with collision rejection
- Edge-owned transition rooms that break long connections into architecture
- Short connector spans instead of long empty fallback halls
- Pan-to-stream canvas rendering
- Region labels, topology debug view, and bounds debug view
- PNG, SVG, and JSON export
- Automated determinism/connectivity/geometry tests
- GitHub Pages deployment workflow
- No runtime dependencies and no build step

## Local development

Requires Node.js 20+ only for tests. The application itself is static HTML/CSS/ES modules.

```bash
npm test
npm run serve
```

Then open `http://localhost:4173`.

## GitHub Pages

The included `.github/workflows/pages.yml` workflow publishes the repository root as a Pages artifact on pushes to `main`.

If Pages has never been enabled for the repository, open **Settings -> Pages -> Build and deployment** and select **GitHub Actions**. After that, pushes to `main` deploy automatically.

## Project structure

```text
index.html                 UI shell
styles.css                 application styling
src/prng.js                addressable deterministic random functions
src/dna.js                 architecture DNA profiles
src/geometry.js            geometry helpers
src/generator.js           legacy finite reference generator + regression baseline
src/infinite.js            infinite boundaryless site generation and streaming geometry
src/renderer.js            canvas renderer + viewport streaming hooks + SVG export
src/app.js                 streaming UI state, URL state, exports
tests/generator.test.js    finite regression baseline tests
tests/infinite.test.js     infinite determinism and spatial invariance tests
```

## Design constraint

Streaming coordinates are lookup keys, not architectural boundaries. Site positions, region DNA, room growth, and inter-site transition architecture are derived from stable spatial addresses rather than load order. A room may cross any hidden streaming-cell boundary. Moving east-first or west-first therefore changes only what is loaded, never the canonical architecture at a coordinate.
