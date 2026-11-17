/**
 * 测试台主控制器：装配五个页面（对局 / 网络条件 / 回滚监视 / 同步检查 / 参数调优），
 * 驱动 Session 的实时循环、键盘输入与 5 分钟极限压测。
 */

import { ArenaRenderer } from './arena';
import { LineChart } from './chart';
import {
  DEFAULT_NETWORK,
  DEFAULT_ROLLBACK,
  FRAME_MS,
  Session,
  STRESS_NETWORK,
} from '../engine/session';
import { runStress, type StressResult } from '../engine/stress';
import type { FaultFlags } from '../core/faults';
import { INPUT_BITS, type Input, type NetworkConfig, type PlayerId } from '../core/types';

interface BindableSlider {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  get: () => number;
  set: (v: number) => void;
  format: (v: number) => string;
}

export class App {
  private session: Session;
  private lastWall = 0;
  private accMs = 0;

  private arena0!: ArenaRenderer;
  private arena1!: ArenaRenderer;
  private chartRb!: LineChart;
  private chartMs!: LineChart;
  private chartPred!: LineChart;

  private held: [Input, Input] = [{ bits: 0 }, { bits: 0 }];
  private keyDown = new Set<string>();

  private stressRunning = false;

  constructor(private root: HTMLElement) {
    this.session = new Session({
      network: { ...DEFAULT_NETWORK },
      rollback: { ...DEFAULT_ROLLBACK },
      useAI: true,
    });
    this.render();
    this.bindLoop();
    this.bindKeyboard();
  }

  // ------------------------------------------------------------------ //
  //  页面骨架
  // ------------------------------------------------------------------ //

  private render(): void {
    this.root.innerHTML = `
      <header class="topbar">
        <h1>回滚网络同步测试台</h1>
        <span class="sub">单页双客户端 · 整数网格(1px=1000单位) · GGPO 风格回滚</span>
        <span class="spacer"></span>
        <span id="syncPill" class="status-pill idle"><span class="led"></span><span class="txt">未运行</span></span>
        <button id="btnRun" class="primary">暂停</button>
        <button id="btnReset">重置</button>
      </header>
      <div class="grid">
        ${this.matchCard()}
        ${this.networkCard()}
        ${this.monitorCard()}
        ${this.syncCard()}
        ${this.tuningCard()}
      </div>
    `;

    this.arena0 = new ArenaRenderer(document.getElementById('arena0') as HTMLCanvasElement);
    this.arena1 = new ArenaRenderer(document.getElementById('arena1') as HTMLCanvasElement);
    this.chartRb = new LineChart(document.getElementById('chartRb') as HTMLCanvasElement);
    this.chartMs = new LineChart(document.getElementById('chartMs') as HTMLCanvasElement);
    this.chartPred = new LineChart(document.getElementById('chartPred') as HTMLCanvasElement);

    this.buildSliders();
    this.bindButtons();
    this.bindFaults();
    this.bindMode();
  }

  private matchCard(): string {
    return `
      <section class="card col-8">
        <h2><span class="dot"></span>对局（两个客户端的渲染视图）</h2>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div class="arena-wrap">
            <span class="tag p0">客户端 A · 玩家0</span>
            <canvas id="arena0" style="height:230px;"></canvas>
          </div>
          <div class="arena-wrap">
            <span class="tag p1">客户端 B · 玩家1</span>
            <canvas id="arena1" style="height:230px;"></canvas>
          </div>
        </div>
        <div class="keys" style="margin-top:12px;">
          <div class="keymap p0">
            <b>玩家0</b><br>
            <kbd>A</kbd>/<kbd>D</kbd> 移动 · <kbd>W</kbd> 跳 · <kbd>F</kbd> 攻击
          </div>
          <div class="keymap p1">
            <b>玩家1</b><br>
            <kbd>←</kbd>/<kbd>→</kbd> 移动 · <kbd>↑</kbd> 跳 · <kbd>/</kbd> 攻击
          </div>
        </div>
        <div class="check-row" style="margin-top:10px;">
          <input type="checkbox" id="useAI" checked>
          <label for="useAI">内置 AI 自动对战（关闭后用键盘手动操作，用于压测请保持开启）</label>
        </div>
      </section>`;
  }

