import { useState } from 'react';
import { Hands, STRAINS, SEATS } from '../engine/cards.ts';
import { DDSPool, type FullDDResult } from '../state/ddsPool.ts';

interface Props {
  hands: Hands;
}

/** 按需计算并展示一副牌 5 定约 × 4 领出的 20 个双明手结果 (NS 墩数) */
export function DDResultTable(p: Props): JSX.Element {
  const [result, setResult] = useState<FullDDResult | null>(null);
  const [progress, setProgress] = useState<string>('');
  const [running, setRunning] = useState(false);
  const [pool] = useState(() => new DDSPool());

  const run = async (): Promise<void> => {
    setRunning(true);
    setResult(null);
    try {
      const r = await pool.solve(p.hands, (done, total) => setProgress(`${done}/${total} 定约完成`));
      setResult(r);
      setProgress(`完成, 耗时 ${r.elapsedMs} ms`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="card dd-table">
      <div className="card-head">
        <h2>双明手 20 墩结果 (NS 视角墩数)</h2>
        <button className="primary" onClick={run} disabled={running}>
          {running ? '计算中…' : '计算 20 个结果'}
        </button>
      </div>
      {progress && <p className="hint">{progress}</p>}
      {result && (
        <table className="grid">
          <thead>
            <tr>
              <th>定约 ＼ 领出</th>
              {SEATS.map((s) => (
                <th key={s}>{s}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {STRAINS.map((strain, i) => (
              <tr key={strain}>
                <td className="rank">{strain}</td>
                {result.tricks[i]!.map((v, leader) => (
                  <td key={leader}>{v}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
