# SC2 document formats — verified notes

Findings recorded as they are **verified against real editor output**, per PLAN.md §55
rules 1 and 15. Anything here that is inference rather than observation says so.

## Sources used so far

| Source | What it is | Why it counts |
|---|---|---|
| `<install>/maps/Test/EditorTest.SC2Map` | An **unpacked** `.SC2Map` shipped with retail StarCraft II, with a full component set: GameData, triggers, terrain, regions, placed objects, localization, custom AI, imported assets | Genuine Galaxy Editor output, not a community reconstruction |
| Editor build 97563 (5.0.16); the sample map's components were last written by build **93333** | Current retail | Format details below may be build-specific; the build is recorded so a future discrepancy is diagnosable |

Everything below was read from that map. Nothing from it is committed to this
repository; `tests/real-document.integration.test.ts` reads it in place and skips itself
where StarCraft II is not installed.

---

## Document layout

The unpacked sample contains, at the document root:

```text
ComponentList.SC2Components   Component index
DocumentInfo  DocumentInfo.version
DocumentHeader
MapInfo       MapInfo.version
Attributes    Attributes.version
Triggers      Triggers.version
Objects       Objects.version
Regions       Regions.version
CustomAI      CustomAI.version
GameData.version                  <- note: no `GameData` file, only the .version sidecar
GameText.version
t3Terrain.xml t3Terrain.version
t3HeightMap  t3CellFlags  t3TextureMasks  t3SyncHeightMap  t3SyncCliffLevel
t3SyncTextureInfo  t3VertCol  t3Water  t3HardTile  t3FluffDoodad
MapScript.galaxy
Minimap.tga
BankList.xml  Preload.xml  PreloadAssetDB.txt
Base.SC2Data/GameData/*.xml
enUS.SC2Data/LocalizedData/{GameStrings,ObjectStrings,TriggerStrings,GameHotkeys}.txt
Assets/…                          <- imported, map-local
```

**`*.SC2Data` layers.** Data lives in named layers: `Base.SC2Data` for locale-independent
data, `<locale>.SC2Data` for localized data. A component's declared path is a name
resolved *inside* these layers, not a path from the document root — see below.

---

## `ComponentList.SC2Components`

Encoding: UTF-8, **no BOM**. Line endings: **CRLF**. **No trailing newline** — the file
ends immediately after `</Components>`.

```xml
<?xml version="1.0" encoding="utf-8"?>
<Components>
    <DataComponent Type="gada">GameData</DataComponent>
    <DataComponent Type="text" Locale="enUS">GameText</DataComponent>
    <DataComponent Type="info">DocumentInfo</DataComponent>
    <DataComponent Type="mapi">MapInfo</DataComponent>
    <DataComponent Type="trig">Triggers</DataComponent>
    <DataComponent Type="terr">t3Terrain.xml</DataComponent>
    <DataComponent Type="plob">Objects</DataComponent>
    <DataComponent Type="attr">Attributes</DataComponent>
    <DataComponent Type="aiai">CustomAI</DataComponent>
    <DataComponent Type="regi">Regions</DataComponent>
</Components>
```

Two things worth stating because both are easy to get wrong from prose descriptions:

1. **The path is the element's text content, not an attribute.** There is no `Path="…"`.
2. **The path is a logical name, not always a file path.** `GameData` names the `GameData`
   directory inside each `*.SC2Data` layer; `GameText` names `LocalizedData` inside the
   locale layer. Only some entries (`terr` → `t3Terrain.xml`, `info` → `DocumentInfo`)
   name a real file at the document root. `parseComponentList` handles both cases and
   reports what each entry actually resolved to.

Type codes observed: `gada`, `text`, `info`, `mapi`, `trig`, `terr`, `plob`, `attr`,
`aiai`, `regi`. Others exist (`cutc`, `bank`, `prel`, `layo` are in our lookup table but
were **not** observed in this sample). The set is open — an unknown code is reported
as-is rather than dropped.

---

## `DocumentInfo`

Encoding: UTF-8, no BOM. CRLF. **With** a trailing CRLF — unlike `ComponentList`.

> That inconsistency is not a curiosity, it is the argument for span-based lossless
> editing (PLAN.md §12). Any writer that "normalises" trailing newlines produces a diff
> on every file it touches, and a repack that differs from the editor's own output.