  private networkCard(): string {
    return `
      <section class="card col-4">
        <h2><span class="dot"></span>网络条件</h2>
        <div id="netSliders"></div>
        <div class="presets" style="margin-top:6px;">
          <button data-net="lan">局域网</button>
          <button data-net="good">良好宽带</button>
          <button data-net="mobile">移动网络</button>
          <button data-net="stress">200ms+50%丢包</button>
        </div>
        <div class="hint-text" id="netStats"></div>
      </section>`;
  }

  private monitorCard(): string {
    return `
      <section class="card col-7">
        <h2><span class="dot"></span>回滚监视</h2>
        <div class="metric-row">
          <div class="metric"><div class="k">累计回滚次数</div><div class="v" id="mRollbacks">0</div></div>
          <div class="metric"><div class="k">重算总帧数</div><div class="v" id="mResim">0</div></div>
          <div class="metric"><div class="k">最大重算耗时</div><div class="v" id="mMaxMs">0ms</div></div>
          <div class="metric"><div class="k">卡顿帧</div><div class="v" id="mStall">0</div></div>
        </div>
        <div style="margin-bottom:4px;color:var(--muted);font-size:11.5px;">每帧回滚帧数</div>
        <canvas id="chartRb" style="height:120px;"></canvas>
        <div style="margin:8px 0 4px;color:var(--muted);font-size:11.5px;">每帧重算耗时 (ms)</div>
        <canvas id="chartMs" style="height:110px;"></canvas>
        <div style="margin:8px 0 4px;color:var(--muted);font-size:11.5px;">预测深度（未确认帧数）</div>
        <canvas id="chartPred" style="height:110px;"></canvas>
      </section>`;
  }

  private syncCard(): string {
    return `
      <section class="card col-5">
        <h2><span class="dot"></span>同步检查</h2>
        <div class="metric-row">
          <div class="metric"><div class="k">分歧总数</div><div class="v good" id="mDiv">0</div></div>
          <div class="metric"><div class="k">共同确认帧</div><div class="v" id="mConfirmed">0</div></div>
        </div>
        <div style="margin-bottom:6px;color:var(--muted);font-size:11.5px;">故障注入（仅作用于客户端 A，用于验证定位能力）</div>
        <div class="check-row"><input type="checkbox" id="faultPhysics"><label>物理故障</label><span class="hint">每37帧 vx+1</span></div>
        <div class="check-row"><input type="checkbox" id="faultRng"><label>随机数故障</label><span class="hint">每53帧多走一次RNG</span></div>
        <div class="check-row"><input type="checkbox" id="faultInput"><label>输入处理故障</label><span class="hint">每41帧翻转输入位</span></div>
        <div style="margin:10px 0 4px;color:var(--muted);font-size:11.5px;">分歧定位日志（最先写错的变量）</div>
        <div class="log" id="divLog"><div class="empty">暂无分歧 — 两端状态逐位一致</div></div>
      </section>`;
  }

  private tuningCard(): string {
    return `
      <section class="card col-12">
        <h2><span class="dot"></span>参数调优 · 5 分钟极限验收</h2>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:18px;">
          <div id="tuneSliders"></div>
          <div>
            <div class="hint-text" style="margin-bottom:8px;">
              输入延迟越大，回滚越少但手感越“肉”；插值帧数越大，画面越平滑但有轻微拖影。
              拖动滑块观察左侧回滚次数与卡顿帧的变化。
            </div>
            <div class="presets">
              <button id="btnStress" class="primary">运行 5 分钟极限压测（18000帧）</button>
            </div>
            <div class="progress"><div id="stressBar"></div></div>
            <div class="stress-result" id="stressResult" style="display:none;"></div>
          </div>
        </div>
      </section>`;
  }

  // ------------------------------------------------------------------ //
  //  滑块
  // ------------------------------------------------------------------ //

