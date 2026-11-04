# Local verification

These tests exercise the contract in the repository's `README.md` and `FAQ.md`.
They are independent checks, not the course's hidden autograder, and cannot
promise a grade or validate your deployment/formal submission.

## Commands

Use Node 24 LTS, then:

```sh
npm ci
npm run check
npm test
```

- `npm run check` parses every project JavaScript file without running the server.
- `npm run test:unit` runs the input/query boundary tests without MongoDB.
- `npm run test:integration` runs HTTP tests against a temporary real MongoDB.
- `npm test` runs both suites sequentially. A setup failure is a failure, never a
  silently skipped integration suite.

## Database isolation

The integration suite starts a single-node MongoDB replica set through
`mongodb-memory-server`. It uses MongoDB 8.2.6 by default, WiredTiger, real
transactions, an ephemeral HTTP port, and a disposable `mp3_contract_tests`
database. It **does not read or use `MONGODB_URI`**. It deletes documents only in
that disposable database between tests and stops its server/database afterward.

The first integration run downloads the appropriate official `mongod` binary
(about 123 MB for the Linux build used here), then reuses its local cache. This
requires network access, enough temporary disk space, and permission to bind a
local TCP port. `--nounixsocket` avoids needing Unix-domain socket permissions on
Linux/macOS. The test setup permits 180 seconds for a first download.

If your machine cannot download/run MongoDB, read the setup error. Supported
`mongodb-memory-server` environment options include:

```sh
# Point to a MongoDB binary you have already installed locally.
MONGOMS_SYSTEM_BINARY=/absolute/path/to/mongod npm run test:integration

# Select an available MongoDB version for your operating system.
MONGOMS_VERSION=8.2.6 npm run test:integration
```

`MONGOMS_SYSTEM_BINARY` is a program path, not a database URI. The suite still
starts its own disposable replica set. Do not replace this setup with a shared
Atlas or production database. Use `npm run test:unit` to inspect pure validation
while fixing local setup, but that alone is not evidence that API integration
passes.

## What the suite checks

The HTTP tests cover all ten required CRUD operations, response envelopes/status
codes, server timestamps, whole-resource PUT semantics, defaults, collection
filters/sorting/projection/pagination/counts, the 100-task default limit, unlimited
user lists, single-resource select, no-match lists, malformed queries, input
validation, missing reference status codes, duplicate emails, form bodies, and
upper/lower-case ObjectId canonicalization.

Every completed test also checks both directions of all User/Task references.
Scenarios include task transfer between users, reassignment of completed tasks,
completion/reopening, renaming users with completed tasks, pendingTasks replacement,
user/task deletion, and empty assignments.

Six fault-injection cases verify that **each write operation** (POST/PUT/DELETE
for both resources) rolls back after a real earlier database write has occurred.
They temporarily replace one model method inside the test, assert the earlier
write is visible in that same transaction, throw a private marker error, and
check that the entire database snapshot is unchanged and the response does not
leak the marker. No production test endpoint or fault hook is added.

## Explicit implementation choices

- DELETE succeeds with HTTP 204 and **no response body**, per actual course
  autograder feedback from Nov 3, 2026. The contract tests assert the empty
  body. Errors (including nonexistent resources) still use JSON responses.
  CORS preflight also returns 204 with an empty body.
- `count=true` returns the total matching `where`, before `skip`/`limit`.
- `limit=0` uses MongoDB's unlimited convention.
- Explicit unassignment normalizes `assignedUserName` to `"unassigned"` even if a
  stale string name is provided. A mismatched name with an actual assignee is 400.
- Duplicate pending task ids are normalized to one canonical id.

These choices make ambiguous edge cases predictable. Consult course feedback if
the hidden grader specifies a different interpretation.
