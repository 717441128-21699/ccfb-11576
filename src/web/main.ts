import { parsePBNDeal, toPBNDeal, type Deal } from '../deal.js';
import {
  NT,
  SEAT_NAMES,
  SUIT_SYMBOLS,
  RANK_CHARS,
  type Trump,
  type Seat,
  cardName,
} from '../cards.js';
import {
  solveFullTable,
  tricksForDeclarer,
  type DoubleDummyTable,
} from '../dds/solver.js';
import { ReviewEngine, type MoveEvaluation } from '../review/review.js';
import type { WorkerResponse } from './protocol.js';

/**
 * 桥牌俱乐部工具的前端主控。零框架，原生 DOM 操作。
 * 三个标签页：双明手表、复式计分、逐墩复盘。
 */

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少元素 #${id}`);
  return el;
};

let currentDeal: Deal | null = null;
let currentTable: DoubleDummyTable | null = null;
let review: ReviewEngine | null = null;

const TRUMP_LABELS = ['♣ 草花', '♦ 方块', '♥ 红桃', '♠ 黑桃', 'NT 无将'];

function init(): void {
  $('loadSample').addEventListener('click', loadSample);
  $('parseDeal').addEventListener('click', handleParse);
  $('runDds').addEventListener('click', runDds);
  $('runDdsWorker').addEventListener('click', runDdsInWorker);
  $('reviewStart').addEventListener('click', startReview);
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab((tab as HTMLElement).dataset.tab!));
  });
  loadSample();
}

function switchTab(name: string): void {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', (t as HTMLElement).dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', (p as HTMLElement).id === `panel-${name}`));
}

const SAMPLE =
  'N:QJT9.KQJT9.543.2 AK876.54.AQJ.765 5432.A87.KT6.A83 7.632.9872.KQJT9';

function loadSample(): void {
  ($('pbnInput') as HTMLTextAreaElement).value = SAMPLE;
  handleParse();
}

function handleParse(): void {
  const text = ($('pbnInput') as HTMLTextAreaElement).value;
  const out = $('dealStatus');
  try {
    currentDeal = parsePBNDeal(text);
    out.textContent = `✓ 解析成功，52 张齐全`;
    out.className = 'status ok';
    renderHands(currentDeal);
  } catch (e) {
    currentDeal = null;
    out.textContent = `✗ ${(e as Error).message}`;
    out.className = 'status err';
  }
}

function renderHands(deal: Deal): void {
  const container = $('handsView');
  container.innerHTML = '';
  for (const seat of [0, 1, 2, 3] as Seat[]) {
    const box = document.createElement('div');
    box.className = 'hand-box';
    const title = document.createElement('div');
    title.className = 'hand-title';
    title.textContent = `${SEAT_NAMES[seat]} ${['北', '东', '南', '西'][seat]}`;
    box.appendChild(title);
    for (let suit = 3; suit >= 0; suit--) {
      const row = document.createElement('div');
      row.className = 'suit-row';
      const sym = document.createElement('span');
      sym.className = `suit-sym suit-${suit}`;
      sym.textContent = SUIT_SYMBOLS[suit]!;
      row.appendChild(sym);
      let mask = deal[seat]![suit]!;
      let ranks = '';
      for (let rank = 14; rank >= 2; rank--) {
        if (mask & (1 << (rank - 2))) ranks += RANK_CHARS[rank - 2];
      }
      row.appendChild(document.createTextNode(ranks || '—'));
      box.appendChild(row);
    }
    container.appendChild(box);
  }
}

async function runDds(): Promise<void> {
  if (!currentDeal) return;
  const status = $('ddsStatus');
  status.textContent = '计算中（主线程，界面可能短暂卡顿）…';
  await new Promise((r) => setTimeout(r, 10));
  const t0 = performance.now();
  // 分块让出事件循环由 Worker 版本负责；这里直接同步算
  const result = solveFullTable(currentDeal);
  currentTable = result.table;
  status.textContent = `✓ 完成，20 问用时 ${result.millis.toFixed(0)}ms，共 ${(result.totalNodes / 1e6).toFixed(2)}M 节点`;
  renderDdsTable(result.table);
}