Every scalar is wrapped in `<Value>`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<DocInfo>
    <ModType><Value>Interface</Value></ModType>
    <Icon><Value>c80[1].tga</Value></Icon>
    <Dependencies>
        <Value>bnet:Void Multi (Mod)/0.0/999,file:Mods/VoidMulti.SC2Mod</Value>
        <Value>bnet:Nova Covert Ops (Art Mod)/0.0/999,file:Mods/NovaStoryAssets.SC2Mod</Value>
        <Value>bnet:Co-op Mission/0.0/999,file:Mods/StarCoop/StarCoop.SC2Mod</Value>
    </Dependencies>
    <Screenshot>
        <File><Value>unknown[2].tga</Value></File>
        <CaptionId><Value>1</Value></CaptionId>
        <Flags><Value> </Value></Flags>
    </Screenshot>
</DocInfo>
```

Observations:

- **Fields are freely omitted.** The sample has no `<Name>` and no `<Author>` at all. Any
  parser that assumes their presence is wrong; absent must be modelled as distinct from
  empty.
- **Whitespace-only values occur.** `<Flags><Value> </Value></Flags>` holds a single
  space. Trimming it to `null` would lose a real value.
- **Dependency format:** `bnet:<Name>/<Major>.<Minor>/<Build>,file:<path>`. The name may
  contain spaces and parentheses; the file path may contain slashes. Split on the first
  `/` only when extracting the display name.
- **Declaration order is resolution order** (PLAN.md §25). Preserve it.

---

## `*.version` sidecars

Every major component has a 44-byte `<Component>.version` companion. For `GameData.version`:

```text
63 64 65 73  61 64 61 67  02 00 00 00  95 6C 01 00
05 00 00 00  00 00 00 00  0E 00 00 00  95 6C 01 00
04 01 00 00  C7 97 F1 67  01 00 00 00
```

- Bytes 0–3: `63 64 65 73` — the ASCII `sedc` stored **byte-reversed**, the usual Blizzard
  little-endian four-character-code convention.
- Bytes 4–7: `61 64 61 67` — `gada` reversed, i.e. **the component's own type code**.
- Bytes 12–15 and 28–31: `95 6C 01 00` = `0x00016C95` = **93333**, which matches a
  `Versions/Base93333` directory in the installation. So the sidecar records the editor
  build that last wrote the component.
- Bytes 36–39 look like a Unix timestamp (`0x67F197C7`). **Inferred, not verified.**

The remaining fields are not yet understood and must not be synthesised.

---

## Binary component magics

Read from the first bytes of each file; all are byte-reversed four-character codes.

| File | First 4 bytes | Reads as | Next DWORD |
|---|---|---|---|
| `MapInfo` | `49 70 61 4D` | `MapI` | `0x27` = 39 (version) |
| `DocumentHeader` | `48 32 43 53` | `SC2H` | `0x08` = 8 (version) |

`MapInfo` version 39 is what editor build 97563 writes. PLAN.md §24 requires a validated
codec and version gating before any binary write; nothing here is enough to write these.

---

## `t3Terrain.xml`

XML, `<terrain version="115">`. The sample's height map is `dim="257 257"` — i.e.
(cells + 1) in each direction — with `tileSet="Zerus"` and a `<cliffSetList>`. The bulk of
terrain data lives in the sibling binary files (`t3HeightMap`, `t3CellFlags`,
`t3TextureMasks`, and the `t3Sync*` set), which are **not yet analysed**.

Sizes from the sample are a useful sanity check for any future codec:
`t3TextureMasks` is 16,777,280 bytes (= 16 MiB + 64), `t3HeightMap` 396,326,
`t3SyncHeightMap` 264,260, `t3SyncCliffLevel` 131,104, `t3CellFlags` 65,568. The recurring
`+ 64` and `+ 32` offsets suggest a fixed header ahead of a flat array — **inferred, not
verified**.

---

## Localized text tables

`<locale>.SC2Data/LocalizedData/GameStrings.txt` is plain `Key=Value`, one per line:

```text
Abil/Name/AnabolicsteroidAbility=Anabolic steroid Ability
Abil/Name/Assasins=Assasins
```

Keys are `<Category>/<Field>/<ObjectId>`. Sibling files `ObjectStrings.txt`,
`TriggerStrings.txt`, and `GameHotkeys.txt` use the same shape. Encoding and newline
conventions have **not** yet been checked byte-for-byte; do that before writing them
(PLAN.md §22).

---

## Not yet examined

- `Triggers` (1 MB in the sample), `Objects`, `Regions`, `Attributes`, `CustomAI` — all
  binary, all unanalysed.
- `MapScript.galaxy` — generated from the trigger data; must never be hand-edited as if it
  were a source file.
- `PreloadAssetDB.txt`, `Preload.xml`, `BankList.xml`.
- Packed `.SC2Map` archive layout — blocked on the `sc2mpq` helper being built
  (see [native-helper.md](native-helper.md)).
