# Creating and publishing memory datasets

A memory dataset contains fictional project code, a frozen memory export from earlier Pace agents, and preparation provenance. Future task prompts, graders and solutions belong to the evaluator and stay outside the downloadable repository. Supabase in this guide stores dataset files; Basic Memory remains the local memory backend.

The examples use Bash and run from the Pace checkout unless stated otherwise. They are instructions for the dataset author; documenting a command does not start preparation, evaluation or publication.

## Choose a distribution method

| Location | Current Pace support | Version identity |
| --- | --- | --- |
| Local Git repository | Directly through `localRepository` | Full Git SHA plus `seed.json` SHA-256 |
| GitHub Git repository over HTTPS | Directly through `remote`; public or private with existing host Git credentials | Same SHA and checksum |
| Supabase Storage | Download a Git bundle, verify it, then restore a local Git repository | Same Git SHA and seed checksum, plus a separate bundle checksum |

The downloader calls `git clone`. A GitHub ZIP/release-asset URL or Supabase object URL is **not** a supported `remote`. There is no native Supabase downloader or database-backed dataset catalog. Dataset selection is pinned in `benchmark/memory/dataset.json`; `--dataset` overrides are rejected. See [the downloader](../src/benchmark/memory-dataset.ts).

## 1. Define the dataset before generating memory

Keep three parts separate:

| Part | Contents | Visible to the earlier agent? |
| --- | --- | --- |
| Project | Ordinary code, docs and existing tests sufficient for equal-information tasks | Yes |
| Historical preparation | Earlier requests, actual answers, usage, model/effort and source sessions | Only the historical request for that invocation |
| Evaluation | Future requests, rubric, severity, external checks and independent holdout | No |

Current authoring inputs are:

- `benchmark/memory/project.json`: map of relative paths to UTF-8 file contents.
- `benchmark/memory/scenarios.json`: historical `preparation`, six evaluated `cases`, separate `holdout`, fixed route and quality criteria.
- `benchmark/memory/dataset.json`: dataset identity, local repository, eventual remote, full commit and export checksum.

This pilot is tailored to Parcel Desk, not a general dataset builder. Quick selects the case ID `similar-bug`. The reader accepts stages `base` and `rates-v2`, requires `package.json` and `test.mjs`, and rejects symlinks/submodules. Preparation builds `rates-v2` by changing `national: 500` to `national: 700` in `src/quotes.mjs`. Keep these contracts for a compatible variant; a different project layout or stage model requires adapting [preparation](../src/benchmark/memory-prepare.ts), [schema/reader](../src/benchmark/memory-dataset.ts), profiles and their controlled tests.

For a new release such as `parcel-desk-v2`, first save the old inputs/pin in source control. Change the pin's `id` and `localRepository` to a new, nonexistent directory, for example `../pace-memory-dataset-v2`. Set `remote`, `visibility`, `commit` and `seedSha256` to `null`, and `status` to `preparation-required`. `version: 1` is the supported **format version**, not the dataset release number; do not change it to `2` just to name a second release.

Write the historical prompts without future requests or solutions. Freeze the evaluation rubric before the evaluated runs. Mark a private historical decision available only through memory as `continuity`; keep it separate from `equal-information` tasks. Choose code/data licensing and intended public/private access before publication. Do not seed from real user notes or remove inconvenient failures from preparation history.

## 2. Prepare locally, then freeze

If the current pin already points to a complete prepared dataset, skip generation and use that repository. Preparation refuses an existing destination, including an incomplete one; preserve the failed attempt and choose a new destination rather than deleting its evidence.

Preparation requires a debug checkout, authenticated Codex, Linux isolation and Basic Memory 0.24.1. Use the setup in Benchmark Center or an existing validated installation through `PACE_MEMORY_EXECUTABLE`; see [memory setup](memory.md). Setup for a benchmark must not select a real user's memory database.

Inspect the plan without model calls:

```bash
npm run benchmark -- run memory --profile prepare --preview
```

Only when the author chooses to generate a new seed, run the following separately. **It invokes earlier agents and consumes allowance.** It does not run the future evaluation scenarios.

```bash
npm run benchmark -- run memory --profile prepare --max-usd 2
```

The current three historical requests use the production adapter. On success, preparation requires at least three active notes and at least one relation, validates the frozen sources, commits the separate repository, and updates the Pace pin to `ready-local`. The dollar threshold prevents subsequent calls after it is reached; it is not a hard cap on an in-flight call. Preserve unknown costs as unknown.

Generated repository layout:

```text
pace-memory-dataset/
  project/                 # Base code, docs and ordinary project tests
  stages/rates-v2/         # Explicit later code snapshot
  seed.json                # Records, relationships, source sessions, policy, preparation
  history/1.json           # Actual earlier prompts, answers and usage; more numbered files follow
  dataset-manifest.json    # Source commit, stage hashes, checksum and preparation metadata
  README.md
```

