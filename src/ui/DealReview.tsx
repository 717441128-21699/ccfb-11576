import { useEffect, useMemo, useRef, useState } from 'react';
import { Hands, Seat, Strain, Suit, STRAINS, SEATS, RANK_CHARS, SUITS, popcount, nextSeat, sideOf } from '../engine/cards.ts';
import type { Board } from '../engine/tournament.ts';
import type { PlayedCard } from '../engine/dds.ts';
import { ReviewClient, type AssessMove } from '../state/reviewClient.ts';
import { DDResultTable } from './DDResultTable.tsx';

interface Props {
  boardNumbers: number[];
  handsByBoard: Map<number, Hands>;
  boards: Board[];
}

interface LogEntry {
  seat: Seat;
  card: string;
  loss: number;
  best: boolean;
}

interface PlayState {
  hands: Hands;
  turn: Seat;
  currentTrick: PlayedCard[];
  nsBanked: number;
  ewBanked: number;
}

function trickWinner(cards: PlayedCard[], trump: Suit | null): Seat {
  let win = cards[0]!;
  for (let i = 1; i < cards.length; i++) {
    const c = cards[i]!;
    const beats = c.suit === win.suit ? c.rankIdx > win.rankIdx : trump !== null && c.suit === trump && win.suit !== trump;
    if (beats) win = c;
  }
  return win.seat;
}

