# Notices

This project is not affiliated with or endorsed by Blizzard Entertainment. StarCraft II is
a trademark of Blizzard Entertainment, Inc.

No Blizzard game assets, extracted game data, or copyrighted map content is included in
this repository, and none will be. The server reads what is already installed on the user's
own machine, under paths that user has explicitly allowed.

## Third-party components

Nothing third-party is vendored into this repository. `scripts/bootstrap.ps1` fetches
sources at build time, pinned by commit in `vendor/PINS.json`:

| Component | Used for | License |
|---|---|---|
| [StormLib](https://github.com/ladislav-zezula/StormLib) | Reading and writing MPQ archives, via the `sc2mpq` sidecar | MIT |
| sc2-galaxy-toolkit | Parsing Galaxy scripts | see the upstream repository |

Each retains its own license; consult the upstream projects for terms.
