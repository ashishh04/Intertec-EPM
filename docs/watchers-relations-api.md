# P1 Watchers & Relations — Phase 1 discovery (OpenProject 15.5.1, verified live)

## Watchers
| concern | finding |
|---|---|
| list | `GET /work_packages/:id/watchers` → 200, HAL collection of User |
| candidates | `GET /work_packages/:id/available_watchers` → 200; **excludes existing watchers** |
| add | WP `_links.addWatcher` → POST `/work_packages/:id/watchers`, body `{"user":{"href":"/api/v3/users/:id"}}` → 201, returns the User |
| remove | WP `_links.removeWatcher` → DELETE `/work_packages/:id/watchers/{user_id}` (templated) |
| self | WP `_links.watch` present ⇔ current user is NOT watching; `_links.unwatch` present ⇔ they ARE. Verified by flipping. |
| authz | remove affordance lives on the **work package**, not on each watcher element. Watcher elements carry no `removeWatcher`. |

## Relations
`GET /work_packages/:id/relations` **308-redirects** to
`/relations?filters=[{"involved":{"operator":"=","values":["<id>"]}}]` — that is the real endpoint.

Element shape: `{id, name, type, reverseType, lag, description, _links:{self, from, to, updateImmediately, delete}}`

### Verified type vocabulary — 6 canonical pairs, 11 accepted aliases
| canonical `type` | `reverseType` | symmetric |
|---|---|---|
| relates | relates | yes |
| duplicates | duplicated | no |
| blocks | blocked | no |
| follows | precedes | no |
| includes | partof | no |
| requires | required | no |

`parent` is *accepted* by the endpoint but returns no `reverseType` and does not set the
work package's `parent` link. Excluded: hierarchy is a separate mechanism.

### Direction — the trap
OpenProject **canonicalizes on write**: POSTing a reverse alias flips `from`/`to` and stores
the canonical form. Verified for all 5 asymmetric pairs, e.g. `POST 14 -> 15 type=precedes`
stores `15 --follows--> 14`.

Read normalization, for a context work package C:
- `from == C` → other = `to`,   effective type = `type`
- `to   == C` → other = `from`, effective type = `reverseType`
Proven: `14 --relates--> 15` renders correctly from both ends.

### Constraints (all 422)
- self-relation → "This relation would create a circular dependency."
- duplicate, same direction → "Multiple field constraints have been violated."
- duplicate, reverse direction → "This relation would create a circular dependency."

### No schema source
`/relations/schema`, `/relations/:id/schema`, `/relations/form`,
`/work_packages/:id/relations/form` are all 404. The vocabulary above is empirical;
reverse-direction human labels have no upstream source.
