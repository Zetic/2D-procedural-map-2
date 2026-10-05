# Deterministic Backrooms Map Lab

A zero-dependency GitHub Pages project for generating large, irregular, deterministic 2D Backrooms-style floorplans.

The live map is an infinite deterministic spatial field. The viewport loads only a bounded working set:

```text
World seed + sector coordinate
  -> deterministic sector identity
  -> architecture DNA
  -> shared deterministic boundary portals
  -> short internal room/corridor growth
  -> deterministic cross-sector links
  -> viewport streaming + render/export
```

There is no finite world-region count. Panning into a new sector regenerates the surrounding working set from spatial addresses, so previously visited coordinates reproduce the same geometry without storing the entire world.

## Determinism

Generation uses addressable pseudo-random decisions. A value is derived from a stable address such as:

```text
hash(worldSeed, "room", regionId, roomId, "width")
```

No global random stream is consumed. The same seed and configuration therefore produce the same structural signature, independent of rendering order.

## Architecture DNA

Each macro region is assigned one of several deterministic profiles, including office lattice, service maze, institutional, open halls, utility works, archive stacks, flooded wing, and liminal rooms. Each profile changes room dimensions, corridor widths, branching behavior, hall frequency, flush attachments, and local loop frequency.

## Features

- Deterministic world seed and shareable URL parameters
- Infinite viewport-addressed generation with stable sector coordinates
- Order-independent regeneration of previously visited areas
- Shared boundary portals for deterministic cross-sector continuity
- Multiple architecture DNA profiles in one map
- Local spatial room growth with collision rejection
- Short cross-sector connectors instead of long fallback halls
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
src/infinite.js            infinite spatial-sector generation and streaming geometry
src/renderer.js            canvas renderer + viewport streaming hooks + SVG export
src/app.js                 streaming UI state, URL state, exports
tests/generator.test.js    finite regression baseline tests
tests/infinite.test.js     infinite determinism and spatial invariance tests
```

## Design constraint

Rooms are generated from canonical spatial sector addresses rather than from load order. Rendering remains separate. Adjacent sectors derive their shared portal from the same edge address, so moving east-first or west-first cannot alter the canonical architecture at a coordinate.
