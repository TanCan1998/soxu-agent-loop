import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readModelSettings, selectModel } from './model-settings.mjs';
import { ROOT } from './config.mjs';
import { isModelIdentifier } from './model-identifiers.mjs';

const VALID_THINKING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const ROLES = ['developer', 'reviewer'];

function optionalToken(value, key) {
  if (value === undefined || value === null || value === '') return null;
  if (!isModelIdentifier(value)) {
    throw new Error(`Invalid ${key}: use a Pi provider/model identifier, not CLI flags or shell syntax`);
  }
  return value;
}

/** Resolve explicit SOXU model selection; no API key or secret is stored here. */
export function resolveRoleModels(configuration, env = process.env) {
  if (!configuration || configuration.schemaVersion !== 1 || !configuration.roles || typeof configuration.roles !== 'object') {
    throw new Error('Invalid automation/agent-models.json schema');
  }
  const result = {};
  for (const role of ROLES) {
    const raw = configuration.roles[role];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Missing model role: ${role}`);
    const prefix = `SOXU_${role.toUpperCase()}_`;
    const provider = optionalToken(env[`${prefix}PROVIDER`] ?? raw.provider, `${role}.provider`);
    const model = optionalToken(env[`${prefix}MODEL`] ?? raw.model, `${role}.model`);
    // Prevent accidental fallback to another provider's paid model.
    if (Boolean(provider) !== Boolean(model)) throw new Error(`${role}: provider and model must be set together (or both null to inherit Pi defaults)`);
    const thinking = optionalToken(env[`${prefix}THINKING`] ?? raw.thinking, `${role}.thinking`);
    if (thinking && !VALID_THINKING.has(thinking)) throw new Error(`${role}.thinking must be one of ${[...VALID_THINKING].join(', ')}`);
    result[role] = { provider, model, thinking };
  }
  return result;
}

export async function loadRoleModels(env = process.env, {index=0, root=ROOT} = {}) {
  const path = resolve(root, 'automation/agent-models.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  const baseline=resolveRoleModels(config, env);
  const settings=await readModelSettings(root);
  const result={};
  for (const role of ["developer","reviewer","product","quality","intake"]) {
    const baseRole=["developer","product","intake"].includes(role) ? "developer" : "reviewer";
    const prefix=`SOXU_${baseRole.toUpperCase()}_`;
    const overridden=role===baseRole && (env[`${prefix}PROVIDER`] || env[`${prefix}MODEL`]);
    result[role]=overridden ? baseline[baseRole] : selectModel(settings,role,index,baseline[baseRole]);
  }
  return result;
}

export function modelArgs(selection = {}) {
  const provider = optionalToken(selection.provider, 'provider');
  const model = optionalToken(selection.model, 'model');
  const thinking = optionalToken(selection.thinking, 'thinking');
  if (Boolean(provider) !== Boolean(model)) throw new Error('Pi model must specify both provider and model');
  if (thinking && !VALID_THINKING.has(thinking)) throw new Error('Unsupported Pi thinking level');
  return [...(provider ? ['--provider', provider, '--model', model] : []), ...(thinking ? ['--thinking', thinking] : [])];
}