  private buildSliders(): void {
    // 所有 get/set 都动态走 this.session，保证“重置”产生新 Session 后
    // 滑块仍然作用在当前会话上，而不是闭包里捕获的旧配置对象
    const netSliders: BindableSlider[] = [
      { key: 'lat', label: '单向延迟', min: 0, max: 400, step: 5, get: () => this.session.config.network.latencyMs, set: v => { this.session.config.network.latencyMs = v; }, format: v => `${v} ms` },
      { key: 'jit', label: '抖动幅度', min: 0, max: 100, step: 1, get: () => this.session.config.network.jitterMs, set: v => { this.session.config.network.jitterMs = v; }, format: v => `±${v} ms` },
      { key: 'loss', label: '丢包率', min: 0, max: 0.9, step: 0.01, get: () => this.session.config.network.lossRate, set: v => { this.session.config.network.lossRate = v; }, format: v => `${Math.round(v * 100)} %` },
      { key: 'reo', label: '乱序率', min: 0, max: 0.5, step: 0.01, get: () => this.session.config.network.reorderRate, set: v => { this.session.config.network.reorderRate = v; }, format: v => `${Math.round(v * 100)} %` },
    ];
    const tuneSliders: BindableSlider[] = [
      { key: 'delay', label: '输入延迟帧数', min: 0, max: 12, step: 1, get: () => this.session.config.rollback.inputDelayFrames, set: v => { this.session.config.rollback.inputDelayFrames = v; }, format: v => `${v} 帧 (${(v * FRAME_MS).toFixed(0)}ms)` },
      { key: 'interp', label: '插值抹平帧数', min: 0, max: 12, step: 1, get: () => this.session.config.rollback.interpolationFrames, set: v => { this.session.config.rollback.interpolationFrames = v; }, format: v => `${v} 帧` },
      { key: 'maxpred', label: '最大预测窗口', min: 1, max: 90, step: 1, get: () => this.session.config.rollback.maxPredictedFrames, set: v => { this.session.config.rollback.maxPredictedFrames = v; }, format: v => `${v} 帧` },
    ];
    this.mountSliders('netSliders', netSliders);
    this.mountSliders('tuneSliders', tuneSliders);
  }

  private mountSliders(containerId: string, sliders: BindableSlider[]): void {
    const el = document.getElementById(containerId)!;
    el.innerHTML = sliders.map(s => `
      <div class="control">
        <div class="label-row"><label>${s.label}</label><span class="val" id="val-${s.key}">${s.format(s.get())}</span></div>
        <input type="range" id="sld-${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" value="${s.get()}">
      </div>`).join('');
    for (const s of sliders) {
      const input = document.getElementById(`sld-${s.key}`) as HTMLInputElement;
      input.addEventListener('input', () => {
        s.set(parseFloat(input.value));
        document.getElementById(`val-${s.key}`)!.textContent = s.format(s.get());
      });
    }
  }

  private refreshSliders(): void {
    document.querySelectorAll<HTMLInputElement>('input[type=range]').forEach(inp => {
      const key = inp.id.replace('sld-', '');
      const map: Record<string, number> = {
        lat: this.session.config.network.latencyMs,
        jit: this.session.config.network.jitterMs,
        loss: this.session.config.network.lossRate,
        reo: this.session.config.network.reorderRate,
        delay: this.session.config.rollback.inputDelayFrames,
        interp: this.session.config.rollback.interpolationFrames,
        maxpred: this.session.config.rollback.maxPredictedFrames,
      };
      if (key in map) inp.value = String(map[key]);
    });
  }

  // ------------------------------------------------------------------ //
  //  按钮 / 预设 / 故障 / 模式
  // ------------------------------------------------------------------ //

  private bindButtons(): void {
    document.getElementById('btnRun')!.addEventListener('click', () => {
      this.session.running = !this.session.running;
      (document.getElementById('btnRun') as HTMLButtonElement).textContent =
        this.session.running ? '暂停' : '运行';
    });
    document.getElementById('btnReset')!.addEventListener('click', () => this.resetSession());

    const presets: Record<string, NetworkConfig> = {
      lan: { latencyMs: 5, jitterMs: 2, lossRate: 0, reorderRate: 0 },
      good: { latencyMs: 30, jitterMs: 10, lossRate: 0.01, reorderRate: 0.02 },
      mobile: { latencyMs: 90, jitterMs: 35, lossRate: 0.08, reorderRate: 0.1 },
      stress: { ...STRESS_NETWORK },
    };
    document.querySelectorAll<HTMLButtonElement>('[data-net]').forEach(btn => {
      btn.addEventListener('click', () => {
        Object.assign(this.session.config.network, presets[btn.dataset.net!]);
        this.refreshSliders();
        this.updateNetStats();
      });
    });

    document.getElementById('btnStress')!.addEventListener('click', () => this.runStressTest());
  }

