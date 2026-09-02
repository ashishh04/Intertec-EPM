# P1 Comments — Phase 1 discovery (OpenProject 15.5.1, verified live)

Comments are not a resource of their own. They are **journal activities** on a work
package, which is why almost nothing here matches how attachments behave.

## Endpoints

| concern | finding |
|---|---|
| list | `GET /work_packages/:id/activities` → HAL Collection of `Activity`. There is no `/comments` endpoint (404) and no global `/activities` collection (404). |
| create | `POST /work_packages/:id/activities`, body `{"comment":{"raw":"…"}}` → 201 |
| edit | `PATCH /activities/:id`, body `{"comment":"…"}` → 200 |
| delete | **Not supported.** `DELETE /activities/:id` and `DELETE /work_packages/:id/activities/:id` both 404, and no `delete` affordance is ever published. |
| schema/form | `/activities/schema`, `/work_packages/:id/activities/form` → 404 |

### The create and edit payloads differ

This is the trap. Create wants a nested resource, edit wants a bare string:

```
POST {"comment":{"raw":"text"}}            201
PATCH {"comment":"text"}                   200
PATCH {"comment":{"raw":"text"}}           400  "Bad request: comment is invalid"
PATCH {"comment":{"format":"markdown",…}}  400  "Bad request: comment is invalid"
```

### Deletion, and what looks like it

`PATCH` with an empty string returns 200 but does not remove anything — OpenProject
replaces the text with its own tombstone, `_The changes were retracted._`, and the
entry keeps its place in the journal. Patching to whitespace keeps the whitespace and
flips `_type` to `Activity`. Neither is a delete, and neither is offered as one.

## Element shape

Two `_type` values come back from the same collection:

- `Activity::Comment` — a comment
- `Activity` — a journal entry recording field changes, with an empty `comment.raw`

```json
{ "_type": "Activity::Comment", "id": 96, "version": 3,
  "comment": { "format": "markdown", "raw": "…", "html": "<p class=\"op-uc-p\">…</p>" },
  "details": [ { "format": "custom", "raw": "Type set to User story", "html": "…" } ],
  "createdAt": "…", "updatedAt": "…",
  "_links": { "self": …, "workPackage": …, "user": …, "update": … } }
```

| field | finding |
|---|---|
| author | `_links.user` carries an href and **no title**, unlike relation endpoints. Names must be resolved separately. |
| timestamps | `createdAt` and `updatedAt` are both present; `updatedAt` moves on edit, so "edited" is derivable. |
| body | `comment.format` is always `markdown`. Both `raw` and upstream-rendered `html` are returned. |
| affordances | `self`, `workPackage`, `user`, and `update` when the caller may edit. No `delete`, ever. |

## Pagination

Not honoured. `pageSize` and `offset` are accepted and ignored: `total` always equals
`count`, `pageSize` comes back `null`, and the collection publishes only a `self` link —
no `nextByOffset`. The full journal arrives in one response, so paging is EPM's to do
in the client if it wants it.

## Mentions

Supported, as markup inside `raw`:

```
<mention class="mention" data-id="6" data-type="user" data-text="@Restricted User">…</mention>
```

renders in `html` as `<a class="user-mention" href="/users/6">Restricted User</a>`.
Round-trips intact. No autocomplete source is exposed by this endpoint.

## Attachments on comments

None. `addAttachment` is published on the work package, not on an activity, and an
activity carries no attachment link. Files belong to the work package.

## HTML safety

Upstream sanitises: `<script>alert(1)</script>` comes back escaped in `html`. But
`<img src=x onerror=alert(2)>` is rendered as a real `<img>` element with the handler
stripped, so `html` is upstream-sanitised markup rather than inert text.

EPM does not pass `html` to the browser. The BFF exposes `raw` only and it is rendered
as text, so no upstream markup is ever injected into EPM's origin. The cost is that
markdown shows literally; that is a deliberate trade, not an oversight.

## Permissions, both identities

Established through the BFF, since OpenProject refuses basic auth with a user's own
password:

| action | admin | restricted |
|---|---|---|
| view task | 200 | 200 |
| list comments | 200 | 200 |
| create comment | 201 | **403** — no `addComment` link published |
| empty comment | 400 | 400 |

Commenting is gated by the work package's `addComment` link; editing by each
activity's own `update` link. Admin sees `update` on every activity, including
comments written by other users.
