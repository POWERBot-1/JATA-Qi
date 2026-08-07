# Marketplace / Product Provisioning Documentation

`@jataqi/product-marketplace` packages platform products as installable
modules with lifecycle management.

## Products (built-in)

| id | name | activates | depends on |
| -- | ---- | --------- | ---------- |
| tanya | TANYA AI | tanya | — |
| maza | MAZA AI | marketplace | — |
| soma | SOMA AI | automation | tanya |
| moto-x | Moto X | mobility | — |
| nyumbani | Nyumbani Kitchen | restaurants | maza |

Custom products register with any id/name/version/kind.

## Lifecycle

```
POST /products/install    { id }        → { installed, order }   # one-click + deps
POST /products/upgrade    { id }        → newer catalog version (platform-compat checked)
POST /products/uninstall  { id }        → blocked while dependents exist
POST /products/runtime    { id, runtime }  → provisioned | running | stopped
GET  /products/catalog | /products/installed | /products/upgrades
GET  /products/dependencies?id=         → install order + cycles
GET  /products/stats
```

## Dependency resolution

- Topological install order (DFS, cycle detection): installing `soma`
  auto-installs `tanya` first (`order: ["tanya","soma"]`).
- Uninstall of `maza` is blocked while `nyumbani` depends on it.
- Version compatibility: `minPlatformVersion` and constraint strings are
  validated against the platform version before install/upgrade.

## Version compatibility

`versionLess(a,b)` and `satisfiesConstraint(v,c)` support `>=`, `<=`, `>`,
`<`, `^`, and exact semver comparisons — used to reject platform-incompatible
products before provisioning.

## Provisioning runbook

```bash
jataqi products catalog                 # browse
jataqi products install soma            # one-click (deps auto)
jataqi products runtime soma running    # register runtime
jataqi products upgrades                # check newer versions
jataqi products upgrade soma
jataqi products uninstall tanya         # blocked (soma depends)
jataqi products deps nyumbani           # maza → nyumbani
```