`seed.json` is Pace's versioned record/source envelope, not a copied Basic Memory SQLite database. Preserve source IDs, types, status, branch/commit provenance and relations. Import requires the matching backend/policy and a fresh namespace. Do not hand-edit a frozen seed to improve a result; prepare a new release and document the correction.

## 3. Validate without running agents

Read the project, history, source sessions and the **entire Git history intended for publication**. A private note, credential or grader in an old commit is still published when that history is pushed or bundled. Normal project tests may be public; future external checks and holdout answers must remain outside the dataset, including its Git history. Avoid Git LFS for required files: the current reader reads Git blobs and does not resolve LFS pointers.

The following check reads only local files/Git objects. It does not launch a model or Basic Memory, write to the pin, or publish anything:

```bash
node --import tsx --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { memoryInputs, datasetProject } from './src/benchmark/memory-dataset.ts';
import { snapshotSchema } from './src/core/memory/snapshot.ts';
import { MEMORY_POLICY } from './src/core/memory/config.ts';

const { pin, suite } = await memoryInputs();
assert(pin.commit && pin.seedSha256, 'Preparation is incomplete');
const repo = resolve(pin.localRepository);
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 8_000_000 });
assert.equal(git('status', '--porcelain').toString(), '', 'Uncommitted dataset changes');
assert.equal(git('rev-parse', 'HEAD').toString().trim(), pin.commit, 'HEAD differs from pin');
const bytes = git('show', `${pin.commit}:seed.json`);
assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.seedSha256);
assert.deepEqual(readFileSync(`${repo}/seed.json`), bytes, 'Working file differs from committed seed');
const text = bytes.toString('utf8');
const snapshot = snapshotSchema.parse(JSON.parse(text));
assert.equal(JSON.stringify(snapshot.policy), JSON.stringify(MEMORY_POLICY));
for (const task of [...suite.cases, ...suite.holdout]) {
  assert(!text.includes(task.prompt), `Future prompt in seed: ${task.id}`);
  assert(!text.includes(task.verification), `Grader in seed: ${task.id}`);
}
for (const stage of new Set([...suite.cases, ...suite.holdout].map(task => task.stage))) {
  await datasetProject(repo, pin.commit, stage);
}
console.log({ id: pin.id, commit: pin.commit, seedSha256: pin.seedSha256,
  records: snapshot.records.length, sources: snapshot.sources.length });
JS
```

This verifies schema, policy, paths, snapshots and byte identity. Exact-string leakage checks do not replace manual review for paraphrased answers, secrets or bad provenance. A fresh backend import is a separate integration check performed when the author chooses to run the memory arm; this script does not perform it.

## 4A. Publish on GitHub

Create an **empty** repository in the intended personal account or organization. Choose public/private explicitly. Do not initialize it with another README, `.gitignore` or license when importing the prepared Git history. GitHub documents these choices in [Creating a new repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-new-repository).

After inspecting the prepared history, publish its `main` branch. The URL below is a template: replace `OWNER` and `DATASET` with the repository actually created. Use the dataset directory selected in the pin if it differs from this example.

```bash
dataset_repo="$(realpath ../pace-memory-dataset)"
git -C "$dataset_repo" remote add origin 'https://github.com/OWNER/DATASET.git'
git -C "$dataset_repo" push -u origin main
```

If `origin` already exists, inspect its intended destination instead of overwriting it or force-pushing. For a private repository, configure the host's Git credential helper first; GitHub CLI users can use `gh auth login` and [gh auth setup-git](https://cli.github.com/manual/gh_auth_setup-git). Verify repository access from the terminal before starting a noninteractive runner. Do not embed a token in the URL or pin. Git credentials belong to the host downloader and must not be copied into agent workspaces.

After a successful push, update `benchmark/memory/dataset.json`:

| Field | Value |
| --- | --- |
| `remote` | Actual HTTPS Git clone URL, ending in `.git` |
| `visibility` | The repository's actual `public` or `private` setting |
| `status` | `published` |
| `commit`, `seedSha256` | The validated frozen values, unchanged by pushing |
| `id`, `localRepository`, `version` | Keep the selected dataset identity, local fallback path and format |

Commit this pin and the matching evaluator inputs in Pace. A tag can help people find the release, but the runner pins the full commit, not a mutable tag or branch. A GitHub release ZIP is optional distribution material and is not a replacement clone URL. Nothing in this documentation creates a repository or changes the current live pin.

## 4B. Store a Git bundle in Supabase Storage

