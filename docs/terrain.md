# Terrain support

Terrain is edited as a coordinated set of XML and binary components. The server never
converts a binary component to text, and a typed mutation updates every rendering and
synchronized file required for that operation in one transaction.

## Supported components

| Component | Decoding and validation | Typed write |
|---|---|---|
| `t3Terrain.xml` | Dimensions, transforms, quantization, texture sets, textures, block texture sets, cliff cells | Cliff-cell creation, update, and removal |
| `t3HeightMap` | `HMAP` version 101, 32-byte header, six bytes per vertex | Vertex height, paired with `t3SyncHeightMap` |
| `t3SyncHeightMap` | `SMAP` version 102, 64-byte header, four bytes per vertex | Synchronized height, paired with `t3HeightMap` |
| `t3CellFlags` | `LFCT` modern versions 101 and 102, one byte per cell | One exact pathing-flags byte |
| `t3TextureMasks` | `MASK` version 102, eight tiled four-bit blend layers | Eight blend weights across the addressed cell area |
| `t3SyncTextureInfo` | `RTXT` versions through 101, texture name table, four- or eight-byte cells | Synchronized texture index, paired with masks |
| `t3SyncCliffLevel` | `CLIF`, 32-byte header, two bytes per cell | A cliff cell's synchronized 2x2 area |
| `t3VertCol` | `VTCL` versions 103 and 104, header validation | Bounded raw patch |
| `t3Water` | `WATR` versions 104 through 110, header validation | Bounded raw patch |
| `t3HardTile` | `HRDT` header validation | Bounded raw patch |
| `t3FluffDoodad` | `DLFT` header validation | Bounded raw patch |

The six rendering and synchronization components needed for ordinary terrain are required
when a map has `t3Terrain.xml`. Missing files, bad magic, unsupported versions, dimension
mismatches, and incorrect lengths make terrain validation fail.

There are three coordinate grids. `width` and `height` in the summary are vertex counts.
The cell grid is one smaller on each axis. The cliff grid is half the cell-grid size, and
one cliff coordinate owns a 2x2 synchronized cell area. The summary returns all six
dimensions. `sc2_get_terrain_cell` also returns the owning cliff coordinate and any
matching descriptor cliff entry so callers do not have to infer the mapping.

## MCP tools

- `sc2_get_terrain_summary` decodes the descriptor and validates all present components.
- `sc2_get_terrain_vertex` and `sc2_set_terrain_height` operate on render and synchronized
  heights together.
- `sc2_get_terrain_cell` reads pathing flags, cliff level, eight texture weights, active
  texture set, and synchronized texture assignment.
- `sc2_set_terrain_cell_flags`, `sc2_set_terrain_texture`, and
  `sc2_set_terrain_cliff` perform bounded primitive edits.
- `sc2_get_terrain_component` and `sc2_patch_terrain_component` provide bounded base64
  access for advanced data. Raw patches preserve file length and are validated again
  before the transaction writes them. Fully decoded components check dimensions and exact
  expected length; advanced components check their documented header and versions. Magic
  or version bytes require `allow_header=true`.

All mutation tools default to `dry_run=true`, participate in workspace snapshots and
revision checks, and can be reverted through the normal change-history tools. Binary
changes report before and after hashes instead of pretending to produce a text diff.

## Verification

The codecs are covered by synthetic read, write, bounds, corruption, and transaction
tests. They also decode and cross-validate the editor-produced `EditorTest.SC2Map` shipped
with StarCraft II.

The write gate was tested on real packed maps. The MCP created and patched a layout,
changed render and synchronized height, pathing flags, texture masks and synchronized
texture assignment, plus a descriptor cliff and its synchronized 2x2 area. It validated,
repacked, and reopened each result before the Galaxy Editor opened and saved it. Final MCP
reopens retained the layout and every terrain value, terrain validation passed, and the
MPQ helper read every archive member successfully.

## Format source

The binary layouts are based on the reverse-engineered
[SC2 file format documentation](https://github.com/sc2-arcade-watcher/sc2-file-format-docs),
then checked against current editor-produced files. That repository is community research,
not an official Blizzard specification, so unsupported versions are rejected instead of
being guessed.

High-level height brushes, ramp construction, procedural terrain generation, and semantic
water-body authoring are not implemented. Primitive typed edits and validated raw access
remain available without advertising those higher-level workflows as complete.
