import { Byoky, getProvider, getProviderIds, type ByokySession } from '@byoky/sdk';
import { buildGates, createScene, disposeGates, updateGates, type GateRefs } from './scene';
import { createSim, type PilotMode } from './sim';
import { createLlmAgent } from './agents/llm';
import { createReplayAgent } from './agents/replay';
import {
  SCENARIOS,
  createWaypointScenario,
  getScenarioById,
  type Scenario,
  type ScenarioState,
  type ScenarioStatus,
} from './scenario';
import {
  getPersonalBest,
  loadRuns,
  maybeUpdatePB,
  saveRun,
  type ActionLogEntry,
  type RunRecord,
} from './recorder';
import type { Action, Agent, Observation } from './types';

const PHYSICS_TIMESTEP = 1 / 60;
const LLM_PHASE = 0.5;
const DEFAULT_MODEL = 'anthropic:claude-sonnet-4-6';
const MODEL_KEY = 'strongdrone:model-v2';
const PILOT_MODE_KEY = 'strongdrone:pilot-mode';
const DEFAULT_PILOT_MODE: PilotMode = 'round';
const RECENT_DECISIONS_MAX = 6;
const SUPPORTED_PROVIDERS = new Set([
  'anthropic',
  'openai',
  'gemini',
  'groq',
  'perplexity',
  'together',
  'fireworks',
  'deepseek',
  'xai',
  'openrouter',
  'mistral',
  'azure_openai',
  'ollama',
  'lm_studio',
]);

type Mode = 'llm' | 'replay';

const ONBOARDING_KEY = 'strongdrone:onboarding-seen-v2';

function setupOnboarding() {
  const el = document.getElementById('onboarding') as HTMLDivElement | null;
  const close = document.getElementById('onboarding-close') as HTMLButtonElement | null;
  if (!el || !close) return;
  if (!localStorage.getItem(ONBOARDING_KEY)) el.hidden = false;
  close.addEventListener('click', () => {
    el.hidden = true;
    try { localStorage.setItem(ONBOARDING_KEY, '1'); } catch {}
  });
}