function runDdsInWorker(): void {
  if (!currentDeal) return;
  const status = $('ddsStatus');
  status.textContent = 'Worker 计算中…';
  const worker = new Worker('./worker.js', { type: 'module' });
  worker.postMessage({ kind: 'solveFull', deal: currentDeal });
  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    const msg = ev.data;
    if (msg.kind === 'progress') {
      status.textContent = `计算中… ${msg.done}/${msg.total}`;
    } else if (msg.kind === 'done') {
      currentTable = msg.table;
      status.textContent = `✓ Worker 完成，用时 ${msg.millis.toFixed(0)}ms`;
      renderDdsTable(msg.table);
      worker.terminate();
    } else if (msg.kind === 'error') {
      status.textContent = `✗ ${msg.message}`;
      worker.terminate();
    }
  };
}

function renderDdsTable(table: DoubleDummyTable): void {
  const container = $('ddsTable');
  container.innerHTML = '';
  const headers = ['将牌', 'N 庄', 'E 庄', 'S 庄', 'W 庄'];
  const tableEl = document.createElement('table');
  const headRow = document.createElement('tr');
  for (const h of headers) {
    const th = document.createElement('th');
    th.textContent = h;
    headRow.appendChild(th);
  }
  tableEl.appendChild(headRow);

  for (let trump = 0; trump <= 4; trump++) {
    const tr = document.createElement('tr');
    const label = document.createElement('td');
    label.textContent = TRUMP_LABELS[trump]!;
    label.className = 'trump-label';
    tr.appendChild(label);
    for (const declarer of [0, 1, 2, 3] as Seat[]) {
      const td = document.createElement('td');
      td.textContent = String(tricksForDeclarer(table, trump as Trump, declarer));
      tr.appendChild(td);
    }
    tableEl.appendChild(tr);
  }
  container.appendChild(tableEl);
}

function startReview(): void {
  if (!currentDeal) return;
  const trump = Number(($('reviewTrump') as HTMLSelectElement).value) as Trump;
  const leader = Number(($('reviewLeader') as HTMLSelectElement).value) as Seat;
  review = new ReviewEngine(currentDeal, trump, leader);
  renderReview();
}

function renderReview(): void {
  if (!review) return;
  const st = review.state;
  $('reviewInfo').textContent =
    `第 ${st.trickIndex + 1} 墩 · 轮到 ${SEAT_NAMES[st.current]} · NS 已赢 ${st.nsTricks} 墩 · 余牌 ${st.cardsLeft}`;

  const evals = review.isDone ? [] : review.evaluateLegalMoves();
  const evalByCard = new Map<number, MoveEvaluation>();
  for (const e of evals) evalByCard.set(e.card, e);

  const container = $('reviewHands');
  container.innerHTML = '';
  for (const seat of [0, 1, 2, 3] as Seat[]) {
    const box = document.createElement('div');
    box.className = 'hand-box' + (seat === st.current ? ' current-turn' : '');
    const title = document.createElement('div');
    title.className = 'hand-title';
    title.textContent = SEAT_NAMES[seat];
    box.appendChild(title);
    for (let suit = 3; suit >= 0; suit--) {
      const row = document.createElement('div');
      row.className = 'suit-row';
      const sym = document.createElement('span');
      sym.className = `suit-sym suit-${suit}`;
      sym.textContent = SUIT_SYMBOLS[suit]!;
      row.appendChild(sym);
      let mask = st.hands[seat]![suit]!;
      for (let rank = 14; rank >= 2; rank--) {
        if (!(mask & (1 << (rank - 2)))) continue;
        const card = suit * 13 + (rank - 2);
        const btn = document.createElement('button');
        btn.className = 'card-btn';
        btn.textContent = RANK_CHARS[rank - 2]!;
        if (seat === st.current && !review.isDone) {
          const ev = evalByCard.get(card);
          if (ev) {
            if (ev.isBest) btn.classList.add('best');
            else btn.classList.add('bad');
            btn.title = ev.isBest
              ? `最佳出法（打出后 NS ${ev.nsTricksAfter} 墩）`
              : `丢 ${ev.tricksLost} 墩（最佳可拿 ${ev.nsTricksAfter + ev.tricksLost} 墩）`;
          }
          btn.addEventListener('click', () => {
            review!.play(card);
            renderReview();
          });
        } else {
          btn.disabled = true;
        }
        row.appendChild(btn);
      }
      box.appendChild(row);
    }
    container.appendChild(box);
  }

  // 已完成墩的流水
  const trickLog = $('trickLog');
  trickLog.innerHTML = st.completedTricks
    .map((t, i) => `${i + 1}. ` + t.map((c) => `${SEAT_NAMES[c.seat]}${cardName(c.card)}`).join(' '))
    .join('<br>');
}

void toPBNDeal;
void NT;

document.addEventListener('DOMContentLoaded', init);