export function DealReview(p: Props): JSX.Element {
  const [boardNumber, setBoardNumber] = useState<number>(p.boardNumbers[0] ?? 1);
  const [strain, setStrain] = useState<Strain>(4);
  const [state, setState] = useState<PlayState | null>(null);
  const [moves, setMoves] = useState<AssessMove[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const clientRef = useRef<ReviewClient | null>(null);

  const hands = p.handsByBoard.get(boardNumber);
  const trump = strain === 4 ? null : (strain as Suit);

  useEffect(() => {
    clientRef.current = new ReviewClient();
    return () => clientRef.current?.dispose();
  }, []);

  // 切换副号/定约时重置
  useEffect(() => {
    if (!hands) {
      setState(null);
      setMoves([]);
      return;
    }
    const fresh: PlayState = {
      hands: hands.map((h) => h.slice()),
      turn: 0,
      currentTrick: [],
      nsBanked: 0,
      ewBanked: 0,
    };
    setState(fresh);
    setLog([]);
    setMoves([]);
  }, [boardNumber, hands, strain]);

  // 状态变化后异步评估最佳着法
  useEffect(() => {
    if (!state || !clientRef.current) return;
    const remaining = state.hands.reduce((n, hh) => n + hh.reduce((m, x) => m + popcount(x), 0), 0);
    if (remaining === 0 && state.currentTrick.length === 0) {
      setMoves([]);
      return;
    }
    let cancelled = false;
    setBusy(true);
    clientRef.current
      .assess(state.hands, strain, state.currentTrick, state.turn, state.nsBanked, state.ewBanked)
      .then((res) => {
        if (!cancelled) setMoves(res);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [state, strain]);

  const bestSet = useMemo(() => new Set(moves.filter((m) => m.isBest).map((m) => `${m.suit}-${m.rankIdx}`)), [moves]);
  const lossMap = useMemo(() => new Map(moves.map((m) => [`${m.suit}-${m.rankIdx}`, m.loss])), [moves]);
  const finished = state !== null && state.hands.reduce((n, hh) => n + hh.reduce((m, x) => m + popcount(x), 0), 0) === 0;

  const handlePlay = (suit: Suit, rankIdx: number): void => {
    if (!state || busy) return;
    const chosen = moves.find((m) => m.suit === suit && m.rankIdx === rankIdx);
    const loss = chosen?.loss ?? 0;
    const isBest = chosen?.isBest ?? false;

    const newHands = state.hands.map((h) => h.slice());
    newHands[state.turn]![suit]! &= ~(1 << rankIdx);
    const newTrick = [...state.currentTrick, { seat: state.turn, suit, rankIdx }];
    let { nsBanked, ewBanked } = state;
    let turn: Seat = nextSeat(state.turn);
    if (newTrick.length === 4) {
      const winner = trickWinner(newTrick, trump);
      if (sideOf(winner) === 0) nsBanked++;
      else ewBanked++;
      setState({ hands: newHands, turn: winner, currentTrick: [], nsBanked, ewBanked });
    } else {
      setState({ hands: newHands, turn, currentTrick: newTrick, nsBanked, ewBanked });
    }
    setLog((l) => [...l, { seat: state.turn, card: SUITS[suit] + RANK_CHARS[rankIdx], loss, best: isBest }]);
  };

  const reset = (): void => {
    if (!hands) return;
    setState({ hands: hands.map((h) => h.slice()), turn: 0, currentTrick: [], nsBanked: 0, ewBanked: 0 });
    setLog([]);
  };

  if (p.boardNumbers.length === 0) {
    return <div className="empty">请先在「录入 / 导入」页载入带发牌的数据。</div>;
  }
  if (!hands || !state) {
    return <div className="empty">第 {boardNumber} 副没有发牌数据, 无法复盘。</div>;
  }

  return (
    <div className="review">
      <div className="card controls">
        <label>
          副号:
          <select value={boardNumber} onChange={(e) => setBoardNumber(Number(e.target.value))}>
            {p.boardNumbers.map((b) => (
              <option key={b} value={b}>
                第 {b} 副
              </option>
            ))}
          </select>
        </label>
        <label>
          定约:
          <select value={strain} onChange={(e) => setStrain(Number(e.target.value) as Strain)}>
            {STRAINS.map((s, i) => (
              <option key={s} value={i}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <button onClick={reset}>重新开始</button>
        {busy && <span className="busy">双明手计算中…</span>}
      </div>

      <div className="review-grid">
        <div className="card table-card">
          <div className="trick-count">
            NS 墩: <strong>{state.nsBanked}</strong> · EW 墩: <strong>{state.ewBanked}</strong>
            {finished && <span className="done"> · 本副结束</span>}
          </div>
          <div className="seats">
            {([0, 1, 2, 3] as Seat[]).map((seat) => (
              <SeatView
                key={seat}
                seat={seat}
                hands={state.hands[seat]!}
                isTurn={!finished && state.turn === seat}
                currentTrick={state.currentTrick}
                bestSet={bestSet}
                lossMap={lossMap}
                onPlay={handlePlay}
                interactive={!finished && state.turn === seat && !busy}
              />
            ))}
          </div>
        </div>

        <div className="card side-panel">
          <h3>最佳出法提示</h3>
          {finished ? (
            <p className="hint">本副已打满 13 墩。</p>
          ) : (
            <ul className="assess-list">
              {moves.map((a) => (
                <li key={`${a.suit}-${a.rankIdx}`} className={a.isBest ? 'best' : a.loss > 0 ? 'bad' : ''}>
                  <span className="card-name">{SUITS[a.suit]}{RANK_CHARS[a.rankIdx]}</span>
                  <span className="tricks">{a.sideTricks} 墩</span>
                  {a.isBest ? (
                    <span className="tag tag-best">最佳</span>
                  ) : (
                    <span className="tag tag-bad">丢 {a.loss} 墩</span>
                  )}
                </li>
              ))}
            </ul>
          )}

          <h3>出牌记录</h3>
          <ol className="play-log">
            {log.map((e, i) => (
              <li key={i} className={e.best ? 'ok' : 'mistake'}>
                {SEATS[e.seat]} {e.card} — {e.best ? '最佳' : `失误, 丢 ${e.loss} 墩`}
              </li>
            ))}
          </ol>
        </div>
      </div>

      <DDResultTable hands={hands} />
    </div>
  );
}

interface SeatViewProps {
  seat: Seat;
  hands: number[];
  isTurn: boolean;
  currentTrick: PlayedCard[];
  bestSet: Set<string>;
  lossMap: Map<string, number>;
  onPlay: (suit: Suit, rank: number) => void;
  interactive: boolean;
}

function SeatView(p: SeatViewProps): JSX.Element {
  const playedHere = p.currentTrick.find((c) => c.seat === p.seat);
  const cardCount = p.hands.reduce((n, m) => n + popcount(m), 0);
  return (
    <div className={`seat seat-${p.seat} ${p.isTurn ? 'turn' : ''}`}>
      <div className="seat-name">
        {SEATS[p.seat]} ({cardCount} 张) {p.isTurn ? '◀ 出牌' : ''}
      </div>
      <div className="suits">
        {([3, 2, 1, 0] as Suit[]).map((suit) => {
          const cards: number[] = [];
          let m = p.hands[suit]!;
          while (m) {
            const b = m & -m;
            m ^= b;
            cards.push(31 - Math.clz32(b));
          }
          cards.sort((a, b) => b - a);
          return (
            <div key={suit} className="suit-row">
              <span className="suit-symbol">{SUITS[suit]}</span>
              {cards.map((rankIdx) => {
                const key = `${suit}-${rankIdx}`;
                const isBest = p.bestSet.has(key);
                const loss = p.lossMap.get(key) ?? 0;
                return (
                  <button
                    key={rankIdx}
                    disabled={!p.interactive}
                    className={`playing-card ${isBest ? 'best' : ''} ${loss > 0 ? 'losing' : ''}`}
                    onClick={() => p.onPlay(suit, rankIdx)}
                    title={loss > 0 ? `非最佳, 丢 ${loss} 墩` : '最佳出法'}
                  >
                    {RANK_CHARS[rankIdx]}
                    {loss > 0 && <span className="loss-badge">-{loss}</span>}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      {playedHere && (
        <div className="played-now">{SUITS[playedHere.suit]}{RANK_CHARS[playedHere.rankIdx]}</div>
      )}
    </div>
  );
}