async function main() {
  setupOnboarding();
  const refs = createScene();
  let scenario: Scenario = createWaypointScenario(SCENARIOS[0]);
  let gates: GateRefs = buildGates(refs.scene, scenario.getGatePositions());

  const hoverAgent: Agent = { decide: () => ({ type: 'hover' }) };
  let llmAgent: Agent | null = null;
  let session: ByokySession | null = null;
  let mode: Mode = 'llm';
  let pilotMode: PilotMode =
    (localStorage.getItem(PILOT_MODE_KEY) as PilotMode | null) === 'live'
      ? 'live'
      : DEFAULT_PILOT_MODE;
  let selectedModel = localStorage.getItem(MODEL_KEY) || DEFAULT_MODEL;

  const sim = createSim(
    hoverAgent,
    () => ({ scenarioState: scenario.getState(), gates: scenario.getGatePositions() }),
    { actionPhaseDuration: LLM_PHASE, physicsTimestep: PHYSICS_TIMESTEP, pilotMode }
  );

  // --- recording ---
  let actionLog: ActionLogEntry[] = [];
  let recentDecisions: ActionLogEntry[] = [];
  let runStartedAt = Date.now();
  let prevStatus: ScenarioStatus = 'running';
  let lastBanner: string | null = null;
  let personalBest: number | null = getPersonalBest(scenario.getDefinition().id, pilotMode);
  let runCount = countRunsFor(scenario.getDefinition().id, pilotMode);
  let lastShareableRun: RunRecord | null = null;
  let engaged = false;

  sim.setOnDecision((event) => {
    actionLog.push(event);
    recentDecisions.push(event);
    if (recentDecisions.length > RECENT_DECISIONS_MAX) recentDecisions.shift();
  });

  function resetRun() {
    sim.reset();
    scenario.reset();
    actionLog = [];
    recentDecisions = [];
    runStartedAt = Date.now();
    prevStatus = 'running';
    lastBanner = null;
    engaged = false;
  }

  function startRun() {
    if (mode === 'replay' || !llmAgent) return;
    resetRun();
    runStartedAt = Date.now();
    engaged = true;
    updateUi();
  }

  function stopRun() {
    if (mode === 'replay') return;
    engaged = false;
    updateUi();
  }

  function switchScenario(id: string) {
    disposeGates(refs.scene, gates);
    scenario = createWaypointScenario(getScenarioById(id));
    gates = buildGates(refs.scene, scenario.getGatePositions());
    personalBest = getPersonalBest(id, pilotMode);
    runCount = countRunsFor(id, pilotMode);
    resetRun();
    lastShareableRun = null;
    updateUi();
  }

  function setPilotMode(next: PilotMode) {
    if (engaged) return;
    pilotMode = next;
    sim.setPilotMode(next);
    try { localStorage.setItem(PILOT_MODE_KEY, next); } catch {}
    const id = scenario.getDefinition().id;
    personalBest = getPersonalBest(id, pilotMode);
    runCount = countRunsFor(id, pilotMode);
    resetRun();
    lastShareableRun = null;
    updateUi();
  }

  function onRunComplete(sc: ScenarioState) {
    if (mode === 'replay') {
      lastBanner =
        sc.status === 'success'
          ? `REPLAY COMPLETE  ${sc.score!.toFixed(2)}s   press Stop Replay`
          : `REPLAY ENDED  ${sc.status}  press Stop Replay`;
      return;
    }
    const scenarioId = scenario.getDefinition().id;
    const run: RunRecord = {
      version: 3,
      scenarioId,
      seed: 0,
      actionLog: [...actionLog],
      actionPhaseDuration: LLM_PHASE,
      physicsTimestep: PHYSICS_TIMESTEP,
      status: sc.status,
      score: sc.score,
      durationSimTime: sc.elapsedSimTime,
      startedAt: runStartedAt,
      agentMode: 'llm',
      pilotMode,
      model: selectedModel,
    };
    saveRun(run);
    runCount += 1;
    lastShareableRun = run;
    engaged = false;

    if (sc.status === 'success' && sc.score !== null) {
      const { isNewBest, previousBest } = maybeUpdatePB(scenarioId, pilotMode, sc.score);
      personalBest = isNewBest ? sc.score : previousBest;
      lastBanner = isNewBest
        ? `SUCCESS  ${sc.score.toFixed(2)}s   NEW BEST  press R to retry`
        : `SUCCESS  ${sc.score.toFixed(2)}s   best ${previousBest!.toFixed(2)}s   press R to retry`;
    } else if (sc.status === 'crashed') {
      lastBanner = `CRASHED  press R to retry`;
    } else if (sc.status === 'timeout') {
      lastBanner = `TIMEOUT  press R to retry`;
    }
    updateUi();
  }

  // --- UI refs ---
  const connectBtn = document.getElementById('connect-ai') as HTMLButtonElement;
  const statusEl = document.getElementById('ai-status') as HTMLDivElement;
  const shareBtn = document.getElementById('share-btn') as HTMLButtonElement;
  const picker = document.getElementById('scenario-picker') as HTMLSelectElement;
  const modelPicker = document.getElementById('model-picker') as HTMLSelectElement;
  const modeBadge = document.getElementById('mode-badge') as HTMLDivElement;
  const replayLastBtn = document.getElementById('replay-last') as HTMLButtonElement;
  const stopReplayBtn = document.getElementById('stop-replay') as HTMLButtonElement;
  const startBtn = document.getElementById('start-btn') as HTMLButtonElement;
  const stopBtn = document.getElementById('stop-btn') as HTMLButtonElement;
  const runSection = document.getElementById('run-section') as HTMLDivElement;
  const aiSection = document.getElementById('ai-section') as HTMLDivElement;
  const modeRoundBtn = document.getElementById('mode-round') as HTMLButtonElement;
  const modeLiveBtn = document.getElementById('mode-live') as HTMLButtonElement;
  const byoky = new Byoky();

  for (const def of SCENARIOS) {
    const opt = document.createElement('option');
    opt.value = def.id;
    opt.textContent = `${def.name} — ${def.description}`;
    picker.appendChild(opt);
  }
  picker.value = scenario.getDefinition().id;
  picker.addEventListener('change', () => switchScenario(picker.value));

  modelPicker.value = selectedModel;
  modelPicker.addEventListener('change', () => {
    selectedModel = modelPicker.value;
    localStorage.setItem(MODEL_KEY, selectedModel);
    if (session) {
      const { providerId, modelId } = parseModelKey(selectedModel);
      llmAgent = createLlmAgent({ session, providerId, modelId });
      statusEl.textContent = `${modelId} via ${getProvider(providerId)?.name ?? providerId}`;
      if (mode === 'llm') sim.setAgent(llmAgent);
    }
  });

  function setLlmMode() {
    mode = 'llm';
    sim.setAgent(llmAgent ?? hoverAgent);
    sim.setActionPhaseDuration(LLM_PHASE);
    sim.setPilotMode(pilotMode);
    resetRun();
    updateUi();
  }

  function startReplay(record: RunRecord) {
    if (record.scenarioId !== scenario.getDefinition().id) {
      switchScenario(record.scenarioId);
    } else {
      resetRun();
      lastShareableRun = null;
    }
    sim.setAgent(createReplayAgent(record.actionLog));
    sim.setActionPhaseDuration(record.actionPhaseDuration ?? LLM_PHASE);
    sim.setPilotMode(record.pilotMode ?? 'round');
    mode = 'replay';
    engaged = true;
    lastBanner = `REPLAY  ${record.scenarioId} · ${record.agentMode}${record.model ? ' · ' + record.model : ''} · ${record.durationSimTime.toFixed(2)}s`;
    updateUi();
  }

  function stopReplay() {
    setLlmMode();
  }

  function updateUi() {
    if (mode === 'replay') {
      modeBadge.hidden = false;
      modeBadge.className = 'mode-replay';
      modeBadge.textContent = 'REPLAY';
    } else if (llmAgent) {
      modeBadge.hidden = false;
      modeBadge.className = 'mode-llm';
      modeBadge.innerHTML = `<span class="live-dot"></span>AI LIVE`;
    } else {
      modeBadge.hidden = true;
    }

    const isReplay = mode === 'replay';
    startBtn.hidden = isReplay || engaged || !llmAgent;
    stopBtn.hidden = isReplay || !engaged;
    stopReplayBtn.hidden = !isReplay;
    replayLastBtn.hidden = isReplay || engaged || !lastShareableRun;
    shareBtn.hidden = isReplay || engaged || !lastShareableRun;
    if (lastShareableRun) {
      shareBtn.textContent = 'Copy Last Run';
      shareBtn.disabled = false;
    }

    aiSection.hidden = !llmAgent;
    runSection.hidden = !llmAgent && !isReplay && !lastShareableRun;

    modeRoundBtn.classList.toggle('selected', pilotMode === 'round');
    modeLiveBtn.classList.toggle('selected', pilotMode === 'live');
    modeRoundBtn.disabled = engaged || isReplay;
    modeLiveBtn.disabled = engaged || isReplay;
  }

  async function populateModels(s: ByokySession) {
    modelPicker.innerHTML = '<option>Loading models…</option>';
    modelPicker.disabled = true;
    const available = getProviderIds().filter(
      (id) => SUPPORTED_PROVIDERS.has(id) && s.providers[id]?.available === true
    );

    type Entry = { providerId: string; providerName: string; modelId: string; displayName: string };
    const entries: Entry[] = [];
    await Promise.all(
      available.map(async (pid) => {
        try {
          const list = await s.listModels(pid);
          const name = getProvider(pid)?.name ?? pid;
          for (const m of list) {
            entries.push({
              providerId: pid,
              providerName: name,
              modelId: m.id,
              displayName: m.displayName || m.id,
            });
          }
        } catch (err) {
          console.warn(`listModels(${pid}) failed:`, err);
        }
      })
    );

    modelPicker.innerHTML = '';
    if (!entries.length) {
      const opt = document.createElement('option');
      opt.textContent = 'No keys available — add one in your byoky wallet';
      opt.disabled = true;
      opt.selected = true;
      modelPicker.appendChild(opt);
      modelPicker.disabled = true;
      return;
    }

    const byProvider = new Map<string, Entry[]>();
    for (const e of entries) {
      if (!byProvider.has(e.providerId)) byProvider.set(e.providerId, []);
      byProvider.get(e.providerId)!.push(e);
    }
    for (const [pid, list] of byProvider) {
      const group = document.createElement('optgroup');
      group.label = list[0].providerName;
      for (const e of list) {
        const opt = document.createElement('option');
        opt.value = `${pid}:${e.modelId}`;
        opt.textContent = e.displayName;
        group.appendChild(opt);
      }
      modelPicker.appendChild(group);
    }

    const allKeys = entries.map((e) => `${e.providerId}:${e.modelId}`);
    if (!allKeys.includes(selectedModel)) {
      selectedModel = allKeys[0];
      localStorage.setItem(MODEL_KEY, selectedModel);
    }
    modelPicker.value = selectedModel;
    modelPicker.disabled = false;

    const { providerId, modelId } = parseModelKey(selectedModel);
    llmAgent = createLlmAgent({ session: s, providerId, modelId });
    statusEl.textContent = `${modelId} via ${getProvider(providerId)?.name ?? providerId}`;
    if (mode === 'llm') sim.setAgent(llmAgent);
  }

  function showConnected(s: ByokySession) {
    session = s;
    const { providerId, modelId } = parseModelKey(selectedModel);
    llmAgent = createLlmAgent({ session: s, providerId, modelId });
    connectBtn.hidden = true;
    statusEl.textContent = `${modelId} via ${getProvider(providerId)?.name ?? providerId}`;
    setLlmMode();
    populateModels(s);

    s.onDisconnect(() => {
      session = null;
      llmAgent = null;
      engaged = false;
      connectBtn.hidden = false;
      sim.setAgent(hoverAgent);
      resetRun();
      updateUi();
    });
  }

  byoky.tryReconnect().then((s) => {
    if (s) showConnected(s);
  });

  const connectBtnLabel = connectBtn.innerHTML;
  connectBtn.addEventListener('click', async () => {
    connectBtn.disabled = true;
    connectBtn.textContent = 'Connecting…';
    try {
      const s = await byoky.connect({
        providers: [...SUPPORTED_PROVIDERS].map((id) => ({ id, required: false })),
        modal: true,
      });
      showConnected(s);
    } catch (err) {
      console.error('byoky connect failed:', err);
      connectBtn.innerHTML = connectBtnLabel;
    } finally {
      connectBtn.disabled = false;
    }
  });

  startBtn.addEventListener('click', startRun);
  stopBtn.addEventListener('click', stopRun);
  modeRoundBtn.addEventListener('click', () => setPilotMode('round'));
  modeLiveBtn.addEventListener('click', () => setPilotMode('live'));

  replayLastBtn.addEventListener('click', () => {
    if (lastShareableRun) startReplay(lastShareableRun);
  });

  stopReplayBtn.addEventListener('click', stopReplay);

  shareBtn.addEventListener('click', async () => {
    if (!lastShareableRun) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(lastShareableRun));
      shareBtn.textContent = 'Copied';
      shareBtn.disabled = true;
      setTimeout(() => updateUi(), 1200);
    } catch (err) {
      console.error('Clipboard write failed:', err);
      shareBtn.textContent = 'Copy failed';
      setTimeout(() => updateUi(), 1200);
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'r') {
      if (mode === 'replay') return;
      resetRun();
      updateUi();
    }
  });

  updateUi();

  // --- main loop ---
  const hud = document.getElementById('hud')!;
  const fixedDtMs = PHYSICS_TIMESTEP * 1000;
  let acc = 0;
  let last = performance.now();
  let stepping = false;

  async function loop(now: number) {
    requestAnimationFrame(loop);
    const dt = Math.min(now - last, 100);
    last = now;
    acc = Math.min(acc + dt, fixedDtMs);

    if (engaged && prevStatus === 'running') {
      if (pilotMode === 'round') {
        if (!stepping) {
          stepping = true;
          while (acc >= fixedDtMs) {
            await sim.stepRound();
            acc -= fixedDtMs;
          }
          stepping = false;
        }
      } else {
        while (acc >= fixedDtMs) {
          sim.stepLive();
          acc -= fixedDtMs;
        }
      }
    } else {
      acc = 0;
    }

    const obs = sim.getObservation();
    const sc = scenario.update(obs, PHYSICS_TIMESTEP);

    if (prevStatus === 'running' && sc.status !== 'running') {
      onRunComplete(sc);
    }
    prevStatus = sc.status;

    refs.drone.position.set(obs.position.x, obs.position.y, obs.position.z);
    refs.drone.quaternion.set(
      obs.orientation.x,
      obs.orientation.y,
      obs.orientation.z,
      obs.orientation.w
    );

    const propStep = (dt / 1000) * 80;
    for (const p of refs.propellers) {
      p.rotateY(p.userData.spin * propStep);
    }

    updateGates(gates, sc.currentGate, sc.status === 'running');

    refs.controls.target.set(obs.position.x, obs.position.y, obs.position.z);
    refs.controls.update();

    hud.textContent = renderHud(obs, sim.getAction(), sc, mode, pilotMode, {
      personalBest,
      runCount,
      lastBanner,
      recentDecisions,
      thinking: sim.isDeciding(),
    });

    refs.renderer.render(refs.scene, refs.camera);
  }

  requestAnimationFrame(loop);
}