Use a file bucket; a database table or vector bucket is unnecessary for this artifact. Store a **self-contained Git bundle** so a recipient can recover the exact commit rather than reinitializing extracted files with a new SHA. Git documents creating and cloning these archives in [git-bundle](https://git-scm.com/docs/git-bundle).

Start with the validated dataset whose `main` points to the pinned commit. Export outside that repository:

```bash
dataset_repo="$(realpath ../pace-memory-dataset)"
dataset_export_dir="$(mktemp -d)"
git -C "$dataset_repo" bundle create "$dataset_export_dir/dataset.bundle" refs/heads/main
git -C "$dataset_repo" bundle verify "$dataset_export_dir/dataset.bundle"
node --input-type=module - "$dataset_export_dir" "$dataset_repo" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const [out, repo] = process.argv.slice(2);
const pin = JSON.parse(readFileSync('benchmark/memory/dataset.json', 'utf8'));
assert(pin.commit && pin.seedSha256, 'Preparation is incomplete');
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 8_000_000 });
assert.equal(git('rev-parse', 'refs/heads/main').toString().trim(), pin.commit);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256(git('show', `${pin.commit}:seed.json`)), pin.seedSha256);
const manifest = { format: 'git-bundle', datasetId: pin.id, commit: pin.commit,
  seedSha256: pin.seedSha256, bundleSha256: sha256(readFileSync(`${out}/dataset.bundle`)),
  objectKey: `${pin.id}/${pin.commit}/dataset.bundle` };
writeFileSync(`${out}/storage-manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
console.log({ directory: out, ...manifest });
JS
```

`storage-manifest.json` is a separate distribution record; its fields are **not** new Pace pin fields. Keep its expected hashes in a trusted release record. Bundle bytes may vary if repacked even when the Git commit is unchanged; the bundle checksum protects the exact uploaded file, while the seed checksum protects the export.

In the Supabase Dashboard, open the intended project and create a Storage bucket such as `pace-datasets`. Choose its access model before uploading:

- **Private:** downloads require authorized access under Storage RLS or a time-limited signed URL. Keep signed URLs out of committed manifests; share one only with intended recipients.
- **Public:** anyone with an object URL can read it. Public reads do not authorize uploads, replacements or deletion. See [bucket access models](https://supabase.com/docs/guides/storage/buckets/fundamentals).

Upload the bundle under the printed `objectKey` and the sidecar manifest alongside it, for example `parcel-desk-v1/FULL_SHA/storage-manifest.json`. Use a new prefix for each release and do not overwrite frozen objects. Configure bucket file-size/content-type limits to accept the bundle. Upload through the authenticated Dashboard; automation should use explicitly scoped access, without placing `service_role` or secret keys in a public client, dataset or manifest. Storage's upload and overwrite permissions are described in [access control](https://supabase.com/docs/guides/storage/security/access-control).

A public object uses the documented [Storage asset URL](https://supabase.com/docs/guides/storage/serving/downloads). For a private bucket obtain a fresh signed download URL through an authorized operator. Download on the host, outside all agent workspaces; substitute the real URL:

```bash
dataset_download_dir="$(mktemp -d)"
dataset_url='https://PROJECT_REF.supabase.co/storage/v1/object/public/pace-datasets/DATASET_ID/FULL_SHA/dataset.bundle'
curl --fail --location --proto '=https' --proto-redir '=https' \
  --output "$dataset_download_dir/dataset.bundle" "$dataset_url"
```

Before opening it with Git, compare the downloaded bundle's SHA-256 to `bundleSha256` from the trusted release record. Downloading both a file and an unchecked manifest from the same location does not authenticate either. For example, supply the expected 64-character digest and verify locally:

```bash
expected_bundle_sha='REPLACE_WITH_TRUSTED_SHA256'
node --input-type=module - "$dataset_download_dir/dataset.bundle" "$expected_bundle_sha" <<'JS' &&
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const [file, expected] = process.argv.slice(2);
assert.match(expected, /^[a-f0-9]{64}$/, 'Set the trusted bundle SHA-256 first');
assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), expected);
JS
git clone --branch main "$dataset_download_dir/dataset.bundle" ../pace-memory-dataset-from-storage
```

Choose a nonexistent restore directory. In the Pace pin, set `remote: null`, `localRepository` to that restored path and `status: "ready-local"`; retain the trusted dataset ID, full commit, seed checksum and actual visibility. Re-run the local validation in section 3 to compare the recovered commit/export. A separately uploaded bundle may be published in Storage while its Pace pin remains `ready-local`, because Pace consumes the restored Git repository. Never put an object/signed URL in `remote` or mark it as a working native Supabase integration.

## Release readiness

Before handing a dataset to another operator, provide the dataset ID, full commit, export checksum, code snapshots, preparation history/model/effort/usage and known/unknown costs, policy version, visibility, and distribution instructions. For Storage include the bundle checksum and object key; for GitHub include the real clone URL and required host authentication. Keep evaluation versions and rubric in the evaluator repository. Treat manual corrections, changed requirements and seed regeneration as new dataset releases. Publication and running benchmark scenarios are separate operator actions.

Sources checked on 2026-10-27: the linked official GitHub, Git and Supabase guides, plus the [Supabase changelog](https://supabase.com/changelog). This guide adds no remote adapter, SQL schema, credentials or hosted resources.