  private bindFaults(): void {
    // 动态引用当前 session 的故障标志（重置后仍生效）
    const bind = (id: string, key: keyof FaultFlags): void => {
      (document.getElementById(id) as HTMLInputElement).addEventListener('change', e => {
        this.session.endpoints[0].faults[key] = (e.target as HTMLInputElement).checked;
      });
    };
    bind('faultPhysics', 'physics');
    bind('faultRng', 'rng');
    bind('faultInput', 'input');
  }

  private bindMode(): void {
    (document.getElementById('useAI') as HTMLInputElement).addEventListener('change', e => {
      this.session.config.useAI = (e.target as HTMLInputElement).checked;
    });
  }

  private resetSession(): void {
    const faults: [FaultFlags, FaultFlags] = [
      { ...this.session.endpoints[0].faults },
      { ...this.session.endpoints[1].faults },
    ];
    const cfg = {
      network: { ...this.session.config.network },
      rollback: { ...this.session.config.rollback },
      useAI: this.session.config.useAI,
    };
    this.session = new Session(cfg, faults);
    this.session.running = true;
    this.accMs = 0;
    this.held = [{ bits: 0 }, { bits: 0 }];
    (document.getElementById('btnRun') as HTMLButtonElement).textContent = '暂停';
  }

  // ------------------------------------------------------------------ //
  //  键盘输入（手动模式）
  // ------------------------------------------------------------------ //

  private bindKeyboard(): void {
    const map: Record<string, [PlayerId, number]> = {
      KeyA: [0, INPUT_BITS.LEFT],
      KeyD: [0, INPUT_BITS.RIGHT],
      KeyW: [0, INPUT_BITS.JUMP],
      KeyF: [0, INPUT_BITS.ATTACK],
      ArrowLeft: [1, INPUT_BITS.LEFT],
      ArrowRight: [1, INPUT_BITS.RIGHT],
      ArrowUp: [1, INPUT_BITS.JUMP],
      Slash: [1, INPUT_BITS.ATTACK],
    };
    window.addEventListener('keydown', e => {
      const m = map[e.code];
      if (!m) return;
      e.preventDefault();
      this.keyDown.add(e.code);
      this.held[m[0]].bits |= m[1];
      this.session.setIntent(m[0], this.held[m[0]]);
    });
    window.addEventListener('keyup', e => {
      const m = map[e.code];
      if (!m) return;
      e.preventDefault();
      this.keyDown.delete(e.code);
      this.held[m[0]].bits &= ~m[1];
      this.session.setIntent(m[0], this.held[m[0]]);
    });
  }

  // ------------------------------------------------------------------ //
  //  主循环：固定步长推进 + 每帧渲染
  // ------------------------------------------------------------------ //