function countRunsFor(scenarioId: string, pilotMode: PilotMode): number {
  return loadRuns().filter((r) => r.scenarioId === scenarioId && (r.pilotMode ?? 'round') === pilotMode).length;
}

function parseModelKey(key: string): { providerId: string; modelId: string } {
  const i = key.indexOf(':');
  if (i < 0) return { providerId: 'anthropic', modelId: key };
  return { providerId: key.slice(0, i), modelId: key.slice(i + 1) };
}

type HudExtras = {
  personalBest: number | null;
  runCount: number;
  lastBanner: string | null;
  recentDecisions: ActionLogEntry[];
  thinking: boolean;
};

function renderHud(
  obs: Observation,
  action: Action,
  sc: ScenarioState,
  mode: Mode,
  pilotMode: PilotMode,
  extras: HudExtras
): string {
  const f = (n: number) => n.toFixed(2).padStart(7);
  const actStr = formatAction(action);

  const lines: string[] = [];
  if (sc.status !== 'running' && extras.lastBanner) {
    lines.push(extras.lastBanner);
    lines.push('');
  }
  lines.push(
    `time ${sc.elapsedSimTime.toFixed(2)}s   target ${sc.currentGate}/${sc.totalGates}   d ${sc.distanceToGate.toFixed(2)}m`
  );
  const pbStr = extras.personalBest !== null ? `${extras.personalBest.toFixed(2)}s` : '—';
  lines.push(`best ${pbStr}   runs ${extras.runCount}   mode ${pilotMode === 'live' ? 'LIVE' : 'ROUND'}${extras.thinking ? ' · thinking…' : ''}`);
  lines.push('');
  lines.push(`pos  ${f(obs.position.x)} ${f(obs.position.y)} ${f(obs.position.z)}`);
  lines.push(`vel  ${f(obs.velocity.x)} ${f(obs.velocity.y)} ${f(obs.velocity.z)}`);
  lines.push(`act  ${actStr}`);

  if (extras.recentDecisions.length) {
    lines.push('');
    lines.push('recent decisions:');
    for (const d of extras.recentDecisions.slice().reverse()) {
      lines.push(`  ${String(d.tick).padStart(5)}  ${formatAction(d.action)}`);
    }
  }

  lines.push('');
  if (mode === 'replay') {
    lines.push('Replaying — drag to orbit, scroll to zoom');
  } else {
    lines.push('AI piloting · R reset · drag to orbit · scroll to zoom');
  }
  return lines.join('\n');
}

function formatAction(action: Action): string {
  const f = (n: number) => n.toFixed(2).padStart(7);
  switch (action.type) {
    case 'velocity':
      return `velocity ${f(action.v.x)} ${f(action.v.y)} ${f(action.v.z)}`;
    case 'goto':
      return `goto     ${f(action.target.x)} ${f(action.target.y)} ${f(action.target.z)}`;
    case 'hover':
      return 'hover';
    case 'land':
      return 'land';
  }
}

main().catch((err) => {
  console.error(err);
  const hud = document.getElementById('hud');
  if (hud) hud.textContent = 'failed to start: ' + (err?.message ?? err);
});
