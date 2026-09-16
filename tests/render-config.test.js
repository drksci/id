import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * `infra/render-wrangler-config.py` required all four D1 database ids on every run, so a production
 * deploy failed because a *preview* database id was unset — and the error named the wrong
 * environment. These tests pin the behaviour that replaced it, against the real wrangler.toml.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT = join(ROOT, 'infra/render-wrangler-config.py');

const IDS = {
  PROD: '1234abcd-1234-4abc-8abc-1234567890ab',
  DEV: 'abcd1234-1234-4abc-8abc-1234567890ab',
  TEST: 'abcd1234-1234-4abc-8abc-1234567890ac',
  PREVIEW: 'abcd1234-1234-4abc-8abc-1234567890ad',
};

function run(args, env = {}) {
  // Clear every D1 variable first, so a stray value in the ambient environment cannot mask a bug.
  const base = { ...process.env };
  for (const key of Object.keys(IDS)) delete base[`D1_DATABASE_ID_${key}`];
  Object.assign(base, env);
  try {
    const stdout = execFileSync('python3', [SCRIPT, ...args], {
      cwd: ROOT, env: base, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function outFile() {
  return join(mkdtempSync(join(tmpdir(), 'render-')), 'wrangler.toml');
}

test('prod renders with only prod\'s database id set', () => {
  const output = outFile();
  const result = run(['--env', 'prod', '--output', output], { D1_DATABASE_ID_PROD: IDS.PROD });

  assert.equal(result.code, 0, result.stderr);
  const rendered = readFileSync(output, 'utf8');
  assert.match(rendered, new RegExp(IDS.PROD));
  assert.equal(rendered.includes('${D1_DATABASE_ID_PROD}'), false, 'the target must be resolved');
});

test('deploying one environment does not require the other three', () => {
  for (const [name, value] of Object.entries(IDS)) {
    const result = run(['--env', name.toLowerCase(), '--check'], { [`D1_DATABASE_ID_${name}`]: value });
    assert.equal(result.code, 0, `${name} must not depend on the others:\n${result.stderr}`);
  }
});

test('a non-target environment is never blamed', () => {
  const result = run(['--env', 'prod', '--output', outFile()], {});
  assert.equal(result.code, 1);
  assert.match(result.stderr, /D1_DATABASE_ID_PROD/);
  assert.doesNotMatch(result.stderr, /D1_DATABASE_ID_(DEV|TEST|PREVIEW)/, 'must not mention an environment nobody deployed');
});

test('a missing id names the variable, the environment and the exact fix', () => {
  const result = run(['--env', 'dev', '--output', outFile()], {});
  assert.equal(result.code, 1);
  assert.match(result.stderr, /cannot render the dev deployment/);
  assert.match(result.stderr, /D1_DATABASE_ID_DEV is not set/);
  assert.match(result.stderr, /gh variable set D1_DATABASE_ID_DEV --env dev/);
  assert.match(result.stderr, /d1 create id-data-dev/);
});

test('a malformed id is rejected with the offending value shown', () => {
  const result = run(['--env', 'prod', '--output', outFile()], { D1_DATABASE_ID_PROD: 'not-a-uuid' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /is not a UUID/);
  assert.match(result.stderr, /not-a-uuid/);
});

test('--check validates and writes nothing', () => {
  const output = outFile();
  const ok = run(['--env', 'prod', '--check'], { D1_DATABASE_ID_PROD: IDS.PROD });
  assert.equal(ok.code, 0, ok.stderr);

  const bad = run(['--env', 'prod', '--check'], {});
  assert.equal(bad.code, 1);
  assert.equal(existsSync(output), false, 'a check must not create a file');
});

test('an unknown environment is refused rather than guessed at', () => {
  const result = run(['--env', 'staging', '--output', outFile()], { D1_DATABASE_ID_PROD: IDS.PROD });
  assert.equal(result.code, 2, 'argparse must reject it before any work happens');
});

test('the output path is required unless checking', () => {
  const result = run(['--env', 'prod'], { D1_DATABASE_ID_PROD: IDS.PROD });
  assert.equal(result.code, 2);
});

test('placeholders for other environments survive so they stay deployable', () => {
  const output = outFile();
  run(['--env', 'prod', '--output', output], { D1_DATABASE_ID_PROD: IDS.PROD });
  const rendered = readFileSync(output, 'utf8');

  for (const name of ['DEV', 'TEST', 'PREVIEW']) {
    assert.match(rendered, new RegExp(`\\$\\{D1_DATABASE_ID_${name}\\}`), `${name} placeholder must remain`);
  }
});

test('every environment in the real config can be rendered on its own', () => {
  for (const [name, value] of Object.entries(IDS)) {
    const output = outFile();
    const result = run(['--env', name.toLowerCase(), '--output', output], { [`D1_DATABASE_ID_${name}`]: value });
    assert.equal(result.code, 0, result.stderr);
    assert.match(readFileSync(output, 'utf8'), new RegExp(value), `${name} id must be substituted`);
  }
});

test('the renderer never writes into the repository', () => {
  const result = run(['--env', 'prod', '--output', outFile()], { D1_DATABASE_ID_PROD: IDS.PROD });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(join(ROOT, 'infra/wrangler.generated.toml')), false, 'output goes where it is told');
  assert.equal(readFileSync(join(ROOT, 'infra/wrangler.toml'), 'utf8').includes(IDS.PROD), false, 'the template is untouched');
});
