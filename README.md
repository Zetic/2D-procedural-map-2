# Deterministic Backrooms Map Lab

A zero-dependency GitHub Pages project for generating large, irregular, deterministic 2D Backrooms-style floorplans.

The generator is intentionally split into architectural layers instead of treating chunks or tiles as the design unit:

```text
World seed
  -> deterministic macro topology graph
  -> deterministic region identities
  -> architecture DNA per region
  -> local room/corridor growth grammar
  -> local loop injection
  -> cross-region corridor routing
  -> render/export
```

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
- Connected macro-region topology with optional loop edges
- Multiple architecture DNA profiles in one map
- Local spatial room growth with collision rejection
- Local and cross-region corridors
- Pan and zoom canvas rendering
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
src/generator.js           topology + floorplan generation
src/renderer.js            canvas renderer + SVG export
src/app.js                 UI state, URL state, exports
tests/generator.test.js    deterministic generator tests
```

## Design constraint

Rooms are generated as world architecture first. Rendering is a separate concern. This keeps the model compatible with a future chunk/streaming system where canonical world geometry can be clipped into runtime chunks without allowing chunk load order to change the architecture.
