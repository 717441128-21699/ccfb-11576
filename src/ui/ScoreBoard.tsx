import { useMemo } from 'react';
import type { Board, TableEntry, PairResult } from '../engine/tournament.ts';
import { scoreEntry } from '../engine/tournament.ts';

interface Props {
  results: PairResult[];
  entries: TableEntry[];
  boards: Board[];
  method: 'MP' | 'IMP';
  setMethod: (m: 'MP' | 'IMP') => void;
}

export function ScoreBoard(p: Props): JSX.Element {
  const scored = useMemo(
    () => p.entries.map((e) => scoreEntry(p.boards.find((b) => b.boardNumber === e.boardNumber)!, e)),
    [p.entries, p.boards],
  );

  if (p.entries.length === 0) {
    return <div className="empty">还没有成绩。请到「录入 / 导入」页导入数据或载入示例。</div>;
  }

  return (
    <div className="scoreboard">
      <div className="card">
        <div className="card-head">
          <h2>双人赛名次</h2>
          <div className="method-toggle">
            <label>
              <input type="radio" checked={p.method === 'MP'} onChange={() => p.setMethod('MP')} /> 比赛分 MP
            </label>
            <label>
              <input type="radio" checked={p.method === 'IMP'} onChange={() => p.setMethod('IMP')} /> 交叉 IMP
            </label>
          </div>
        </div>
        <table className="grid">
          <thead>
            <tr>
              <th>名次</th>
              <th>对号</th>
              <th>方向</th>
              <th>总分 {p.method === 'MP' ? '(比赛分)' : '(交叉 IMP)'}</th>
            </tr>
          </thead>
          <tbody>
            {p.results.map((r) => (
              <tr key={r.pairId}>
                <td className="rank">{r.rank}</td>
                <td>{r.pairId}</td>
                <td>{r.direction}</td>
                <td className="total">{r.total.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>逐桌得分明细</h2>
        <table className="grid">
          <thead>
            <tr>
              <th>副</th>
              <th>桌</th>
              <th>NS 对</th>
              <th>EW 对</th>
              <th>定约</th>
              <th>墩</th>
              <th>庄家方分</th>
              <th>NS 视角分</th>
            </tr>
          </thead>
          <tbody>
            {scored.map((s, i) => (
              <tr key={i}>
                <td>{s.boardNumber}</td>
                <td>{s.tableId}</td>
                <td>{s.nsPairId}</td>
                <td>{s.ewPairId}</td>
                <td>{formatContract(s.contract)}</td>
                <td>{s.contract ? s.tricks : '—'}</td>
                <td className={s.declarerScore > 0 ? 'pos' : s.declarerScore < 0 ? 'neg' : ''}>
                  {s.declarerScore}
                </td>
                <td className={s.nsViewScore > 0 ? 'pos' : s.nsViewScore < 0 ? 'neg' : ''}>{s.nsViewScore}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatContract(c: TableEntry['contract']): string {
  if (!c) return '全 pass';
  const strain = ['C', 'D', 'H', 'S', 'NT'][c.strain];
  const dbl = c.doubled === 1 ? '×' : c.doubled === 2 ? '××' : '';
  return `${c.level}${strain}${dbl} ${'NESW'[c.declarer]}`;
}