  private bindLoop(): void {
    this.session.running = true;
    const tick = (wall: number): void => {
      if (!this.lastWall) this.lastWall = wall;
      const dt = Math.min(100, wall - this.lastWall);
      this.lastWall = wall;

      if (this.session.running && !this.stressRunning) {
        this.accMs += dt;
        let guard = 5;
        while (this.accMs >= FRAME_MS && guard-- > 0) {
          this.session.stepFrame();
          this.accMs -= FRAME_MS;
        }
      }
      this.paint();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private paint(): void {
    this.arena0.draw(this.session.views[0].state, '客户端 A', null);
    this.arena1.draw(this.session.views[1].state, '客户端 B', null);

    const stats = this.session.stats;
    this.chartRb.draw([{ label: '回滚帧数', color: '#f85149', points: stats.map(s => s.framesResimulated) }]);
    this.chartMs.draw([{ label: '重算ms', color: '#d29922', points: stats.map(s => s.resimMs) }]);
    this.chartPred.draw([
      { label: 'A 预测深度', color: '#58a6ff', points: this.session.depthHistory[0] },
      { label: 'B 预测深度', color: '#f778ba', points: this.session.depthHistory[1] },
    ], this.session.config.rollback.maxPredictedFrames);

    const t = this.session.totals;
    this.setText('mRollbacks', String(t.rollbacks));
    this.setText('mResim', String(t.resimulated));
    this.setText('mMaxMs', `${t.maxResimMs.toFixed(2)}`);
    this.setText('mStall', String(t.stallFrames));
    this.setText('mDiv', String(this.session.totalDivergences));
    this.setText('mConfirmed', String(
      Math.min(this.session.endpoints[0].confirmedFrame, this.session.endpoints[1].confirmedFrame),
    ));
    this.updatePill();
    this.updateDivLog();
    this.updateNetStats();
  }

  private setText(id: string, text: string): void {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  private updatePill(): void {
    const pill = document.getElementById('syncPill')!;
    const txt = pill.querySelector('.txt')!;
    if (!this.session.running) {
      pill.className = 'status-pill idle';
      txt.textContent = '已暂停';
    } else if (this.session.totalDivergences === 0) {
      pill.className = 'status-pill ok';
      txt.textContent = `同步中 · 帧 ${this.session.frame}`;
    } else {
      pill.className = 'status-pill fail';
      txt.textContent = `分歧 ×${this.session.totalDivergences}`;
    }
  }

  private updateDivLog(): void {
    const el = document.getElementById('divLog')!;
    const log = this.session.divergenceLog;
    if (log.length === 0) {
      el.innerHTML = '<div class="empty">暂无分歧 — 两端状态逐位一致</div>';
      return;
    }
    el.innerHTML = log.slice(-12).reverse().map(d => `
      <div class="entry">
        <span class="frame-tag">帧 ${d.frame}</span>
        <span class="cat ${d.category}">[${this.categoryName(d.category)}]</span>
        <span class="path">${d.firstMismatchPath}</span>
        <div style="color:var(--muted);margin-top:2px;">${d.detail}</div>
      </div>`).join('');
  }

  private categoryName(c: string): string {
    return c === 'physics' ? '物理' : c === 'rng' ? '随机数' : c === 'input' ? '输入处理' : '未知';
  }

  private updateNetStats(): void {
    const el = document.getElementById('netStats');
    if (!el) return;
    const s0 = this.session.link.stats[0];
    const s1 = this.session.link.stats[1];
    const avg = (arr: number[]): string => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(0) : '—';
    el.textContent = `A→B 发送${s0.sent}/投递${s0.delivered}/丢${s0.lost}，实测延迟${avg(s0.latencySamples)}ms · B→A 发送${s1.sent}/丢${s1.lost}，延迟${avg(s1.latencySamples)}ms`;
  }

  // ------------------------------------------------------------------ //
  //  5 分钟极限压测
  // ------------------------------------------------------------------ //

  private async runStressTest(): Promise<void> {
    if (this.stressRunning) return;
    this.stressRunning = true;
    const btn = document.getElementById('btnStress') as HTMLButtonElement;
    const bar = document.getElementById('stressBar') as HTMLElement;
    const out = document.getElementById('stressResult') as HTMLElement;
    btn.disabled = true;
    btn.textContent = '压测中…';
    out.style.display = 'block';
    out.textContent = '运行中：200ms 单向延迟 + 50% 丢包，18000 帧（5 分钟）…';

    const FRAMES = 18000;
    const result: StressResult = await runStress({
      network: { ...STRESS_NETWORK },
      rollback: { ...this.session.config.rollback, maxPredictedFrames: 60 },
      frames: FRAMES,
      useAI: true,
      yieldEvery: 300,
      onProgress: done => { bar.style.width = `${(done / FRAMES) * 100}%`; },
    });

    const verdict = result.passed ? '✅ 通过：全程零分歧' : '❌ 失败：检测到分歧';
    out.textContent =
      `${verdict}\n` +
      `帧数 ${result.frames}（模拟时长 ${(result.elapsedSimMs / 1000).toFixed(1)}s）\n` +
      `分歧次数 ${result.divergences}\n` +
      `回滚次数 ${result.rollbacks} · 重算帧 ${result.resimulated} · 最大重算耗时 ${result.maxResimMs.toFixed(2)}ms\n` +
      `卡顿帧 ${result.stallFrames}`;
    out.style.borderColor = result.passed ? 'var(--good)' : 'var(--bad)';
    btn.disabled = false;
    btn.textContent = '重新运行 5 分钟极限压测';
    this.stressRunning = false;
  }
}
