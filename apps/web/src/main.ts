import { Byoky, type ByokySession } from '@byoky/sdk';
import { buildGates, createScene, disposeGates, updateGates, type GateRefs } from './scene';
import { createSim } from './sim';
import { createKeyboardAgent } from './agents/keyboard';
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
const KEYBOARD_PHASE = 0.05;
const LLM_PHASE = 0.5;
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MODEL_KEY = 'strongdrone:model';
const RECENT_DECISIONS_MAX = 6;

type Mode = 'keyboard' | 'llm' | 'replay';

const ONBOARDING_KEY = 'strongdrone:onboarding-seen';

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

  const keyboardAgent = createKeyboardAgent();
  let llmAgent: Agent | null = null;
  let session: ByokySession | null = null;
  let mode: Mode = 'keyboard';
  let preReplayMode: 'keyboard' | 'llm' = 'keyboard';
  let selectedModel = localStorage.getItem(MODEL_KEY) || DEFAULT_MODEL;

  const sim = createSim(
    keyboardAgent,
    () => ({ scenarioState: scenario.getState(), gates: scenario.getGatePositions() }),
    { actionPhaseDuration: KEYBOARD_PHASE, physicsTimestep: PHYSICS_TIMESTEP }
  );

  // --- recording ---
  let actionLog: ActionLogEntry[] = [];
  let recentDecisions: ActionLogEntry[] = [];
  let runStartedAt = Date.now();
  let prevStatus: ScenarioStatus = 'running';
  let lastBanner: string | null = null;
  let personalBest: number | null = getPersonalBest(scenario.getDefinition().id);
  let runCount = countRunsFor(scenario.getDefinition().id);
  let lastShareableRun: RunRecord | null = null;

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
  }

  function switchScenario(id: string) {
    disposeGates(refs.scene, gates);
    scenario = createWaypointScenario(getScenarioById(id));
    gates = buildGates(refs.scene, scenario.getGatePositions());
    personalBest = getPersonalBest(id);
    runCount = countRunsFor(id);
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
    const phase = mode === 'llm' ? LLM_PHASE : KEYBOARD_PHASE;
    const run: RunRecord = {
      version: 2,
      scenarioId,
      seed: 0,
      actionLog: [...actionLog],
      actionPhaseDuration: phase,
      physicsTimestep: PHYSICS_TIMESTEP,
      status: sc.status,
      score: sc.score,
      durationSimTime: sc.elapsedSimTime,
      startedAt: runStartedAt,
      agentMode: mode,
      model: mode === 'llm' ? selectedModel : undefined,
    };
    saveRun(run);
    runCount += 1;
    lastShareableRun = run;

    if (sc.status === 'success' && sc.score !== null) {
      const { isNewBest, previousBest } = maybeUpdatePB(scenarioId, sc.score);
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
  const toggleBtn = document.getElementById('toggle-pilot') as HTMLButtonElement;
  const shareBtn = document.getElementById('share-btn') as HTMLButtonElement;
  const picker = document.getElementById('scenario-picker') as HTMLSelectElement;
  const modelPicker = document.getElementById('model-picker') as HTMLSelectElement;
  const modeBadge = document.getElementById('mode-badge') as HTMLDivElement;
  const replayLastBtn = document.getElementById('replay-last') as HTMLButtonElement;
  const stopReplayBtn = document.getElementById('stop-replay') as HTMLButtonElement;
  const pilotSection = document.getElementById('pilot-section') as HTMLDivElement;
  const runSection = document.getElementById('run-section') as HTMLDivElement;
  const aiSection = document.getElementById('ai-section') as HTMLDivElement;
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
      llmAgent = createLlmAgent({ session, model: selectedModel });
      statusEl.textContent = `${selectedModel} via byoky`;
      if (mode === 'llm') sim.setAgent(llmAgent);
    }
  });

  function setMode(next: Mode) {
    if (next === 'llm' && llmAgent) {
      mode = 'llm';
      sim.setAgent(llmAgent);
      sim.setActionPhaseDuration(LLM_PHASE);
    } else {
      mode = 'keyboard';
      sim.setAgent(keyboardAgent);
      sim.setActionPhaseDuration(KEYBOARD_PHASE);
    }
    resetRun();
    updateUi();
  }

  function startReplay(record: RunRecord) {
    if (mode !== 'replay') preReplayMode = mode === 'llm' ? 'llm' : 'keyboard';
    if (record.scenarioId !== scenario.getDefinition().id) {
      switchScenario(record.scenarioId);
    } else {
      resetRun();
      lastShareableRun = null;
    }
    sim.setAgent(createReplayAgent(record.actionLog));
    sim.setActionPhaseDuration(record.actionPhaseDuration ?? LLM_PHASE);
    mode = 'replay';
    lastBanner = `REPLAY  ${record.scenarioId} · ${record.agentMode}${record.model ? ' · ' + record.model : ''} · ${record.durationSimTime.toFixed(2)}s`;
    updateUi();
  }

  function stopReplay() {
    setMode(preReplayMode);
  }

  function updateUi() {
    if (mode === 'llm') {
      modeBadge.className = 'mode-llm';
      modeBadge.innerHTML = `<span class="live-dot"></span>AI LIVE`;
    } else if (mode === 'replay') {
      modeBadge.className = 'mode-replay';
      modeBadge.textContent = 'REPLAY';
    } else {
      modeBadge.className = 'mode-keyboard';
      modeBadge.textContent = 'KEYBOARD';
    }

    toggleBtn.textContent = mode === 'llm' ? 'Pilot: AI' : 'Pilot: Keyboard';
    toggleBtn.classList.toggle('pilot-on', mode === 'llm');
    toggleBtn.hidden = mode === 'replay' || !llmAgent;

    stopReplayBtn.hidden = mode !== 'replay';
    replayLastBtn.hidden = mode === 'replay' || !lastShareableRun;
    shareBtn.hidden = mode === 'replay' || !lastShareableRun;
    if (lastShareableRun) {
      shareBtn.textContent = 'Copy Last Run';
      shareBtn.disabled = false;
    }

    aiSection.hidden = !llmAgent;
    pilotSection.hidden = !!toggleBtn.hidden;
    runSection.hidden = replayLastBtn.hidden && stopReplayBtn.hidden && shareBtn.hidden;
  }

  async function populateModels(s: ByokySession) {
    modelPicker.innerHTML = '<option>Loading models…</option>';
    modelPicker.disabled = true;
    try {
      const models = await s.listModels('anthropic');
      modelPicker.innerHTML = '';
      if (!models.length) throw new Error('empty model list');
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.displayName || m.id;
        modelPicker.appendChild(opt);
      }
      if (!models.some((m) => m.id === selectedModel)) {
        selectedModel = models[0].id;
        localStorage.setItem(MODEL_KEY, selectedModel);
        llmAgent = createLlmAgent({ session: s, model: selectedModel });
        if (mode === 'llm') sim.setAgent(llmAgent);
      }
      modelPicker.value = selectedModel;
      statusEl.textContent = `${selectedModel} via byoky`;
    } catch (err) {
      console.error('listModels failed:', err);
      modelPicker.innerHTML = '';
      const opt = document.createElement('option');
      opt.value = selectedModel;
      opt.textContent = selectedModel;
      modelPicker.appendChild(opt);
      modelPicker.value = selectedModel;
    } finally {
      modelPicker.disabled = false;
    }
  }

  function showConnected(s: ByokySession) {
    session = s;
    llmAgent = createLlmAgent({ session: s, model: selectedModel });
    connectBtn.hidden = true;
    statusEl.textContent = `${selectedModel} via byoky`;
    setMode('llm');
    populateModels(s);

    s.onDisconnect(() => {
      session = null;
      llmAgent = null;
      connectBtn.hidden = false;
      setMode('keyboard');
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
        providers: [{ id: 'anthropic', required: true }],
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

  toggleBtn.addEventListener('click', () => setMode(mode === 'llm' ? 'keyboard' : 'llm'));

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

    if (prevStatus === 'running' && !stepping) {
      stepping = true;
      while (acc >= fixedDtMs) {
        await sim.step();
        acc -= fixedDtMs;
      }
      stepping = false;
    } else if (prevStatus !== 'running') {
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

    updateGates(gates, sc.currentGate, sc.status === 'running');

    refs.controls.target.set(obs.position.x, obs.position.y, obs.position.z);
    refs.controls.update();

    hud.textContent = renderHud(obs, sim.getAction(), sc, mode, {
      personalBest,
      runCount,
      lastBanner,
      recentDecisions,
    });

    refs.renderer.render(refs.scene, refs.camera);
  }

  requestAnimationFrame(loop);
}

function countRunsFor(scenarioId: string): number {
  return loadRuns().filter((r) => r.scenarioId === scenarioId).length;
}

type HudExtras = {
  personalBest: number | null;
  runCount: number;
  lastBanner: string | null;
  recentDecisions: ActionLogEntry[];
};

function renderHud(
  obs: Observation,
  action: Action,
  sc: ScenarioState,
  mode: Mode,
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
    `time ${sc.elapsedSimTime.toFixed(2)}s   gate ${sc.currentGate}/${sc.totalGates}   d ${sc.distanceToGate.toFixed(2)}m`
  );
  const pbStr = extras.personalBest !== null ? `${extras.personalBest.toFixed(2)}s` : '—';
  lines.push(`best ${pbStr}   runs ${extras.runCount}`);
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
  } else if (mode === 'llm') {
    lines.push('AI piloting · R reset · drag to orbit · scroll to zoom');
  } else {
    lines.push('WASD/arrows  space/shift up/down  R reset');
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
